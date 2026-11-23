import { LoginLockoutMiddleware, loginLockout, lockoutKey } from "../../../src/middleware/authentication/LoginLockoutMiddleware";
import { CacheStore } from "../../../src/middleware/cache/CacheStore";
import { clusterRpc } from "../../../src/utils/cluster/ClusterRpcClient";
import { CLUSTER_RPC_METHODS as M, CLUSTER_RPC_LIMITS } from "../../../src/constants/clusterIpc";

const mk = (o = {}) =>
    new LoginLockoutMiddleware({
        maxAttempts: 2,
        lockoutMode: "fixed",
        lockoutDurationMs: 10_000,
        maxLockoutCycles: 2,
        retryDecrement: 1,
        store: new CacheStore("lockout-crypto", { ttl: 86400 }),
        ...o,
    });

describe("LoginLockout cluster chaos (primary unavailable)", () => {
    let call: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        vi.spyOn(clusterRpc, "active", "get").mockReturnValue(true);
        call = vi.spyOn(clusterRpc, "call");
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("asks the primary first and trusts its verdicts", async () => {
        const l = mk();
        call.mockResolvedValueOnce({ locked: true, retryAfter: 9 });
        await expect(l.checkAsync("alice")).resolves.toEqual({ locked: true, retryAfter: 9 });
        call.mockResolvedValueOnce({ locked: false, hrReset: true });
        await expect(l.checkAsync("alice")).resolves.toEqual({ locked: false, hrReset: true });
        call.mockResolvedValueOnce({ locked: false });
        await expect(l.checkAsync("alice")).resolves.toEqual({ locked: false });
        expect(call).toHaveBeenCalledWith("primary", M.LOCKOUT_CHECK, { key: "alice" }, expect.any(Object));
        call.mockResolvedValueOnce(undefined);
        await expect(l.checkAsync("alice")).resolves.toEqual({ locked: false });
    });

    it("falls back to per-worker counting on timeout, and the lock still engages locally", async () => {
        const l = mk();
        call.mockRejectedValue(Object.assign(new Error("rpc"), { code: "TIMEOUT" }));
        await l.recordFailureAsync("bob");
        await l.recordFailureAsync("bob");
        await expect(l.checkAsync("bob")).resolves.toMatchObject({ locked: true });
    });

    it("falls back when the primary declines (store full of locked entries)", async () => {
        const l = mk();
        call.mockResolvedValue({ fallback: true });
        await l.recordFailureAsync("carol");
        expect(l.check("carol")).toEqual({ locked: false });
        expect(l._readState("carol").failCount).toBe(1);
        await expect(l.checkAsync("carol")).resolves.toEqual({ locked: false });
    });

    it("never sends an unsafe key over IPC: an over-long or empty id is counted locally", async () => {
        const l = mk();
        const huge = "x".repeat(5000);
        await l.recordFailureAsync(huge);
        await l.checkAsync("");
        expect(call).not.toHaveBeenCalled();
        expect(l._readState(huge).failCount).toBe(1);
    });

    it("logs the fallback at most once per REJECT_LOG_GAP_MS", async () => {
        const l = mk();
        call.mockRejectedValue(new Error("down"));
        await l.checkAsync("d");
        const first = l._lastFallbackLog;
        await l.checkAsync("d");
        expect(l._lastFallbackLog).toBe(first);
        vi.advanceTimersByTime(CLUSTER_RPC_LIMITS.REJECT_LOG_GAP_MS + 1);
        await l.checkAsync("d");
        expect(l._lastFallbackLog).toBeGreaterThan(first);
    });

    it("records a remote failure for logging only, without mutating local state", async () => {
        const l = mk();
        call.mockResolvedValue({ failCount: 1, currentMax: 2, cycles: 0, engaged: true, ignored: false, lockDurationMs: 10_000 });
        await l.recordFailureAsync("eve");
        expect(l._readState("eve").failCount).toBe(0);
        call.mockResolvedValue({ ignored: true, failCount: 2, currentMax: 2, cycles: 1, engaged: false, lockDurationMs: null });
        await expect(l.recordFailureAsync("eve")).resolves.toBeUndefined();
    });

    it("recordSuccessAsync clears locally even when the primary is down", async () => {
        const l = mk();
        l.recordFailure("fay");
        l.recordFailure("fay");
        expect(l.check("fay").locked).toBe(true);
        call.mockRejectedValue(new Error("gone"));
        await expect(l.recordSuccessAsync("fay")).resolves.toBeUndefined();
        expect(l.check("fay")).toEqual({ locked: false });
        expect(call).toHaveBeenCalledWith("primary", M.LOCKOUT_CLEAR, { key: "fay" }, expect.any(Object));
    });
});

describe("LoginLockoutMiddleware (single process)", () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_700_000_000_000); });
    afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

    it("async variants use local state when not clustered", async () => {
        const l = mk();
        await l.recordFailureAsync("u");
        await l.recordFailureAsync("u");
        await expect(l.checkAsync("u")).resolves.toMatchObject({ locked: true });
        await l.recordSuccessAsync("u");
        await expect(l.checkAsync("u")).resolves.toEqual({ locked: false });
    });

    it("canonicalises ids so padded or numeric spellings share one counter (lockout bypass)", () => {
        const l = mk();
        l.recordFailure(" 007 ");
        l.recordFailure(7 as unknown as string);
        expect(lockoutKey(" 007 ")).toBe("7");
        expect(l.check("7").locked).toBe(true);
    });

    it("walks lock -> expiry -> relock -> permanent HR reset, never reopening a spent account", () => {
        const l = mk();
        l.recordFailure("z");
        l.recordFailure("z");
        expect(l.check("z")).toMatchObject({ locked: true, retryAfter: 10 });
        vi.advanceTimersByTime(10_001);
        expect(l.check("z")).toEqual({ locked: false });
        l.recordFailure("z"); // currentMax dropped to 1
        expect(l.check("z").locked).toBe(true);
        vi.advanceTimersByTime(20_001);
        expect(l.check("z")).toEqual({ locked: false, hrReset: true });
    });

    it("ignores failures that race in while already locked", () => {
        const l = mk();
        l.recordFailure("r");
        l.recordFailure("r");
        const state = l.recordFailure("r");
        expect(state).toMatchObject({ cycles: 1 });
        expect(l._readState("r").cycles).toBe(1);
    });

    it("builds a default store and policy from env when none are injected", () => {
        const l = new LoginLockoutMiddleware();
        expect(l._store).toBeInstanceOf(CacheStore);
        expect(l._maxAttempts).toBeGreaterThan(0);
        expect(loginLockout).toBeInstanceOf(LoginLockoutMiddleware);
    });
});
