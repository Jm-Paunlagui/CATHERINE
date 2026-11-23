import { SuspiciousIpTracker } from "../../../../src/middleware/security/SuspiciousIpTracker";

describe("SuspiciousIpTracker", () => {
    let t: SuspiciousIpTracker;
    beforeEach(() => {
        t = new SuspiciousIpTracker({ threshold: 3, blockMs: 1000 });
    });
    afterEach(() => {
        t.dispose();
        vi.useRealTimers();
    });

    it("exposes defaults", () => {
        expect(SuspiciousIpTracker.DEFAULT_THRESHOLD).toBe(10);
        expect(SuspiciousIpTracker.DEFAULT_BLOCK_MS).toBe(3_600_000);
        const d = new SuspiciousIpTracker();
        expect(d.strike("a", 0).blocked).toBe(false);
        d.dispose();
    });

    it("counts strikes and blocks exactly at the threshold", () => {
        expect(t.strike("1.1.1.1", 0)).toMatchObject({ blocked: false, justBlocked: false });
        t.strike("1.1.1.1", 1);
        const r = t.strike("1.1.1.1", 2);
        expect(r).toEqual({ blocked: true, blockedUntil: 1002, justBlocked: true });
        expect(t.isBlocked("1.1.1.1", 500)).toBe(true);
        expect(t.isBlocked("9.9.9.9", 500)).toBe(false);
    });

    it("an active block is a no-op that cannot be extended", () => {
        for (let i = 0; i < 3; i++) t.strike("a", i);
        const r = t.strike("a", 100);
        expect(r).toEqual({ blocked: true, blockedUntil: 1002, justBlocked: false });
    });

    it("a lapsed block resets the counter (no one-way ratchet)", () => {
        for (let i = 0; i < 3; i++) t.strike("a", i);
        const r = t.strike("a", 5000);
        expect(r).toMatchObject({ blocked: false, justBlocked: false });
        expect(t.records.get("a")?.count).toBe(1);
    });

    it("unblock reports whether a record existed", () => {
        t.strike("a", 0);
        expect(t.unblock("a")).toBe(true);
        expect(t.unblock("a")).toBe(false);
    });

    it("applyBlock mirrors a primary decision", () => {
        t.applyBlock("m", 9999, 0);
        expect(t.isBlocked("m", 10)).toBe(true);
        expect(t.records.get("m")?.count).toBe(3);
    });

    it("blocksSnapshot honours limit and skips lapsed blocks", () => {
        t.applyBlock("a", 100, 0);
        t.applyBlock("b", 100, 0);
        t.applyBlock("old", 5, 0);
        expect(t.blocksSnapshot(10, 0)).toEqual([]);
        expect(t.blocksSnapshot(10, 1)).toEqual([{ ip: "a", blockedUntil: 100 }]);
        expect(t.blocksSnapshot(10)).toHaveLength(2);
    });

    it("stats separates blocked, suspicious and zero-count records", () => {
        t.applyBlock("blk", 1000, 0);
        t.strike("sus", 0);
        t.records.set("zero", { count: 0, blockedUntil: 0, lastSeen: 0 });
        const s = t.stats(10) as { blocked: number; suspicious: number; totalTracked: number };
        expect(s).toMatchObject({ totalTracked: 3, blocked: 1, suspicious: 1 });
    });

    it("hourly cleanup removes only records idle for over 24h", () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const c = new SuspiciousIpTracker({ threshold: 3, blockMs: 1000 });
        c.records.set("stale", { count: 1, blockedUntil: 0, lastSeen: 0 });
        vi.setSystemTime(25 * 3600 * 1000);
        c.records.set("fresh", { count: 1, blockedUntil: 0, lastSeen: Date.now() });
        vi.advanceTimersByTime(3600 * 1000);
        expect(c.records.has("stale")).toBe(false);
        expect(c.records.has("fresh")).toBe(true);
        c.dispose();
    });

    it("tolerates a timer without unref", () => {
        const spy = vi.spyOn(globalThis, "setInterval").mockReturnValue({} as unknown as NodeJS.Timeout);
        const c = new SuspiciousIpTracker();
        expect(c).toBeDefined();
        spy.mockRestore();
    });
});
