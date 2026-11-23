import { CLUSTER_IPC, CLUSTER_RPC_METHODS as M, CLUSTER_RPC_TARGETS as T, CLUSTER_TOPICS as TOPIC, CLUSTER_RPC_LIMITS as L } from "../../../src/constants/clusterIpc";
import { validateRequest, validateNotify, validateArgs, validateResult, validateTopic, isPlainObject, isIp, isIntInRange } from "../../../src/utils/cluster/ipcSchemas";

const FID = "123e4567-e89b-12d3-a456-426614174000";
const req = (over: Record<string, unknown> = {}) => ({ cmd: CLUSTER_IPC.RPC_REQUEST, id: "1-1", target: T.PRIMARY, method: M.RL_HIT, args: {}, ...over });
const reason = (r: any) => (r.ok ? "ok" : r.reason);

describe("ipcSchemas: request / notify envelopes", () => {
    it.each([null, undefined, 5, "str", [], [1]])("rejects non-object envelope %j", (v) => {
        expect(reason(validateRequest(v))).toBe("not-object");
        expect(reason(validateNotify(v))).toBe("not-object");
    });

    it("accepts a well-formed request and defaults args to {}", () => {
        const r = validateRequest(req({ args: undefined }));
        expect(r).toEqual({ ok: true, value: { id: "1-1", target: "primary", method: M.RL_HIT, args: {} } });
    });

    it.each([
        ["bad-cmd", { cmd: "evil" }],
        ["bad-id", { id: "" }],
        ["bad-id", { id: "x".repeat(L.MAX_ID_LENGTH + 1) }],
        ["bad-id", { id: 42 }],
        ["bad-target", { target: "root" }],
        ["bad-target", { target: 1 }],
        ["bad-method", { method: "fs.rm" }],
        ["bad-method", { method: "toString" }],
        ["bad-args", { args: "nope" }],
        ["bad-args", { args: [1] }],
    ])("request refused as %s for %j", (expected, over) => {
        expect(reason(validateRequest(req(over)))).toBe(expected);
    });

    it("accepts an id exactly at the maximum length", () => {
        expect(validateRequest(req({ id: "x".repeat(L.MAX_ID_LENGTH) })).ok).toBe(true);
    });

    it("refuses poisoned prototype keys (CWE-1321)", () => {
        const poisoned = JSON.parse('{"cmd":"app:rpc-req","id":"1","target":"primary","method":"rl.hit","__proto__":{"x":1}}');
        expect(reason(validateRequest(poisoned))).toBe("not-object");
        expect(reason(validateRequest(req({ args: JSON.parse('{"constructor":1}') })))).toBe("bad-args");
        expect(reason(validateRequest(req({ args: JSON.parse('{"prototype":1}') })))).toBe("bad-args");
    });

    it("refuses class instances and null-proto-less exotic objects", () => {
        class Evil {}
        expect(isPlainObject(new Evil())).toBe(false);
        expect(isPlainObject(Object.create(null))).toBe(true);
        expect(reason(validateRequest(req({ args: new Map() })))).toBe("bad-args");
    });

    it("notify: refuses wrong cmd, bad method and bad args", () => {
        expect(reason(validateNotify({ cmd: CLUSTER_IPC.RPC_REQUEST, method: M.RL_CLEAR }))).toBe("bad-cmd");
        expect(reason(validateNotify({ cmd: CLUSTER_IPC.NOTIFY, method: "nope" }))).toBe("bad-method");
        expect(reason(validateNotify({ cmd: CLUSTER_IPC.NOTIFY, method: M.RL_CLEAR, args: 3 }))).toBe("bad-args");
        expect(validateNotify({ cmd: CLUSTER_IPC.NOTIFY, method: M.RL_CLEAR, args: null }).ok).toBe(true);
    });
});

describe("ipcSchemas: validateArgs", () => {
    const hit = { label: "login", key: "1.2.3.4", max: 5, windowMs: 60000 };

    it("refuses an unknown method and non-object args", () => {
        expect(reason(validateArgs("nope", {}))).toBe("bad-method");
        expect(reason(validateArgs(M.RL_HIT, null))).toBe("bad-args");
        expect(reason(validateArgs(M.RL_HIT, []))).toBe("bad-args");
    });

    it("rl.hit accepts a valid payload and strips extra fields", () => {
        expect(validateArgs(M.RL_HIT, { ...hit, extra: "x" })).toEqual({ ok: true, value: hit });
    });

    it.each([
        ["bad-label", { label: "has space" }],
        ["bad-label", { label: 7 }],
        ["bad-label", { label: "a".repeat(65) }],
        ["bad-key", { key: "" }],
        ["bad-key", { key: "k".repeat(L.RL_KEY_MAX + 1) }],
        ["bad-key", { key: { $ne: 1 } }],
        ["bad-max", { max: 0 }],
        ["bad-max", { max: L.RL_MAX_MAX + 1 }],
        ["bad-max", { max: 1.5 }],
        ["bad-max", { max: "5" }],
        ["bad-max", { max: NaN }],
        ["bad-max", { max: Infinity }],
        ["bad-window", { windowMs: 999 }],
        ["bad-window", { windowMs: L.RL_WINDOW_MAX_MS + 1 }],
    ])("rl.hit refused as %s for %j", (expected, over) => {
        expect(reason(validateArgs(M.RL_HIT, { ...hit, ...over }))).toBe(expected);
    });

    it("rl.refund requires a non-negative integer bucket", () => {
        const base = { label: "x", key: "k", windowMs: 1000 };
        expect(validateArgs(M.RL_REFUND, { ...base, bucket: 0 }).ok).toBe(true);
        expect(reason(validateArgs(M.RL_REFUND, { ...base, bucket: -1 }))).toBe("bad-bucket");
        expect(reason(validateArgs(M.RL_REFUND, { ...base, bucket: 1.2 }))).toBe("bad-bucket");
    });

    it("rl.clear allows an omitted key but refuses an empty one", () => {
        expect(validateArgs(M.RL_CLEAR, { label: "x" })).toEqual({ ok: true, value: { label: "x", key: null } });
        expect(reason(validateArgs(M.RL_CLEAR, { label: "x", key: "" }))).toBe("bad-key");
    });

    it.each(["1.2.3.4", "::1", "fe80::1", "unknown"])("accepts ip %s", (ip) => {
        expect(isIp(ip)).toBe(true);
    });
    it.each(["", "1.2.3.4; DROP", "a".repeat(65), 12, null, "<script>", "1.2.3.4 "])("refuses ip %j", (ip) => {
        expect(isIp(ip)).toBe(false);
        expect(reason(validateArgs(M.SF_STRIKE, { ip }))).toBe("bad-ip");
    });

    it("sf.unblock bounds the actor", () => {
        expect(validateArgs(M.SF_UNBLOCK, { ip: "1.1.1.1" })).toEqual({ ok: true, value: { ip: "1.1.1.1", actor: null } });
        expect(reason(validateArgs(M.SF_UNBLOCK, { ip: "1.1.1.1", actor: "a".repeat(L.ACTOR_MAX + 1) }))).toBe("bad-actor");
        expect(reason(validateArgs(M.SF_UNBLOCK, { ip: "1.1.1.1", actor: 5 }))).toBe("bad-actor");
    });

    it.each([M.LOCKOUT_CHECK, M.LOCKOUT_FAIL, M.LOCKOUT_CLEAR])("%s bounds the key", (m) => {
        expect(validateArgs(m, { key: "user" }).ok).toBe(true);
        expect(reason(validateArgs(m, { key: "" }))).toBe("bad-key");
        expect(reason(validateArgs(m, { key: "k".repeat(L.LOCKOUT_KEY_MAX + 1) }))).toBe("bad-key");
        expect(reason(validateArgs(m, { key: ["a"] }))).toBe("bad-key");
    });

    it("sched.record refuses unknown jobs, oversize and bad timestamps", () => {
        const good = { job: "dbBackup", outcome: { label: "l", status: "ok", at: "2026-01-01T00:00:00Z" } };
        expect(validateArgs(M.SCHED_RECORD, good).ok).toBe(true);
        expect(reason(validateArgs(M.SCHED_RECORD, { ...good, job: "__proto__" }))).toBe("bad-job");
        expect(reason(validateArgs(M.SCHED_RECORD, { ...good, outcome: "x" }))).toBe("bad-outcome");
        expect(reason(validateArgs(M.SCHED_RECORD, { ...good, outcome: { ...good.outcome, label: "x".repeat(L.SCHED_STRING_MAX + 1) } }))).toBe("bad-label");
        expect(reason(validateArgs(M.SCHED_RECORD, { ...good, outcome: { ...good.outcome, status: 1 } }))).toBe("bad-status");
        expect(reason(validateArgs(M.SCHED_RECORD, { ...good, outcome: { ...good.outcome, detail: "d".repeat(L.SCHED_DETAIL_MAX + 1) } }))).toBe("bad-detail");
        expect(reason(validateArgs(M.SCHED_RECORD, { ...good, outcome: { ...good.outcome, at: "garbage" } }))).toBe("bad-at");
        expect(reason(validateArgs(M.SCHED_RECORD, { ...good, outcome: { ...good.outcome, at: {} } }))).toBe("bad-at");
    });

    it("alerts.ack bounds key, actor and note", () => {
        const good = { alertKey: "k", ackedBy: "me" };
        expect(validateArgs(M.ALERTS_ACK, good)).toEqual({ ok: true, value: { ...good, note: null } });
        expect(reason(validateArgs(M.ALERTS_ACK, { ...good, alertKey: "" }))).toBe("bad-alert-key");
        expect(reason(validateArgs(M.ALERTS_ACK, { ...good, ackedBy: "" }))).toBe("bad-acked-by");
        expect(reason(validateArgs(M.ALERTS_ACK, { ...good, note: "n".repeat(L.NOTE_MAX + 1) }))).toBe("bad-note");
        expect(reason(validateArgs(M.ALERTS_UNACK, { alertKey: "k".repeat(L.ALERT_KEY_MAX + 1) }))).toBe("bad-alert-key");
    });

    it("auth.revoke rejects empty, oversized, non-uuid and out-of-range entries", () => {
        const until = Date.now() + 60_000;
        expect(validateArgs(M.AUTH_REVOKE, { entries: [{ fid: FID, untilMs: until }] }).ok).toBe(true);
        expect(reason(validateArgs(M.AUTH_REVOKE, { entries: [] }))).toBe("bad-entries");
        expect(reason(validateArgs(M.AUTH_REVOKE, { entries: "x" }))).toBe("bad-entries");
        expect(reason(validateArgs(M.AUTH_REVOKE, { entries: Array.from({ length: 1001 }, () => ({ fid: FID, untilMs: until })) }))).toBe("bad-entries");
        expect(reason(validateArgs(M.AUTH_REVOKE, { entries: [{ fid: "not-a-uuid", untilMs: until }] }))).toBe("bad-fid");
        expect(reason(validateArgs(M.AUTH_REVOKE, { entries: [{ fid: FID, untilMs: Date.now() - 60_000 }] }))).toBe("bad-until");
        expect(reason(validateArgs(M.AUTH_REVOKE, { entries: [{ fid: FID, untilMs: Date.now() + 400 * 86_400_000 }] }))).toBe("bad-until");
        expect(reason(validateArgs(M.AUTH_REVOKE, { entries: [{ fid: FID, untilMs: "soon" }] }))).toBe("bad-until");
    });

    it("argument-less methods accept an empty object", () => {
        for (const m of [M.RECIPIENTS_INVALIDATE, M.METRICS_SNAPSHOT, M.ALERTS_STATUS, M.ALERTS_ACKS]) {
            expect(validateArgs(m, {})).toEqual({ ok: true, value: {} });
        }
    });

    it("isIntInRange sanity", () => {
        expect(isIntInRange(3, 1, 5)).toBe(true);
        expect(isIntInRange("3", 1, 5)).toBe(false);
        expect(isIntInRange(6, 1, 5)).toBe(false);
    });
});

describe("ipcSchemas: validateResult", () => {
    it("refuses unknown methods", () => {
        expect(validateResult("nope", {})).toBe(false);
    });

    it("rl.hit result must be well typed unless it is a fallback", () => {
        expect(validateResult(M.RL_HIT, { fallback: true })).toBe(true);
        expect(validateResult(M.RL_HIT, { allowed: true, count: 1, remaining: 4, resetAt: 10 })).toBe(true);
        expect(validateResult(M.RL_HIT, { allowed: "yes", count: 1, remaining: 4, resetAt: 10 })).toBe(false);
        expect(validateResult(M.RL_HIT, { allowed: true, count: -1, remaining: 4, resetAt: 10 })).toBe(false);
        expect(validateResult(M.RL_HIT, { allowed: true, count: 1, remaining: 4, resetAt: 10, bucket: 1.5 })).toBe(false);
        expect(validateResult(M.RL_HIT, "str")).toBe(false);
        expect(validateResult(M.RL_HIT, null)).toBe(false);
    });

    it("lockout results are type checked", () => {
        expect(validateResult(M.LOCKOUT_CHECK, { locked: false })).toBe(true);
        expect(validateResult(M.LOCKOUT_CHECK, { locked: 1 })).toBe(false);
        expect(validateResult(M.LOCKOUT_CHECK, { locked: true, retryAfter: -1 })).toBe(false);
        expect(validateResult(M.LOCKOUT_FAIL, { failCount: 1, currentMax: 5, cycles: 0, engaged: false, ignored: false, lockDurationMs: null })).toBe(true);
        expect(validateResult(M.LOCKOUT_FAIL, { failCount: 1, currentMax: 5, cycles: 0, engaged: false, ignored: false })).toBe(false);
        expect(validateResult(M.LOCKOUT_CLEAR, null)).toBe(true);
        expect(validateResult(M.LOCKOUT_CLEAR, {})).toBe(false);
        expect(validateResult(M.SF_UNBLOCK, { cleared: "y" })).toBe(false);
    });

    it("methods without a dedicated validator accept only null/array/plain object", () => {
        expect(validateResult(M.ALERTS_STATUS, null)).toBe(true);
        expect(validateResult(M.ALERTS_STATUS, [1])).toBe(true);
        expect(validateResult(M.ALERTS_STATUS, { a: 1 })).toBe(true);
        expect(validateResult(M.ALERTS_STATUS, "str")).toBe(false);
        expect(validateResult(M.ALERTS_STATUS, 5)).toBe(false);
        expect(validateResult(M.ALERTS_STATUS, JSON.parse('{"__proto__":{}}'))).toBe(false);
    });
});

describe("ipcSchemas: validateTopic", () => {
    const now = 1_000_000_000_000;

    it("refuses unknown topic and non-object payload", () => {
        expect(reason(validateTopic("evil", {}, now))).toBe("bad-topic");
        expect(reason(validateTopic(5 as any, {}, now))).toBe("bad-topic");
        expect(reason(validateTopic(TOPIC.SF_BLOCK, null, now))).toBe("bad-payload");
        expect(reason(validateTopic(TOPIC.SF_BLOCK, [], now))).toBe("bad-payload");
    });

    it("sf.block bounds ip and blockedUntil", () => {
        expect(validateTopic(TOPIC.SF_BLOCK, { ip: "1.1.1.1", blockedUntil: now + 1000 }, now).ok).toBe(true);
        expect(reason(validateTopic(TOPIC.SF_BLOCK, { ip: "bad ip", blockedUntil: now + 1000 }, now))).toBe("bad-ip");
        expect(reason(validateTopic(TOPIC.SF_BLOCK, { ip: "1.1.1.1", blockedUntil: now + L.SF_BLOCK_MAX_AHEAD_MS + 1 }, now))).toBe("bad-blocked-until");
        expect(reason(validateTopic(TOPIC.SF_BLOCK, { ip: "1.1.1.1", blockedUntil: now - 5000 }, now))).toBe("bad-blocked-until");
        expect(reason(validateTopic(TOPIC.SF_BLOCK, { ip: "1.1.1.1", blockedUntil: "x" }, now))).toBe("bad-blocked-until");
    });

    it("sf.sync caps entries and validates each", () => {
        const b = { ip: "1.1.1.1", blockedUntil: now + 1000 };
        expect(validateTopic(TOPIC.SF_SYNC, { blocks: [b] }, now).ok).toBe(true);
        expect(reason(validateTopic(TOPIC.SF_SYNC, { blocks: "x" }, now))).toBe("bad-blocks");
        expect(reason(validateTopic(TOPIC.SF_SYNC, { blocks: new Array(L.SF_SYNC_MAX_ENTRIES + 1).fill(b) }, now))).toBe("bad-blocks");
        expect(reason(validateTopic(TOPIC.SF_SYNC, { blocks: [{ ip: "x y", blockedUntil: now }] }, now))).toBe("bad-block");
        expect(reason(validateTopic(TOPIC.SF_SYNC, { blocks: [null] }, now))).toBe("bad-block");
    });

    it("sf.unblocked, sched.state, sched.sync", () => {
        expect(reason(validateTopic(TOPIC.SF_UNBLOCKED, { ip: 1 }, now))).toBe("bad-ip");
        expect(reason(validateTopic(TOPIC.SCHED_STATE, { job: "nope", outcome: {} }, now))).toBe("bad-job");
        expect(reason(validateTopic(TOPIC.SCHED_SYNC, { state: "x" }, now))).toBe("bad-state");
        expect(reason(validateTopic(TOPIC.SCHED_SYNC, { state: { dbBackup: { label: 1 } } }, now))).toBe("bad-state-entry");
        expect(validateTopic(TOPIC.SCHED_SYNC, { state: {} }, now)).toEqual({ ok: true, value: { entries: [] } });
    });

    it("auth.revoked / auth.sync enforce their entry caps", () => {
        const e = { fid: FID, untilMs: now + 1000 };
        expect(validateTopic(TOPIC.AUTH_REVOKED, { entries: [e] }, now).ok).toBe(true);
        expect(reason(validateTopic(TOPIC.AUTH_REVOKED, { entries: new Array(1001).fill(e) }, now))).toBe("bad-entries");
        expect(validateTopic(TOPIC.AUTH_SYNC, { entries: new Array(1001).fill(e) }, now).ok).toBe(true);
        expect(reason(validateTopic(TOPIC.AUTH_SYNC, { entries: new Array(50_001).fill(e) }, now))).toBe("bad-entries");
        expect(reason(validateTopic(TOPIC.AUTH_SYNC, { entries: [{ fid: "x", untilMs: now }] }, now))).toBe("bad-fid");
    });

    it("recipients.invalidate accepts an empty payload", () => {
        expect(validateTopic(TOPIC.RECIPIENTS_INVALIDATE, {}, now)).toEqual({ ok: true, value: {} });
    });
});
