import { LoginLockoutState } from "../../../../src/middleware/authentication/LoginLockoutState";
import { LoginLockoutPolicy } from "../../../../src/middleware/authentication/LoginLockoutPolicy";

const policy = new LoginLockoutPolicy({
    maxAttempts: 2,
    lockoutMode: "fixed",
    lockoutDurationMs: 10_000,
    lockoutMultiplier: 2,
    maxLockoutCycles: 2,
    retryDecrement: 1,
});
const DAY = 24 * 60 * 60 * 1000;

describe("LoginLockoutState (primary-side store)", () => {
    it("reports unknown keys as unlocked and counts failures", () => {
        const s = new LoginLockoutState({ policy });
        expect(s.check("u", 0)).toEqual({ locked: false });
        const r = s.fail("u", 0);
        expect(r).toMatchObject({ failCount: 1, currentMax: 2, engaged: false, ignored: false });
        expect(s.size).toBe(1);
    });

    it("engages a lock at the threshold and refuses further failures as ignored", () => {
        const s = new LoginLockoutState({ policy });
        s.fail("u", 0);
        const r = s.fail("u", 1);
        expect(r).toMatchObject({ engaged: true, lockDurationMs: 10_000 });
        expect(s.check("u", 2)).toMatchObject({ locked: true, retryAfter: 10 });
        const again = s.fail("u", 3) as { ignored: boolean };
        expect(again.ignored).toBe(true);
    });

    it("clears an expired lock window on check and persists it", () => {
        const s = new LoginLockoutState({ policy });
        s.fail("u", 0);
        s.fail("u", 0);
        expect(s.check("u", 10_001)).toEqual({ locked: false });
        // currentMax decremented to 1 after first cycle: one failure re-locks
        expect(s.fail("u", 10_002)).toMatchObject({ engaged: true, cycles: 2 });
    });

    it("flags hrReset once max cycles are exhausted", () => {
        const s = new LoginLockoutState({ policy });
        s.fail("u", 0);
        s.fail("u", 0);
        s.fail("u", 20_000);
        expect(s.check("u", 40_000)).toEqual({ locked: false, hrReset: true });
    });

    it("clear() gives a clean slate", () => {
        const s = new LoginLockoutState({ policy });
        s.fail("u", 0);
        s.clear("u");
        expect(s.size).toBe(0);
        expect(s.check("u", 1)).toEqual({ locked: false });
    });

    it("drops entries 24h after their last write", () => {
        const s = new LoginLockoutState({ policy });
        s.fail("u", 0);
        expect(s.check("u", DAY)).toEqual({ locked: false });
        expect(s.size).toBe(0);
    });

    it("defaults to env policy and 100000 keys when no options are given", () => {
        const s = new LoginLockoutState();
        expect(s.fail("x", 0)).toMatchObject({ ignored: false });
    });

    describe("bounded store (CWE-400)", () => {
        it("evicts expired entries first when a new key hits the cap", () => {
            const s = new LoginLockoutState({ policy, maxKeys: 2 });
            s.fail("a", 0);
            s.fail("b", DAY - 5);
            const r = s.fail("c", DAY + 1);
            expect(r).toMatchObject({ ignored: false });
            expect(s.size).toBe(2);
        });

        it("evicts the oldest unlocked entry when nothing is expired", () => {
            const s = new LoginLockoutState({ policy, maxKeys: 2 });
            s.fail("a", 0);
            s.fail("b", 1);
            s.fail("c", 2);
            expect(s.size).toBe(2);
            expect(s.check("a", 3)).toEqual({ locked: false });
            expect(s.fail("b", 4)).toMatchObject({ failCount: 2 });
        });

        it("never evicts locked entries; answers fallback and rate-limits the rescan", () => {
            const s = new LoginLockoutState({ policy, maxKeys: 2 });
            for (const k of ["a", "b"]) {
                s.fail(k, 0);
                s.fail(k, 0);
            }
            expect(s.fail("c", 10)).toEqual({ fallback: true });
            // within SWEEP_MIN_GAP_MS the scan is skipped
            expect(s.fail("d", 500)).toEqual({ fallback: true });
            expect(s.size).toBe(2);
            expect(s.check("a", 11).locked).toBe(true);
        });

        it("does not evict hr-reset entries either", () => {
            const hr = new LoginLockoutPolicy({ maxAttempts: 1, lockoutMode: "fixed", lockoutDurationMs: 1, maxLockoutCycles: 1 });
            const s = new LoginLockoutState({ policy: hr, maxKeys: 1 });
            s.fail("a", 0);
            expect(s.fail("b", 100)).toEqual({ fallback: true });
        });
    });
});
