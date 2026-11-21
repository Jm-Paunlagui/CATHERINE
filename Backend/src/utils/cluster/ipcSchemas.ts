"use strict";

/**
 * @fileoverview Pure validators for the cluster shared-state IPC protocol.
 * Everything that crosses the primary/worker boundary is checked here before
 * it is dispatched: shape, size and range (CWE-20), allow-listed names only via
 * `Set`/`Map` lookups, never property access (CWE-1321), bounded strings and
 * counts (CWE-400). No imports beyond constants.
 *
 * Every validator returns `{ ok: true, value }` or `{ ok: false, reason }`.
 * `reason` is a short fixed token, safe to log (CWE-209).
 *
 * Complexity: O(size of the checked value); no validator recurses into
 * caller-controlled depth beyond the documented shapes.
 *
 * @author senior-nodejs-engineer
 */

const {
    CLUSTER_IPC,
    CLUSTER_RPC_TARGETS,
    CLUSTER_RPC_METHODS,
    CLUSTER_TOPICS,
    CLUSTER_RPC_LIMITS: L,
} = require("../../constants/clusterIpc");
const { KNOWN_JOBS } = require("../../constants/schedulerJobs");
const { ACCESS_REVOCATION_LIMITS: AR, FAMILY_ID_RE } = require("../../constants/authTokens");

const METHOD_SET = new Set(Object.values(CLUSTER_RPC_METHODS));
const TARGET_SET = new Set(Object.values(CLUSTER_RPC_TARGETS));
const TOPIC_SET = new Set(Object.values(CLUSTER_TOPICS));
const JOB_SET = new Set(KNOWN_JOBS);
const IP_RE = /^[0-9A-Fa-f:.]+$/;
const FORBIDDEN_KEYS = ["__proto__", "constructor", "prototype"];

const ok = (value) => ({ ok: true, value });
const bad = (reason) => ({ ok: false, reason });

/**
 * @param {*} v
 * @returns {boolean} a plain JSON-style object (no exotic prototype, no poisoned own keys)
 */
function isPlainObject(v) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return false;
    for (const k of FORBIDDEN_KEYS) {
        if (Object.prototype.hasOwnProperty.call(v, k)) return false;
    }
    return true;
}

/**
 * @param {*} v
 * @param {number} max
 * @param {number} [min=0]
 * @returns {boolean} a string with min <= length <= max
 */
function isBoundedString(v, max, min = 0) {
    return typeof v === "string" && v.length >= min && v.length <= max;
}

/**
 * @param {*} v
 * @param {number} min
 * @param {number} max
 * @returns {boolean} a finite number within [min, max]
 */
function isFiniteInRange(v, min, max) {
    return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}

/**
 * @param {*} v
 * @param {number} min
 * @param {number} max
 * @returns {boolean} an integer within [min, max]
 */
function isIntInRange(v, min, max) {
    return isFiniteInRange(v, min, max) && Number.isInteger(v);
}

/**
 * @param {*} v
 * @returns {boolean} a textual IP (v4/v6 charset, <= 64 chars) or the literal "unknown"
 */
function isIp(v) {
    return typeof v === "string" && v.length >= 1 && v.length <= L.IP_MAX && (v === "unknown" || IP_RE.test(v));
}

/**
 * Validates a worker -> primary RPC request envelope.
 *
 * @param {*} msg
 * @returns {{ok: true, value: {id: string, target: string, method: string, args: object}}|{ok: false, reason: string}}
 */
function validateRequest(msg) {
    if (!isPlainObject(msg)) return bad("not-object");
    if (msg.cmd !== CLUSTER_IPC.RPC_REQUEST) return bad("bad-cmd");
    if (!isBoundedString(msg.id, L.MAX_ID_LENGTH, 1)) return bad("bad-id");
    if (typeof msg.target !== "string" || !TARGET_SET.has(msg.target)) return bad("bad-target");
    if (typeof msg.method !== "string" || !METHOD_SET.has(msg.method)) return bad("bad-method");
    const args = msg.args === undefined || msg.args === null ? {} : msg.args;
    if (!isPlainObject(args)) return bad("bad-args");
    return ok({ id: msg.id, target: msg.target, method: msg.method, args });
}

/**
 * Validates a worker -> primary notify envelope (no id, no reply).
 *
 * @param {*} msg
 * @returns {{ok: true, value: {method: string, args: object}}|{ok: false, reason: string}}
 */
function validateNotify(msg) {
    if (!isPlainObject(msg)) return bad("not-object");
    if (msg.cmd !== CLUSTER_IPC.NOTIFY) return bad("bad-cmd");
    if (typeof msg.method !== "string" || !METHOD_SET.has(msg.method)) return bad("bad-method");
    const args = msg.args === undefined || msg.args === null ? {} : msg.args;
    if (!isPlainObject(args)) return bad("bad-args");
    return ok({ method: msg.method, args });
}

/**
 * Shared arg check for lockout.*: `{ key }`, a 1..LOCKOUT_KEY_MAX string.
 *
 * @param {object} a
 * @returns {{ok: true, value: {key: string}}|{ok: false, reason: string}}
 */
function lockoutKeyArgs(a) {
    return isBoundedString(a.key, L.LOCKOUT_KEY_MAX, 1) ? ok({ key: a.key }) : bad("bad-key");
}

/**
 * Ended session families: `[{ fid, untilMs }]`, 1..max entries, `fid` a UUID,
 * `untilMs` in the future but at most MAX_TTL_MS ahead (CWE-20 / CWE-400).
 *
 * @param {*} list
 * @param {number} max
 * @param {number} now
 * @returns {{ok: true, value: {fid: string, untilMs: number}[]}|{ok: false, reason: string}}
 */
function revokedEntries(list, max, now) {
    if (!Array.isArray(list) || list.length === 0 || list.length > max) return bad("bad-entries");
    const out = [];
    for (const e of list) {
        if (!isPlainObject(e) || typeof e.fid !== "string" || !FAMILY_ID_RE.test(e.fid)) return bad("bad-fid");
        if (!isFiniteInRange(e.untilMs, now - 1000, now + AR.MAX_TTL_MS)) return bad("bad-until");
        out.push({ fid: e.fid, untilMs: e.untilMs });
    }
    return ok(out);
}

const ARG_VALIDATORS = new Map([
    [
        CLUSTER_RPC_METHODS.RL_HIT,
        (a) => {
            if (typeof a.label !== "string" || !L.RL_LABEL_RE.test(a.label)) return bad("bad-label");
            if (!isBoundedString(a.key, L.RL_KEY_MAX, 1)) return bad("bad-key");
            if (!isIntInRange(a.max, L.RL_MAX_MIN, L.RL_MAX_MAX)) return bad("bad-max");
            if (!isIntInRange(a.windowMs, L.RL_WINDOW_MIN_MS, L.RL_WINDOW_MAX_MS)) return bad("bad-window");
            return ok({ label: a.label, key: a.key, max: a.max, windowMs: a.windowMs });
        },
    ],
    [
        CLUSTER_RPC_METHODS.RL_CLEAR,
        (a) => {
            if (typeof a.label !== "string" || !L.RL_LABEL_RE.test(a.label)) return bad("bad-label");
            const key = a.key === undefined ? null : a.key;
            if (key !== null && !isBoundedString(key, L.RL_KEY_MAX, 1)) return bad("bad-key");
            return ok({ label: a.label, key });
        },
    ],
    [
        CLUSTER_RPC_METHODS.RL_REFUND,
        (a) => {
            if (typeof a.label !== "string" || !L.RL_LABEL_RE.test(a.label)) return bad("bad-label");
            if (!isBoundedString(a.key, L.RL_KEY_MAX, 1)) return bad("bad-key");
            if (!isIntInRange(a.windowMs, L.RL_WINDOW_MIN_MS, L.RL_WINDOW_MAX_MS)) return bad("bad-window");
            if (!isIntInRange(a.bucket, 0, Number.MAX_SAFE_INTEGER)) return bad("bad-bucket");
            return ok({ label: a.label, key: a.key, windowMs: a.windowMs, bucket: a.bucket });
        },
    ],
    [CLUSTER_RPC_METHODS.SF_STRIKE, (a) => (isIp(a.ip) ? ok({ ip: a.ip }) : bad("bad-ip"))],
    [
        CLUSTER_RPC_METHODS.SF_UNBLOCK,
        (a) => {
            if (!isIp(a.ip)) return bad("bad-ip");
            const actor = a.actor === undefined || a.actor === null ? null : a.actor;
            if (actor !== null && !isBoundedString(actor, L.ACTOR_MAX)) return bad("bad-actor");
            return ok({ ip: a.ip, actor });
        },
    ],
    [
        CLUSTER_RPC_METHODS.SCHED_RECORD,
        (a) => {
            if (typeof a.job !== "string" || !JOB_SET.has(a.job)) return bad("bad-job");
            const o = a.outcome;
            if (!isPlainObject(o)) return bad("bad-outcome");
            if (!isBoundedString(o.label, L.SCHED_STRING_MAX)) return bad("bad-label");
            if (!isBoundedString(o.status, L.SCHED_STRING_MAX)) return bad("bad-status");
            const detail = o.detail === undefined ? null : o.detail;
            if (detail !== null && !isBoundedString(detail, L.SCHED_DETAIL_MAX)) return bad("bad-detail");
            const atMs = typeof o.at === "string" || typeof o.at === "number" ? new Date(o.at).getTime() : NaN;
            if (!Number.isFinite(atMs)) return bad("bad-at");
            return ok({
                job: a.job,
                outcome: { label: o.label, status: o.status, detail, at: new Date(atMs).toISOString() },
            });
        },
    ],
    [CLUSTER_RPC_METHODS.LOCKOUT_CHECK, (a) => lockoutKeyArgs(a)],
    [CLUSTER_RPC_METHODS.LOCKOUT_FAIL, (a) => lockoutKeyArgs(a)],
    [CLUSTER_RPC_METHODS.LOCKOUT_CLEAR, (a) => lockoutKeyArgs(a)],
    [CLUSTER_RPC_METHODS.RECIPIENTS_INVALIDATE, () => ok({})],
    [
        CLUSTER_RPC_METHODS.AUTH_REVOKE,
        (a) => {
            const v = revokedEntries(a.entries, AR.MAX_FIDS_PER_MESSAGE, Date.now());
            return v.ok ? ok({ entries: v.value }) : v;
        },
    ],
    [CLUSTER_RPC_METHODS.METRICS_SNAPSHOT, () => ok({})],
    [
        CLUSTER_RPC_METHODS.ALERTS_ACK,
        (a) => {
            if (!isBoundedString(a.alertKey, L.ALERT_KEY_MAX, 1)) return bad("bad-alert-key");
            if (!isBoundedString(a.ackedBy, L.ACTOR_MAX, 1)) return bad("bad-acked-by");
            const note = a.note === undefined || a.note === null ? null : a.note;
            if (note !== null && !isBoundedString(note, L.NOTE_MAX)) return bad("bad-note");
            return ok({ alertKey: a.alertKey, ackedBy: a.ackedBy, note });
        },
    ],
    [
        CLUSTER_RPC_METHODS.ALERTS_UNACK,
        (a) => (isBoundedString(a.alertKey, L.ALERT_KEY_MAX, 1) ? ok({ alertKey: a.alertKey }) : bad("bad-alert-key")),
    ],
    [CLUSTER_RPC_METHODS.ALERTS_STATUS, () => ok({})],
    [CLUSTER_RPC_METHODS.ALERTS_ACKS, () => ok({})],
]);

/**
 * Validates and normalises the args of an allow-listed method.
 *
 * @param {string} method
 * @param {*} args
 * @returns {{ok: true, value: object}|{ok: false, reason: string}}
 */
function validateArgs(method, args) {
    const fn = ARG_VALIDATORS.get(method);
    if (!fn) return bad("bad-method");
    if (!isPlainObject(args)) return bad("bad-args");
    return fn(args);
}

const RESULT_VALIDATORS = new Map([
    [
        CLUSTER_RPC_METHODS.RL_HIT,
        (r) => {
            if (!isPlainObject(r)) return false;
            if (r.fallback === true) return true;
            return (
                typeof r.allowed === "boolean" &&
                isFiniteInRange(r.count, 0, Number.MAX_SAFE_INTEGER) &&
                isFiniteInRange(r.remaining, 0, Number.MAX_SAFE_INTEGER) &&
                isFiniteInRange(r.resetAt, 0, Number.MAX_SAFE_INTEGER) &&
                (r.bucket === undefined || isIntInRange(r.bucket, 0, Number.MAX_SAFE_INTEGER)) &&
                (r.retryAt === undefined || isFiniteInRange(r.retryAt, 0, Number.MAX_SAFE_INTEGER))
            );
        },
    ],
    [CLUSTER_RPC_METHODS.SF_UNBLOCK, (r) => isPlainObject(r) && typeof r.cleared === "boolean"],
    [
        CLUSTER_RPC_METHODS.LOCKOUT_CHECK,
        (r) => {
            if (!isPlainObject(r)) return false;
            if (r.fallback === true) return true;
            return (
                typeof r.locked === "boolean" &&
                (r.retryAfter === undefined || isFiniteInRange(r.retryAfter, 0, Number.MAX_SAFE_INTEGER)) &&
                (r.hrReset === undefined || typeof r.hrReset === "boolean")
            );
        },
    ],
    [
        CLUSTER_RPC_METHODS.LOCKOUT_FAIL,
        (r) => {
            if (!isPlainObject(r)) return false;
            if (r.fallback === true) return true;
            return (
                isFiniteInRange(r.failCount, 0, Number.MAX_SAFE_INTEGER) &&
                isFiniteInRange(r.currentMax, 0, Number.MAX_SAFE_INTEGER) &&
                isFiniteInRange(r.cycles, 0, Number.MAX_SAFE_INTEGER) &&
                typeof r.engaged === "boolean" &&
                typeof r.ignored === "boolean" &&
                (r.lockDurationMs === null || isFiniteInRange(r.lockDurationMs, 0, Number.MAX_SAFE_INTEGER))
            );
        },
    ],
    [CLUSTER_RPC_METHODS.LOCKOUT_CLEAR, (r) => r === null || r === undefined],
]);

/**
 * Validates a result before the caller trusts it. Methods without a dedicated
 * validator accept any JSON-style plain object, array, or null.
 *
 * @param {string} method
 * @param {*} result
 * @returns {boolean}
 */
function validateResult(method, result) {
    if (!METHOD_SET.has(method)) return false;
    const fn = RESULT_VALIDATORS.get(method);
    if (fn) return fn(result);
    return result === null || result === undefined || Array.isArray(result) || isPlainObject(result);
}

/**
 * Validates a primary -> worker broadcast.
 *
 * @param {string} topic
 * @param {*} payload
 * @param {number} [now=Date.now()]
 * @returns {{ok: true, value: object}|{ok: false, reason: string}}
 */
function validateTopic(topic, payload, now = Date.now()) {
    if (typeof topic !== "string" || !TOPIC_SET.has(topic)) return bad("bad-topic");
    if (!isPlainObject(payload)) return bad("bad-payload");
    switch (topic) {
        case CLUSTER_TOPICS.SF_BLOCK: {
            if (!isIp(payload.ip)) return bad("bad-ip");
            if (!isFiniteInRange(payload.blockedUntil, now - 1000, now + L.SF_BLOCK_MAX_AHEAD_MS)) {
                return bad("bad-blocked-until");
            }
            return ok({ ip: payload.ip, blockedUntil: payload.blockedUntil });
        }
        case CLUSTER_TOPICS.SF_UNBLOCKED:
            return isIp(payload.ip) ? ok({ ip: payload.ip }) : bad("bad-ip");
        case CLUSTER_TOPICS.SF_SYNC: {
            if (!Array.isArray(payload.blocks) || payload.blocks.length > L.SF_SYNC_MAX_ENTRIES) return bad("bad-blocks");
            const blocks = [];
            for (const b of payload.blocks) {
                if (!isPlainObject(b) || !isIp(b.ip)) return bad("bad-block");
                if (!isFiniteInRange(b.blockedUntil, now - 1000, now + L.SF_BLOCK_MAX_AHEAD_MS)) return bad("bad-block");
                blocks.push({ ip: b.ip, blockedUntil: b.blockedUntil });
            }
            return ok({ blocks });
        }
        case CLUSTER_TOPICS.SCHED_STATE: {
            const v = ARG_VALIDATORS.get(CLUSTER_RPC_METHODS.SCHED_RECORD)(payload);
            return v;
        }
        case CLUSTER_TOPICS.SCHED_SYNC: {
            if (!isPlainObject(payload.state)) return bad("bad-state");
            const entries = [];
            for (const job of KNOWN_JOBS) {
                const e = payload.state[job];
                if (e === null || e === undefined) continue;
                const v = ARG_VALIDATORS.get(CLUSTER_RPC_METHODS.SCHED_RECORD)({ job, outcome: e });
                if (!v.ok) return bad("bad-state-entry");
                entries.push(v.value);
            }
            return ok({ entries });
        }
        case CLUSTER_TOPICS.RECIPIENTS_INVALIDATE:
            return ok({});
        case CLUSTER_TOPICS.AUTH_REVOKED: {
            const v = revokedEntries(payload.entries, AR.MAX_FIDS_PER_MESSAGE, now);
            return v.ok ? ok({ entries: v.value }) : v;
        }
        case CLUSTER_TOPICS.AUTH_SYNC: {
            const v = revokedEntries(payload.entries, AR.MAX_SYNC_ENTRIES, now);
            return v.ok ? ok({ entries: v.value }) : v;
        }
        default:
            return bad("bad-topic");
    }
}

module.exports = {
    isPlainObject,
    isBoundedString,
    isFiniteInRange,
    isIntInRange,
    isIp,
    validateRequest,
    validateNotify,
    validateArgs,
    validateResult,
    validateTopic,
};
