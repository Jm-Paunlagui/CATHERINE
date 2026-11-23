import { CLUSTER_RPC_METHODS as M, CLUSTER_TOPICS as TOPIC, CLUSTER_RPC_LIMITS as L } from "../../../src/constants/clusterIpc";
import { KNOWN_JOBS } from "../../../src/constants/schedulerJobs";
import { validateArgs, validateResult, validateTopic } from "../../../src/utils/cluster/ipcSchemas";

const FID = "123e4567-e89b-12d3-a456-426614174000";
const NOW = 1_700_000_000_000;
const reason = (r: { ok: boolean; reason?: string }) => (r.ok ? "ok" : r.reason);
const job = KNOWN_JOBS[0];
const goodOutcome = { label: "L", status: "OK", detail: "d", at: NOW };

describe("ipcSchemas wave2: argument validators refuse hostile shapes", () => {
    it.each([
        ["bad-label", M.RL_HIT, { label: "bad label!", key: "k", max: 5, windowMs: 1000 }],
        ["bad-label", M.RL_HIT, { label: 7, key: "k", max: 5, windowMs: 1000 }],
        ["bad-key", M.RL_HIT, { label: "a", key: "", max: 5, windowMs: 1000 }],
        ["bad-max", M.RL_HIT, { label: "a", key: "k", max: 0, windowMs: 1000 }],
        ["bad-max", M.RL_HIT, { label: "a", key: "k", max: 1.5, windowMs: 1000 }],
        ["bad-window", M.RL_HIT, { label: "a", key: "k", max: 5, windowMs: 10 }],
        ["bad-label", M.RL_CLEAR, { label: "no spaces", key: "k" }],
        ["bad-key", M.RL_CLEAR, { label: "a", key: "x".repeat(L.RL_KEY_MAX + 1) }],
        ["bad-key", M.RL_CLEAR, { label: "a", key: 5 }],
        ["bad-label", M.RL_REFUND, { label: "", key: "k", windowMs: 1000, bucket: 0 }],
        ["bad-key", M.RL_REFUND, { label: "a", key: "", windowMs: 1000, bucket: 0 }],
        ["bad-window", M.RL_REFUND, { label: "a", key: "k", windowMs: 999, bucket: 0 }],
        ["bad-bucket", M.RL_REFUND, { label: "a", key: "k", windowMs: 1000, bucket: -1 }],
        ["bad-bucket", M.RL_REFUND, { label: "a", key: "k", windowMs: 1000, bucket: "1" }],
        ["bad-ip", M.SF_STRIKE, { ip: "10.0.0.1; rm -rf" }],
        ["bad-ip", M.SF_UNBLOCK, { ip: 5 }],
        ["bad-actor", M.SF_UNBLOCK, { ip: "1.2.3.4", actor: "a".repeat(L.ACTOR_MAX + 1) }],
        ["bad-actor", M.SF_UNBLOCK, { ip: "1.2.3.4", actor: 12 }],
        ["bad-job", M.SCHED_RECORD, { job: "not-a-job", outcome: goodOutcome }],
        ["bad-job", M.SCHED_RECORD, { job: 3, outcome: goodOutcome }],
        ["bad-outcome", M.SCHED_RECORD, { job, outcome: "x" }],
        ["bad-label", M.SCHED_RECORD, { job, outcome: { ...goodOutcome, label: "x".repeat(L.SCHED_STRING_MAX + 1) } }],
        ["bad-status", M.SCHED_RECORD, { job, outcome: { ...goodOutcome, status: 1 } }],
        ["bad-detail", M.SCHED_RECORD, { job, outcome: { ...goodOutcome, detail: "x".repeat(L.SCHED_DETAIL_MAX + 1) } }],
        ["bad-at", M.SCHED_RECORD, { job, outcome: { ...goodOutcome, at: "not a date" } }],
        ["bad-at", M.SCHED_RECORD, { job, outcome: { ...goodOutcome, at: { x: 1 } } }],
        ["bad-key", M.LOCKOUT_CHECK, { key: "" }],
        ["bad-key", M.LOCKOUT_FAIL, { key: "k".repeat(L.LOCKOUT_KEY_MAX + 1) }],
        ["bad-key", M.LOCKOUT_CLEAR, {}],
        ["bad-entries", M.AUTH_REVOKE, { entries: [] }],
        ["bad-entries", M.AUTH_REVOKE, { entries: "nope" }],
        ["bad-fid", M.AUTH_REVOKE, { entries: [{ fid: "not-a-uuid", untilMs: Date.now() + 60_000 }] }],
        ["bad-until", M.AUTH_REVOKE, { entries: [{ fid: FID, untilMs: 1 }] }],
        ["bad-alert-key", M.ALERTS_ACK, { alertKey: "", ackedBy: "a" }],
        ["bad-acked-by", M.ALERTS_ACK, { alertKey: "k", ackedBy: "" }],
        ["bad-note", M.ALERTS_ACK, { alertKey: "k", ackedBy: "a", note: "n".repeat(L.NOTE_MAX + 1) }],
        ["bad-alert-key", M.ALERTS_UNACK, { alertKey: 9 }],
    ])("refuses as %s: %s %j", (expected, method, args) => {
        expect(reason(validateArgs(method, args))).toBe(expected);
    });

    it("normalises optional fields to null and the date to ISO", () => {
        expect(validateArgs(M.RL_CLEAR, { label: "a" })).toEqual({ ok: true, value: { label: "a", key: null } });
        expect(validateArgs(M.SF_UNBLOCK, { ip: "unknown", actor: null })).toEqual({ ok: true, value: { ip: "unknown", actor: null } });
        expect(validateArgs(M.ALERTS_ACK, { alertKey: "k", ackedBy: "a" })).toEqual({ ok: true, value: { alertKey: "k", ackedBy: "a", note: null } });
        const rec = validateArgs(M.SCHED_RECORD, { job, outcome: { label: "L", status: "S", at: "2026-01-02T03:04:05.000Z" } });
        expect(rec).toEqual({ ok: true, value: { job, outcome: { label: "L", status: "S", detail: null, at: "2026-01-02T03:04:05.000Z" } } });
    });

    it("accepts argument-free methods with an empty object", () => {
        for (const m of [M.RECIPIENTS_INVALIDATE, M.METRICS_SNAPSHOT, M.ALERTS_STATUS, M.ALERTS_ACKS]) {
            expect(validateArgs(m, {})).toEqual({ ok: true, value: {} });
        }
    });
});

describe("ipcSchemas wave2: result validators never trust malformed replies", () => {
    it("rl.hit result", () => {
        expect(validateResult(M.RL_HIT, "x")).toBe(false);
        expect(validateResult(M.RL_HIT, { fallback: true })).toBe(true);
        const good = { allowed: true, count: 1, remaining: 4, resetAt: 5 };
        expect(validateResult(M.RL_HIT, good)).toBe(true);
        expect(validateResult(M.RL_HIT, { ...good, bucket: 2, retryAt: 9 })).toBe(true);
        expect(validateResult(M.RL_HIT, { ...good, bucket: 1.5 })).toBe(false);
        expect(validateResult(M.RL_HIT, { ...good, retryAt: -1 })).toBe(false);
        expect(validateResult(M.RL_HIT, { ...good, allowed: "yes" })).toBe(false);
    });

    it("sf.unblock result", () => {
        expect(validateResult(M.SF_UNBLOCK, { cleared: false })).toBe(true);
        expect(validateResult(M.SF_UNBLOCK, { cleared: 1 })).toBe(false);
        expect(validateResult(M.SF_UNBLOCK, null)).toBe(false);
    });

    it("lockout.check result", () => {
        expect(validateResult(M.LOCKOUT_CHECK, [])).toBe(false);
        expect(validateResult(M.LOCKOUT_CHECK, { fallback: true })).toBe(true);
        expect(validateResult(M.LOCKOUT_CHECK, { locked: true, retryAfter: 3, hrReset: false })).toBe(true);
        expect(validateResult(M.LOCKOUT_CHECK, { locked: false })).toBe(true);
        expect(validateResult(M.LOCKOUT_CHECK, { locked: true, retryAfter: -3 })).toBe(false);
        expect(validateResult(M.LOCKOUT_CHECK, { locked: true, hrReset: "no" })).toBe(false);
    });

    it("lockout.fail result", () => {
        const good = { failCount: 1, currentMax: 5, cycles: 0, engaged: false, ignored: false, lockDurationMs: null };
        expect(validateResult(M.LOCKOUT_FAIL, 3)).toBe(false);
        expect(validateResult(M.LOCKOUT_FAIL, { fallback: true })).toBe(true);
        expect(validateResult(M.LOCKOUT_FAIL, good)).toBe(true);
        expect(validateResult(M.LOCKOUT_FAIL, { ...good, lockDurationMs: 1000 })).toBe(true);
        expect(validateResult(M.LOCKOUT_FAIL, { ...good, lockDurationMs: "1" })).toBe(false);
        expect(validateResult(M.LOCKOUT_FAIL, { ...good, engaged: 0 })).toBe(false);
    });

    it("lockout.clear and generic results", () => {
        expect(validateResult(M.LOCKOUT_CLEAR, null)).toBe(true);
        expect(validateResult(M.LOCKOUT_CLEAR, undefined)).toBe(true);
        expect(validateResult(M.LOCKOUT_CLEAR, {})).toBe(false);
        expect(validateResult(M.METRICS_SNAPSHOT, [1])).toBe(true);
        expect(validateResult(M.METRICS_SNAPSHOT, "str")).toBe(false);
        expect(validateResult("unknown.method", {})).toBe(false);
    });
});

describe("ipcSchemas wave2: broadcast topics", () => {
    const fut = NOW + 60_000;
    it.each([
        ["bad-topic", 5, {}],
        ["bad-topic", "nope", {}],
        ["bad-payload", TOPIC.SF_BLOCK, []],
        ["bad-ip", TOPIC.SF_BLOCK, { ip: "!!", blockedUntil: fut }],
        ["bad-blocked-until", TOPIC.SF_BLOCK, { ip: "1.1.1.1", blockedUntil: NOW + L.SF_BLOCK_MAX_AHEAD_MS + 1 }],
        ["bad-ip", TOPIC.SF_UNBLOCKED, { ip: "" }],
        ["bad-blocks", TOPIC.SF_SYNC, { blocks: "x" }],
        ["bad-blocks", TOPIC.SF_SYNC, { blocks: new Array(L.SF_SYNC_MAX_ENTRIES + 1).fill(0) }],
        ["bad-block", TOPIC.SF_SYNC, { blocks: [5] }],
        ["bad-block", TOPIC.SF_SYNC, { blocks: [{ ip: "1.1.1.1", blockedUntil: 0 }] }],
        ["bad-state", TOPIC.SCHED_SYNC, { state: [] }],
        ["bad-state-entry", TOPIC.SCHED_SYNC, { state: { [job]: { label: 1 } } }],
        ["bad-entries", TOPIC.AUTH_REVOKED, { entries: [] }],
        ["bad-entries", TOPIC.AUTH_SYNC, { entries: null }],
        ["bad-job", TOPIC.SCHED_STATE, { job: "zzz", outcome: goodOutcome }],
    ])("refuses as %s: %j / %j", (expected, topic, payload) => {
        expect(reason(validateTopic(topic as string, payload, NOW))).toBe(expected);
    });

    it("accepts valid broadcasts and skips empty scheduler entries", () => {
        expect(validateTopic(TOPIC.SF_BLOCK, { ip: "1.1.1.1", blockedUntil: fut }, NOW).ok).toBe(true);
        expect(validateTopic(TOPIC.SF_UNBLOCKED, { ip: "1.1.1.1" }, NOW)).toEqual({ ok: true, value: { ip: "1.1.1.1" } });
        expect(validateTopic(TOPIC.SF_SYNC, { blocks: [{ ip: "1.1.1.1", blockedUntil: fut }] }, NOW)).toEqual({
            ok: true,
            value: { blocks: [{ ip: "1.1.1.1", blockedUntil: fut }] },
        });
        expect(validateTopic(TOPIC.RECIPIENTS_INVALIDATE, {}, NOW)).toEqual({ ok: true, value: {} });
        const sync = validateTopic(TOPIC.SCHED_SYNC, { state: { [job]: goodOutcome, [KNOWN_JOBS[1]]: null } }, NOW);
        expect(sync.ok && (sync.value.entries as unknown[]).length).toBe(1);
        expect(validateTopic(TOPIC.AUTH_REVOKED, { entries: [{ fid: FID, untilMs: NOW + 1000 }] }, NOW).ok).toBe(true);
        expect(validateTopic(TOPIC.AUTH_SYNC, { entries: [{ fid: FID, untilMs: NOW + 1000 }] }, NOW).ok).toBe(true);
    });

    it("defaults `now` to the real clock", () => {
        const r = validateTopic(TOPIC.SF_BLOCK, { ip: "1.1.1.1", blockedUntil: Date.now() + 5000 });
        expect(r.ok).toBe(true);
    });
});
