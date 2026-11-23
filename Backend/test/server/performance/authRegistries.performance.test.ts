"use strict";

/**
 * @fileoverview Performance (space): the auth registries stay bounded under
 * flood (CWE-400). Deterministic: counts, not wall-clock.
 */

import { RefreshTokenRegistry } from "../../../src/utils/auth/RefreshTokenRegistry";
import { RevokedSessionSet } from "../../../src/utils/auth/RevokedSessionSet";

describe("auth registries stay bounded", () => {
    it("RefreshTokenRegistry never exceeds maxEntries however many tokens are issued", () => {
        let now = 0;
        const r = new RefreshTokenRegistry({ maxEntries: 500, now: () => now });
        for (let i = 0; i < 5000; i++) {
            now += 1;
            r.register({ jtiHash: `j${i}`, familyId: `f${i}`, userKey: `u${i % 50}`, expiresAtMs: now + 1_000_000 });
            expect(r.size).toBeLessThanOrEqual(500);
        }
        expect(r.size).toBe(500);
    });

    it("the oldest tokens are the ones evicted (recent sessions keep working)", () => {
        const r = new RefreshTokenRegistry({ maxEntries: 10, now: () => 0 });
        for (let i = 0; i < 20; i++) r.register({ jtiHash: `j${i}`, familyId: `f${i}`, userKey: "u", expiresAtMs: 1_000_000 });
        expect(r.consume("j0", null, 0)).toBe("unknown");
        expect(r.consume("j19", null, 0)).toBe("ok");
    });

    it("RevokedSessionSet never exceeds maxEntries and keeps the longest-lived revocations", () => {
        const now = 10;
        const s = new RevokedSessionSet({ maxEntries: 100, now: () => now });
        for (let i = 0; i < 1000; i++) {
            s.revoke(`f${i}`, now + 1000 + i);
            expect(s.size).toBeLessThanOrEqual(100);
        }
        expect(s.has("f999", now)).toBe(true);
        expect(s.has("f0", now)).toBe(false);
        expect(s.snapshot(now).length).toBe(100);
    });

    it("sweeps expired entries in one pass instead of evicting live ones", () => {
        let now = 0;
        const s = new RevokedSessionSet({ maxEntries: 50, now: () => now });
        for (let i = 0; i < 50; i++) s.revoke(`old${i}`, 10);
        now = 5000;
        s.revoke("fresh", now + 10_000);
        expect(s.size).toBe(1);
    });
});
