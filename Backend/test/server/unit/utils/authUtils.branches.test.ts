"use strict";

/**
 * @fileoverview Pure auth utilities: RefreshTokenRegistry, RevokedSessionSet,
 * refreshFamilyOf, canonicalUserKey, requireAuthUser, tokenClaims. Clocks are injected.
 */

import jwt from "jsonwebtoken";
import type { Request } from "express";
import { RefreshTokenRegistry } from "../../../../src/utils/auth/RefreshTokenRegistry";
import { RevokedSessionSet } from "../../../../src/utils/auth/RevokedSessionSet";
import { refreshFamilyOf } from "../../../../src/utils/auth/refreshFamily";
import { canonicalUserKey } from "../../../../src/utils/auth/userKey";
import { requireAuthUser } from "../../../../src/utils/auth/requireAuthUser";
import { classifyAccessClaims, credentialEpoch, parseDuration, accessTokenTtl } from "../../../../src/utils/auth/tokenClaims";
import { TOKEN_TYPES, TOKEN_ISSUER, TOKEN_AUDIENCES } from "../../../../src/constants/authTokens";

const FID = "0123456789abcdef0123456789abcdef0123";

describe("RefreshTokenRegistry", () => {
    let now: number;
    const mk = (maxEntries = 100) => new RefreshTokenRegistry({ maxEntries, now: () => now });
    const reg = (r: RefreshTokenRegistry, jtiHash: string, familyId = "f1", userKey = "u1", expiresAtMs = now + 10_000) =>
        r.register({ jtiHash, familyId, userKey, expiresAtMs });

    beforeEach(() => {
        now = 1_000_000;
    });

    it("rotates once; replaying the same token is 'reused' and kills the whole family", () => {
        const r = mk();
        reg(r, "a");
        reg(r, "b");
        expect(r.consume("a", "a2", now)).toBe("ok");
        expect(r.consume("a", "a3", now)).toBe("reused");
        expect(r.consume("b", null, now)).toBe("revoked");
    });

    it("reuse of an already-expired token falls back to the default marker ttl", () => {
        const r = mk();
        reg(r, "a", "f1", "u1", now - 5);
        r.consume("a", null, now);
        expect(r.consume("a", null, now)).toBe("reused");
        expect(r.consume("zzz", null, now, "f1")).toBe("revoked");
    });

    it("an unknown token is 'unknown', unless its verified family was revoked here (even when never registered)", () => {
        const r = mk();
        expect(r.consume("x", null, now)).toBe("unknown");
        expect(r.consume("x", null, now, "ghost")).toBe("unknown");
        r.revokeFamily("ghost", now);
        expect(r.consume("x", null, now, "ghost")).toBe("revoked");
    });

    it("unconsume only undoes THIS caller's consume", () => {
        const r = mk();
        reg(r, "a");
        expect(r.unconsume("missing", null)).toBe(false);
        expect(r.unconsume("a", null)).toBe(false); // not used yet
        r.consume("a", "next", now);
        expect(r.unconsume("a", "someone-else")).toBe(false);
        expect(r.unconsume("a", "next")).toBe(true);
        expect(r.consume("a", null, now)).toBe("ok");
        expect(r.unconsume("a", null)).toBe(true); // null successor matches null
    });

    it("revokeFamily on a known family extends but never shortens the marker; revokeUser covers every family", () => {
        const r = mk();
        reg(r, "a", "f1", "u1");
        reg(r, "b", "f2", "u1");
        reg(r, "c", "f3", "u2");
        expect(r.familiesOfUser("u1").sort()).toEqual(["f1", "f2"]);
        expect(r.familiesOfUser("none")).toEqual([]);
        r.revokeFamily("f1", now, 50);
        r.revokeFamily("f1", now, 10);
        expect(r.revokeUser("u1", now)).toBe(2);
        expect(r.revokeUser("nobody", now)).toBe(0);
        expect(r.consume("c", null, now)).toBe("ok");
        expect(r.consume("a", null, now)).toBe("revoked");
    });

    it("register is idempotent, widens family expiry, and binds a userKey to a marker-only family", () => {
        const r = mk();
        reg(r, "a", "f1", "u1", now + 10);
        reg(r, "a", "f1", "u1", now + 10);
        expect(r.size).toBe(1);
        reg(r, "b", "f1", "u1", now + 99_999);
        r.revokeFamily("fm", now);
        reg(r, "m1", "fm", "u9");
        expect(r.familiesOfUser("u9")).toEqual(["fm"]);
        expect(r.size).toBe(3);
    });

    it("is bounded: sweeps expired entries first, else drops the oldest; sweep runs at most once a second", () => {
        const r = mk(2);
        reg(r, "old1", "f1", "u1", now - 1);
        reg(r, "live", "f2", "u2", now + 1_000_000);
        reg(r, "new", "f3", "u3", now + 1_000_000); // sweep drops old1 (expired, family dropped)
        expect(r.size).toBe(2);
        expect(r.familiesOfUser("u1")).toEqual([]);
        reg(r, "n2", "f4", "u4", now + 1_000_000); // within the sweep gap: oldest (live) dropped
        expect(r.size).toBe(2);
        expect(r.consume("live", null, now)).toBe("unknown");
        now += 5000;
        r.revokeFamily("f3", now, 1);
        reg(r, "n3", "f5", "u5", now + 1000); // evicting "new" of a revoked family keeps its marker
        expect(r.consume("zz", null, now, "f3")).toBe("revoked");
    });

    it("an expired empty live family is swept with its user index", () => {
        const r = mk(1);
        reg(r, "a", "f1", "u1", now - 1);
        now += 2000;
        reg(r, "b", "f2", "u2", now + 100);
        expect(r.familiesOfUser("u1")).toEqual([]);
        r.clear();
        expect(r.size).toBe(0);
    });
});

describe("RevokedSessionSet", () => {
    let now: number;
    const mk = (maxEntries = 100) => new RevokedSessionSet({ maxEntries, now: () => now });
    beforeEach(() => {
        now = 5000;
    });

    it("rejects malformed input and keeps the LATER expiry on re-revoke", () => {
        const s = mk();
        expect(s.revoke("", 10)).toEqual({ added: false, dropped: false });
        expect(s.revoke(5 as unknown as string, 10)).toEqual({ added: false, dropped: false });
        expect(s.revoke("f", NaN)).toEqual({ added: false, dropped: false });
        expect(s.revoke("f", now + 10)).toEqual({ added: true, dropped: false });
        expect(s.revoke("f", now + 100)).toEqual({ added: false, dropped: false });
        expect(s.revoke("f", now + 1)).toEqual({ added: false, dropped: false });
        expect(s.has("f", now + 50)).toBe(true);
    });

    it("has() is false for non-strings and unknown fids, and forgets an expired entry", () => {
        const s = mk();
        expect(s.has(undefined as unknown as string)).toBe(false);
        expect(s.has("nope")).toBe(false);
        s.revoke("f", now + 10);
        expect(s.has("f")).toBe(true);
        expect(s.has("f", now + 10)).toBe(false);
        expect(s.size).toBe(0);
    });

    it("snapshot lists live entries longest-lived first and honours a limit", () => {
        const s = mk();
        s.revoke("a", now + 10);
        s.revoke("b", now + 30);
        s.revoke("c", now + 20);
        s.revoke("gone", now - 1);
        expect(s.snapshot().map((e) => e.fid)).toEqual(["b", "c", "a"]);
        expect(s.snapshot(now, 2).map((e) => e.fid)).toEqual(["b", "c"]);
        s.clear();
        expect(s.size).toBe(0);
    });

    it("when full: sweeps expired (no drop), else evicts the soonest-expiring live one and says so", () => {
        const s = mk(2);
        s.revoke("a", now - 1);
        s.revoke("b", now + 100);
        expect(s.revoke("c", now + 200)).toEqual({ added: true, dropped: false });
        expect(s.has("a")).toBe(false);
        now += 10; // sweep gap not elapsed (1000ms)
        const r = s.revoke("d", now + 300);
        expect(r.dropped).toBe(true);
        expect(s.has("b", now)).toBe(false);
        expect(s.has("c", now)).toBe(true);
    });

    it("full of already-expired entries evicts one without reporting a live drop", () => {
        const s = mk(1);
        s.revoke("a", now + 5);
        now += 2000; // sweep allowed; entry expired
        expect(s.revoke("b", now + 5)).toEqual({ added: true, dropped: false });
        const t = mk(1);
        t.revoke("x", 1);
        // sweep gap not yet elapsed relative to -Infinity is always elapsed; force the non-swept path
        t.revoke("y", now + 5);
        expect(t.has("y", now)).toBe(true);
    });
});

describe("refreshFamilyOf", () => {
    const secret = process.env.JWT_SECRET as string;
    const refresh = (over: Record<string, unknown> = {}, opts: jwt.SignOptions = {}) =>
        jwt.sign({ type: TOKEN_TYPES.REFRESH, fid: FID, ...over }, secret, {
            audience: TOKEN_AUDIENCES.REFRESH, issuer: TOKEN_ISSUER, expiresIn: "1h", ...opts,
        });

    it("returns the family of a fully valid refresh token", () => {
        expect(refreshFamilyOf(refresh())).toBe(FID);
    });

    it.each([
        ["non-string", 5],
        ["empty", ""],
        ["oversized", "a".repeat(4097)],
        ["garbage", "not.a.jwt"],
    ])("returns null for %s", (_n, tok) => {
        expect(refreshFamilyOf(tok)).toBeNull();
    });

    it("returns null for an access-type token, wrong audience, wrong secret, short fid and a missing fid", () => {
        expect(refreshFamilyOf(refresh({ type: TOKEN_TYPES.ACCESS }))).toBeNull();
        expect(refreshFamilyOf(refresh({}, { audience: TOKEN_AUDIENCES.ACCESS }))).toBeNull();
        expect(refreshFamilyOf(jwt.sign({ type: TOKEN_TYPES.REFRESH, fid: FID }, "other-secret", { audience: TOKEN_AUDIENCES.REFRESH, issuer: TOKEN_ISSUER }))).toBeNull();
        expect(refreshFamilyOf(refresh({ fid: "short" }))).toBeNull();
        expect(refreshFamilyOf(refresh({ fid: undefined }))).toBeNull();
    });

    it("fails closed when JWT_SECRET is unset", () => {
        const token = refresh();
        const saved = process.env.JWT_SECRET;
        delete process.env.JWT_SECRET;
        try {
            expect(refreshFamilyOf(token)).toBeNull();
        } finally {
            process.env.JWT_SECRET = saved;
        }
    });
});

describe("canonicalUserKey", () => {
    it.each([
        ["30901", "30901"], ["030901", "30901"], [" 30901 ", "30901"], ["3.0901e4", "30901"],
        ["+7", "7"], [".5", "0.5"], ["abc", "abc"], ["  Bob ", "Bob"], [null, ""], [undefined, ""], [42, "42"],
        ["1e999", "1e999"],
    ])("%j -> %j (every spelling of one account shares one lockout budget)", (input, out) => {
        expect(canonicalUserKey(input)).toBe(out);
    });
});

describe("requireAuthUser", () => {
    it("returns the user or throws 401", () => {
        const user = { userId: "u" };
        expect(requireAuthUser({ user } as unknown as Request)).toBe(user);
        try {
            requireAuthUser({} as Request);
            throw new Error("no throw");
        } catch (e: any) {
            expect(e.statusCode).toBe(401);
        }
    });
});

describe("tokenClaims", () => {
    it("classifies access / legacy / wrong-type", () => {
        const ok = { type: TOKEN_TYPES.ACCESS, aud: TOKEN_AUDIENCES.ACCESS, iss: TOKEN_ISSUER };
        expect(classifyAccessClaims(ok)).toBe("access");
        expect(classifyAccessClaims({ sub: "x" })).toBe("legacy");
        expect(classifyAccessClaims({ ...ok, type: TOKEN_TYPES.REFRESH })).toBe("wrong-type");
        expect(classifyAccessClaims({ ...ok, aud: ["a"] })).toBe("wrong-type");
        expect(classifyAccessClaims({ ...ok, iss: "evil" })).toBe("wrong-type");
        expect(classifyAccessClaims({ type: "access" })).toBe("wrong-type");
        expect(classifyAccessClaims(null)).toBe("wrong-type");
        expect(classifyAccessClaims([] as never)).toBe("wrong-type");
        expect(classifyAccessClaims(undefined)).toBe("wrong-type");
    });

    it("credentialEpoch is stable, secret-bound, and null without a hash or secret", () => {
        const a = credentialEpoch("hash-1");
        expect(a).toMatch(/^[0-9a-f]{16}$/);
        expect(credentialEpoch("hash-1")).toBe(a);
        expect(credentialEpoch("hash-2")).not.toBe(a);
        expect(credentialEpoch("")).toBeNull();
        expect(credentialEpoch(null)).toBeNull();
        const saved = process.env.JWT_SECRET;
        delete process.env.JWT_SECRET;
        try {
            expect(credentialEpoch("hash-1")).toBeNull();
        } finally {
            process.env.JWT_SECRET = saved;
        }
    });

    it("parseDuration and accessTokenTtl handle units, bad formats and the default", () => {
        expect(parseDuration("2h")).toBe(7_200_000);
        expect(() => parseDuration("2 weeks")).toThrow(/Unrecognised/);
        expect(accessTokenTtl("5m")).toEqual({ ttlMs: 300_000, raw: "5m" });
        expect(accessTokenTtl("soon")).toEqual({ ttlMs: null, raw: "soon" });
        expect(accessTokenTtl("").ttlMs).toEqual(expect.any(Number));
    });
});
