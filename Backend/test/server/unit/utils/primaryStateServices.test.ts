import { PrimaryStateServices } from "../../../../src/utils/cluster/PrimaryStateServices";
import { CLUSTER_RPC_METHODS as M, CLUSTER_TOPICS as T, CLUSTER_RPC_LIMITS } from "../../../../src/constants/clusterIpc";
import { LoginLockoutPolicy } from "../../../../src/middleware/authentication/LoginLockoutPolicy";

/** Captures what PrimaryStateServices registers on the hub. */
function fakeHub() {
    const handlers = new Map<string, (args: any, ctx: any) => any>();
    const listening: Array<(w: any) => void> = [];
    return {
        handlers, listening,
        register: (m: string, fn: any) => { handlers.set(m, fn); },
        addListeningHook: (fn: any) => { listening.push(fn); },
        broadcast: vi.fn(),
        sendTo: vi.fn(),
    };
}

const FID = "123e4567-e89b-42d3-a456-426614174000";

function setup() {
    const hub = fakeHub();
    const logger = { notice: vi.fn(), error: vi.fn() };
    const clock = { t: 1_000_000 };
    const svc = new PrimaryStateServices({ logger, now: () => clock.t, lockoutPolicy: new LoginLockoutPolicy() });
    svc.attach(hub as any);
    const run = (m: string, args: any = {}, workerId = 1) => hub.handlers.get(m)!(args, { worker: { id: workerId } });
    return { hub, logger, clock, svc, run };
}

describe("PrimaryStateServices", () => {
    it("registers every shared-state method", () => {
        const { hub } = setup();
        for (const m of [M.RL_HIT, M.RL_REFUND, M.RL_CLEAR, M.LOCKOUT_CHECK, M.LOCKOUT_FAIL, M.LOCKOUT_CLEAR, M.SF_STRIKE, M.SF_UNBLOCK, M.SCHED_RECORD, M.RECIPIENTS_INVALIDATE, M.AUTH_REVOKE]) {
            expect(hub.handlers.has(m)).toBe(true);
        }
    });

    describe("rate limiter", () => {
        const hit = { label: "login", key: "ip1", max: 2, windowMs: 60_000 };

        it("counts per label+window and blocks past the max, cluster-wide", () => {
            const { run } = setup();
            expect(run(M.RL_HIT, hit, 1).allowed).toBe(true);
            expect(run(M.RL_HIT, hit, 2).allowed).toBe(true);
            const third = run(M.RL_HIT, hit, 3);
            expect(third.allowed).toBe(false);
            expect(third.remaining).toBe(0);
        });

        it("a different window is a separate counter", () => {
            const { run } = setup();
            run(M.RL_HIT, hit);
            run(M.RL_HIT, hit);
            expect(run(M.RL_HIT, { ...hit, windowMs: 120_000 }).allowed).toBe(true);
        });

        it("falls back to the worker once the counter table is full", () => {
            const { run } = setup();
            for (let i = 0; i < CLUSTER_RPC_LIMITS.MAX_RL_COUNTERS; i++) run(M.RL_HIT, { ...hit, label: `l${i}` });
            expect(run(M.RL_HIT, { ...hit, label: "overflow" })).toEqual({ fallback: true });
            // an existing counter still works
            expect(run(M.RL_HIT, { ...hit, label: "l0", key: "other" }).allowed).toBe(true);
        });

        it("falls back when the key store is full (counter throws)", () => {
            const { run, svc } = setup();
            run(M.RL_HIT, hit);
            const counter = svc._counters.get("login|60000")!;
            vi.spyOn(counter, "hit").mockImplementation(() => { throw new Error("key cap"); });
            expect(run(M.RL_HIT, hit)).toEqual({ fallback: true });
        });

        it("refund gives back a hit; refunding an unknown counter is a no-op returning null", () => {
            const { run } = setup();
            const first = run(M.RL_HIT, { ...hit, max: 1 });
            expect(run(M.RL_HIT, { ...hit, max: 1 }).allowed).toBe(false);
            expect(run(M.RL_REFUND, { label: "login", key: "ip1", windowMs: 60_000, bucket: first.bucket })).toBeNull();
            expect(run(M.RL_REFUND, { label: "ghost", key: "k", windowMs: 60_000, bucket: 0 })).toBeNull();
        });

        it("clear with a key is routed to every window counter of that label only", () => {
            const { run, svc } = setup();
            run(M.RL_HIT, hit);
            run(M.RL_HIT, { ...hit, windowMs: 120_000 });
            run(M.RL_HIT, { ...hit, label: "other" });
            const spies = new Map([...svc._counters].map(([id, c]) => [id, vi.spyOn(c, "del")]));
            run(M.RL_CLEAR, { label: "login", key: "ip1" });
            expect(spies.get("login|60000")).toHaveBeenCalledWith("ip1");
            expect(spies.get("login|120000")).toHaveBeenCalledWith("ip1");
            expect(spies.get("other|60000")).not.toHaveBeenCalled();
        });

        it("clear with null flushes every window of the label and leaves other labels alone", () => {
            const { run } = setup();
            const one = { ...hit, max: 1 };
            run(M.RL_HIT, one);
            run(M.RL_HIT, { ...one, windowMs: 120_000 });
            run(M.RL_HIT, { ...one, label: "other" });
            run(M.RL_CLEAR, { label: "login", key: null });
            expect(run(M.RL_HIT, one).allowed).toBe(true);
            expect(run(M.RL_HIT, { ...one, windowMs: 120_000 }).allowed).toBe(true);
            expect(run(M.RL_HIT, { ...one, label: "other" }).allowed).toBe(false);
        });
    });

    describe("login lockout", () => {
        it("failures counted across workers lock the user, clear unlocks", () => {
            const { run } = setup();
            expect(run(M.LOCKOUT_CHECK, { key: "alice" })).toMatchObject({ locked: false });
            let engaged = false;
            for (let i = 0; i < 50 && !engaged; i++) engaged = run(M.LOCKOUT_FAIL, { key: "alice" }, (i % 3) + 1).engaged;
            expect(engaged).toBe(true);
            expect(run(M.LOCKOUT_CHECK, { key: "alice" }).locked).toBe(true);
            expect(run(M.LOCKOUT_CLEAR, { key: "alice" })).toBeNull();
            expect(run(M.LOCKOUT_CHECK, { key: "alice" }).locked).toBe(false);
        });

        it("check and fail fall back to the worker when the state throws", () => {
            const { run, svc } = setup();
            vi.spyOn(svc._lockout, "check").mockImplementation(() => { throw new Error("x"); });
            vi.spyOn(svc._lockout, "fail").mockImplementation(() => { throw new Error("x"); });
            expect(run(M.LOCKOUT_CHECK, { key: "a" })).toEqual({ fallback: true });
            expect(run(M.LOCKOUT_FAIL, { key: "a" })).toEqual({ fallback: true });
        });

        it("a full store logs one throttled error and answers fallback", () => {
            const { run, svc, logger, clock } = setup();
            vi.spyOn(svc._lockout, "fail").mockReturnValue({ fallback: true });
            expect(run(M.LOCKOUT_FAIL, { key: "a" })).toEqual({ fallback: true });
            run(M.LOCKOUT_FAIL, { key: "b" });
            expect(logger.error).toHaveBeenCalledTimes(1);
            clock.t += CLUSTER_RPC_LIMITS.REJECT_LOG_GAP_MS;
            run(M.LOCKOUT_FAIL, { key: "c" });
            expect(logger.error).toHaveBeenCalledTimes(2);
        });
    });

    describe("security filter", () => {
        it("a strike that blocks broadcasts the block; earlier strikes do not", () => {
            const { run, hub } = setup();
            let blocked = false;
            for (let i = 0; i < 200 && !blocked; i++) {
                run(M.SF_STRIKE, { ip: "6.6.6.6" });
                blocked = hub.broadcast.mock.calls.length > 0;
            }
            expect(blocked).toBe(true);
            expect(hub.broadcast).toHaveBeenCalledTimes(1);
            const [topic, payload] = hub.broadcast.mock.calls[0];
            expect(topic).toBe(T.SF_BLOCK);
            expect(payload.ip).toBe("6.6.6.6");
        });

        it("unblock reports cleared, logs with the actor (or system) and broadcasts", () => {
            const { run, hub, logger } = setup();
            for (let i = 0; i < 200; i++) run(M.SF_STRIKE, { ip: "7.7.7.7" });
            expect(run(M.SF_UNBLOCK, { ip: "7.7.7.7", actor: "admin" })).toEqual({ cleared: true });
            expect(String(logger.notice.mock.calls[0][0])).toContain("admin");
            expect(hub.broadcast).toHaveBeenLastCalledWith(T.SF_UNBLOCKED, { ip: "7.7.7.7" });
            expect(run(M.SF_UNBLOCK, { ip: "7.7.7.7", actor: null })).toEqual({ cleared: false });
            expect(logger.notice).toHaveBeenCalledTimes(1);
        });

        it("a system unblock is attributed to 'system'", () => {
            const { run, logger } = setup();
            for (let i = 0; i < 200; i++) run(M.SF_STRIKE, { ip: "8.8.8.8" });
            run(M.SF_UNBLOCK, { ip: "8.8.8.8", actor: null });
            expect(String(logger.notice.mock.calls[0][0])).toContain("system");
        });

        it("a worker that starts listening gets the current blocks, none when there are none", () => {
            const { run, hub } = setup();
            const worker = { id: 9 };
            hub.listening[0](worker); // security filter hook registered first after scheduler
            for (const fn of hub.listening) fn(worker);
            expect(hub.sendTo).not.toHaveBeenCalled();
            for (let i = 0; i < 200; i++) run(M.SF_STRIKE, { ip: "5.5.5.5" });
            for (const fn of hub.listening) fn(worker);
            expect(hub.sendTo).toHaveBeenCalledWith(worker, T.SF_SYNC, { blocks: [expect.objectContaining({ ip: "5.5.5.5" })] });
        });
    });

    describe("scheduler snapshot", () => {
        const outcome = { label: "L", status: "ok", detail: null, at: "2026-01-01T00:00:00.000Z" };

        it("records and broadcasts to every other worker, and replays to a late listener", () => {
            const { run, hub } = setup();
            expect(run(M.SCHED_RECORD, { job: "dbBackup", outcome }, 2)).toBeNull();
            expect(hub.broadcast).toHaveBeenCalledWith(T.SCHED_STATE, { job: "dbBackup", outcome }, { exceptId: 2 });
            const w = { id: 3 };
            for (const fn of hub.listening) fn(w);
            expect(hub.sendTo).toHaveBeenCalledWith(w, T.SCHED_SYNC, { state: { dbBackup: outcome } });
        });

        it("nothing recorded means nothing replayed", () => {
            const { hub } = setup();
            for (const fn of hub.listening) fn({ id: 1 });
            expect(hub.sendTo).not.toHaveBeenCalledWith(expect.anything(), T.SCHED_SYNC, expect.anything());
        });
    });

    describe("recipients and access revocation", () => {
        it("recipient invalidation fans out to every other worker", () => {
            const { run, hub } = setup();
            expect(run(M.RECIPIENTS_INVALIDATE, {}, 4)).toBeNull();
            expect(hub.broadcast).toHaveBeenCalledWith(T.RECIPIENTS_INVALIDATE, {}, { exceptId: 4 });
        });

        it("revocations are kept, fanned out except the sender, and replayed to a late worker", () => {
            const { run, hub, clock } = setup();
            const entries = [{ fid: FID, untilMs: clock.t + 60_000 }];
            expect(run(M.AUTH_REVOKE, { entries }, 2)).toBeNull();
            expect(hub.broadcast).toHaveBeenCalledWith(T.AUTH_REVOKED, { entries }, { exceptId: 2 });
            const w = { id: 5 };
            for (const fn of hub.listening) fn(w);
            expect(hub.sendTo).toHaveBeenCalledWith(w, T.AUTH_SYNC, { entries });
        });

        it("expired revocations are not replayed", () => {
            const { run, hub, clock } = setup();
            run(M.AUTH_REVOKE, { entries: [{ fid: FID, untilMs: clock.t + 1000 }] });
            clock.t += 10_000;
            for (const fn of hub.listening) fn({ id: 5 });
            expect(hub.sendTo).not.toHaveBeenCalledWith(expect.anything(), T.AUTH_SYNC, expect.anything());
        });
    });
});
