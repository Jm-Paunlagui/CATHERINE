/**
 * @fileoverview Unit tests for BackupTokenService (issue / verify / consume).
 *
 * The replay ledger (BackupTokenModel.consumeJti) is replaced with an
 * in-memory Set that has the same exactly-once semantics as the Oracle
 * primary key, so no database is needed.
 */

import crypto from "crypto";
import BackupTokenService from "../../../../src/services/BackupTokenService";
import BackupTokenModel from "../../../../src/models/backup-token.model";
import { CryptoVault } from "../../../../src/utils/encryption/CryptoVault";

const ROW_COUNTS = { T_SERVER_ALERT_LOG_DEV: 42, T_AUDIT_LOGS_DEV: 7 };

/** Builds a correctly SIGNED token around an arbitrary payload object. */
async function signedToken(payload: unknown): Promise<string> {
    const json = JSON.stringify(payload);
    const sig = await CryptoVault.signData(json);
    return `${sig}.${Buffer.from(json, "utf8").toString("base64url")}`;
}

function decode(token: string): Record<string, any> {
    const b64 = token.slice(token.indexOf(".") + 1);
    return JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
}

let ledger: Set<string>;
let consumeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    ledger = new Set();
    consumeSpy = vi
        .spyOn(BackupTokenModel, "consumeJti")
        .mockImplementation(async ({ jti }: { jti: string }) => {
            if (ledger.has(jti)) {
                return { consumed: false, reason: "already-consumed" } as const;
            }
            ledger.add(jti);
            return { consumed: true } as const;
        });
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.BACKUP_TOKEN_TTL_MINUTES;
});

describe("BackupTokenService.issue", () => {
    it("returns a '<hex-signature>.<base64url-payload>' token", async () => {
        const { token } = await BackupTokenService.issue({
            adminId: 10234,
            scopeHash: "abc",
            rowCounts: ROW_COUNTS,
        });
        expect(token).toMatch(/^[0-9a-f]{64}\.[A-Za-z0-9_-]+$/);
    });

    it("embeds adminId, scopeHash, rowCounts, timestamps and a jti in the payload", async () => {
        const { token, issuedAt, expiresAt } = await BackupTokenService.issue({
            adminId: 10234,
            scopeHash: "abc",
            rowCounts: ROW_COUNTS,
        });
        const payload = decode(token);
        expect(payload).toMatchObject({
            adminId: 10234,
            scopeHash: "abc",
            rowCounts: ROW_COUNTS,
            issuedAt,
            expiresAt,
        });
        expect(typeof payload.jti).toBe("string");
        expect(payload.jti.length).toBeGreaterThan(0);
    });

    it("mints a unique jti for every token", async () => {
        const args = { adminId: 1, scopeHash: "h", rowCounts: ROW_COUNTS };
        const a = await BackupTokenService.issue(args);
        const b = await BackupTokenService.issue(args);
        expect(decode(a.token).jti).not.toBe(decode(b.token).jti);
    });

    it("defaults the TTL to 30 minutes", async () => {
        const { issuedAt, expiresAt } = await BackupTokenService.issue({
            adminId: 1,
            scopeHash: "h",
            rowCounts: ROW_COUNTS,
        });
        expect(expiresAt - issuedAt).toBe(30 * 60 * 1000);
    });

    it("honours BACKUP_TOKEN_TTL_MINUTES from the environment", async () => {
        process.env.BACKUP_TOKEN_TTL_MINUTES = "5";
        const { issuedAt, expiresAt } = await BackupTokenService.issue({
            adminId: 1,
            scopeHash: "h",
            rowCounts: ROW_COUNTS,
        });
        expect(expiresAt - issuedAt).toBe(5 * 60 * 1000);
    });

    it("lets an explicit ttlMinutes override the environment", async () => {
        process.env.BACKUP_TOKEN_TTL_MINUTES = "5";
        const { issuedAt, expiresAt } = await BackupTokenService.issue({
            adminId: 1,
            scopeHash: "h",
            rowCounts: ROW_COUNTS,
            ttlMinutes: 2,
        });
        expect(expiresAt - issuedAt).toBe(2 * 60 * 1000);
    });

    it("falls back to the default TTL for a non-numeric environment value", async () => {
        process.env.BACKUP_TOKEN_TTL_MINUTES = "soon";
        const { issuedAt, expiresAt } = await BackupTokenService.issue({
            adminId: 1,
            scopeHash: "h",
            rowCounts: ROW_COUNTS,
        });
        expect(expiresAt - issuedAt).toBe(30 * 60 * 1000);
    });

    it("includes highWater in the signed payload only when non-empty", async () => {
        const withHw = await BackupTokenService.issue({
            adminId: 1,
            scopeHash: "h",
            rowCounts: ROW_COUNTS,
            highWater: { T_AUDIT_LOGS_DEV: "123" },
        });
        const emptyHw = await BackupTokenService.issue({
            adminId: 1,
            scopeHash: "h",
            rowCounts: ROW_COUNTS,
            highWater: {},
        });
        expect(decode(withHw.token).highWater).toEqual({ T_AUDIT_LOGS_DEV: "123" });
        expect(decode(emptyHw.token)).not.toHaveProperty("highWater");
    });
});

describe("BackupTokenService.verify", () => {
    it("accepts a freshly issued token and returns its payload", async () => {
        const { token } = await BackupTokenService.issue({
            adminId: 9,
            scopeHash: "h",
            rowCounts: ROW_COUNTS,
        });
        const result = await BackupTokenService.verify(token);
        expect(result.valid).toBe(true);
        if (result.valid) {
            expect(result.payload.adminId).toBe(9);
            expect(result.payload.rowCounts).toEqual(ROW_COUNTS);
        }
    });

    it("is pure: never touches the replay ledger and can be repeated", async () => {
        const { token } = await BackupTokenService.issue({
            adminId: 9,
            scopeHash: "h",
            rowCounts: ROW_COUNTS,
        });
        expect((await BackupTokenService.verify(token)).valid).toBe(true);
        expect((await BackupTokenService.verify(token)).valid).toBe(true);
        expect(consumeSpy).not.toHaveBeenCalled();
    });

    it.each([
        ["empty string", ""],
        ["no dot", "abcdef"],
        ["undefined", undefined],
        ["null", null],
        ["a number", 12345],
        ["an object", {}],
    ])("rejects %s as malformed", async (_label, value) => {
        const result = await BackupTokenService.verify(value as unknown as string);
        expect(result).toEqual({ valid: false, reason: "malformed" });
    });

    it("rejects an empty payload half ('<sig>.') as malformed without throwing", async () => {
        const result = await BackupTokenService.verify("a".repeat(64) + ".");
        expect(result).toEqual({ valid: false, reason: "malformed" });
    });

    it("rejects a payload modified after signing as tampered", async () => {
        const { token } = await BackupTokenService.issue({
            adminId: 9,
            scopeHash: "h",
            rowCounts: { T_AUDIT_LOGS_DEV: 1 },
        });
        const [sig, b64] = token.split(".");
        const payload = decode(token);
        payload.rowCounts = { T_AUDIT_LOGS_DEV: 1, T_ADMINS_DEV: 1 };
        const forgedB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
        expect(forgedB64).not.toBe(b64);

        const result = await BackupTokenService.verify(`${sig}.${forgedB64}`);
        expect(result).toEqual({ valid: false, reason: "tampered" });
    });

    it("rejects a payload that tries to extend its own expiry as tampered", async () => {
        const { token } = await BackupTokenService.issue({
            adminId: 9,
            scopeHash: "h",
            rowCounts: ROW_COUNTS,
        });
        const sig = token.slice(0, token.indexOf("."));
        const payload = decode(token);
        payload.expiresAt += 10 * 365 * 24 * 3600 * 1000;
        const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
        expect(await BackupTokenService.verify(`${sig}.${b64}`)).toEqual({
            valid: false,
            reason: "tampered",
        });
    });

    it("rejects a token signed with a different secret as tampered", async () => {
        const { token } = await BackupTokenService.issue({
            adminId: 9,
            scopeHash: "h",
            rowCounts: ROW_COUNTS,
        });
        const b64 = token.slice(token.indexOf(".") + 1);
        const json = Buffer.from(b64, "base64url").toString("utf8");
        const wrongSig = crypto
            .createHmac("sha256", "attacker-chosen-secret-0123456789abcdef")
            .update(json, "utf8")
            .digest("hex");
        expect(await BackupTokenService.verify(`${wrongSig}.${b64}`)).toEqual({
            valid: false,
            reason: "tampered",
        });
    });

    it("rejects a non-hex / truncated signature as tampered", async () => {
        const { token } = await BackupTokenService.issue({
            adminId: 9,
            scopeHash: "h",
            rowCounts: ROW_COUNTS,
        });
        const [sig, b64] = token.split(".");
        for (const bad of [sig.slice(0, 32), `${sig}zz`, "z".repeat(64), "0".repeat(64)]) {
            expect(await BackupTokenService.verify(`${bad}.${b64}`)).toEqual({
                valid: false,
                reason: "tampered",
            });
        }
    });

    it("rejects a correctly signed token past its expiry as expired", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        const { token, expiresAt } = await BackupTokenService.issue({
            adminId: 9,
            scopeHash: "h",
            rowCounts: ROW_COUNTS,
            ttlMinutes: 1,
        });
        vi.setSystemTime(expiresAt + 1);
        expect(await BackupTokenService.verify(token)).toEqual({
            valid: false,
            reason: "expired",
        });
    });

    it("still accepts a token exactly at its expiry instant", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        const { token, expiresAt } = await BackupTokenService.issue({
            adminId: 9,
            scopeHash: "h",
            rowCounts: ROW_COUNTS,
            ttlMinutes: 1,
        });
        vi.setSystemTime(expiresAt);
        expect((await BackupTokenService.verify(token)).valid).toBe(true);
    });

    it("rejects a correctly signed but non-JSON payload as malformed", async () => {
        const json = "not-json";
        const sig = await CryptoVault.signData(json);
        const token = `${sig}.${Buffer.from(json, "utf8").toString("base64url")}`;
        expect(await BackupTokenService.verify(token)).toEqual({
            valid: false,
            reason: "malformed",
        });
    });

    it.each([
        ["null payload", null],
        ["missing expiresAt", { scopeHash: "h", rowCounts: {} }],
        ["string expiresAt", { scopeHash: "h", rowCounts: {}, expiresAt: "9999999999999" }],
        ["missing scopeHash", { rowCounts: {}, expiresAt: Date.now() + 60000 }],
        ["null rowCounts", { scopeHash: "h", rowCounts: null, expiresAt: Date.now() + 60000 }],
        ["missing rowCounts", { scopeHash: "h", expiresAt: Date.now() + 60000 }],
    ])("rejects a signed payload with %s as malformed", async (_label, payload) => {
        const token = await signedToken(payload);
        expect(await BackupTokenService.verify(token)).toEqual({
            valid: false,
            reason: "malformed",
        });
    });
});

describe("BackupTokenService.consume", () => {
    it("accepts a valid token once and returns the payload with its jti", async () => {
        const { token } = await BackupTokenService.issue({
            adminId: 77,
            scopeHash: "h",
            rowCounts: ROW_COUNTS,
        });
        const result = await BackupTokenService.consume(token);
        expect(result.valid).toBe(true);
        if (result.valid) {
            expect(result.payload.jti).toBe(decode(token).jti);
            expect(result.payload.adminId).toBe(77);
        }
        expect(consumeSpy).toHaveBeenCalledTimes(1);
        expect(consumeSpy.mock.calls[0][0]).toMatchObject({
            jti: decode(token).jti,
            adminId: 77,
        });
        expect(consumeSpy.mock.calls[0][0].expiresAt).toEqual(
            new Date(decode(token).expiresAt),
        );
    });

    it("rejects a second use of the same token as replayed", async () => {
        const { token } = await BackupTokenService.issue({
            adminId: 77,
            scopeHash: "h",
            rowCounts: ROW_COUNTS,
        });
        expect((await BackupTokenService.consume(token)).valid).toBe(true);
        expect(await BackupTokenService.consume(token)).toEqual({
            valid: false,
            reason: "replayed",
        });
        expect(await BackupTokenService.consume(token)).toEqual({
            valid: false,
            reason: "replayed",
        });
    });

    it("lets only one of several concurrent consumers win", async () => {
        const { token } = await BackupTokenService.issue({
            adminId: 77,
            scopeHash: "h",
            rowCounts: ROW_COUNTS,
        });
        const results = await Promise.all(
            Array.from({ length: 5 }, () => BackupTokenService.consume(token)),
        );
        expect(results.filter((r) => r.valid)).toHaveLength(1);
        expect(
            results.filter((r) => !r.valid && r.reason === "replayed"),
        ).toHaveLength(4);
    });

    it("treats distinct tokens independently", async () => {
        const args = { adminId: 77, scopeHash: "h", rowCounts: ROW_COUNTS };
        const a = await BackupTokenService.issue(args);
        const b = await BackupTokenService.issue(args);
        expect((await BackupTokenService.consume(a.token)).valid).toBe(true);
        expect((await BackupTokenService.consume(b.token)).valid).toBe(true);
    });

    it("does not burn the jti for a tampered token (ledger untouched)", async () => {
        const { token } = await BackupTokenService.issue({
            adminId: 77,
            scopeHash: "h",
            rowCounts: ROW_COUNTS,
        });
        const forged = `${"0".repeat(64)}.${token.split(".")[1]}`;
        expect(await BackupTokenService.consume(forged)).toEqual({
            valid: false,
            reason: "tampered",
        });
        expect(consumeSpy).not.toHaveBeenCalled();
        // the genuine token is still usable afterwards
        expect((await BackupTokenService.consume(token)).valid).toBe(true);
    });

    it("rejects an expired token without touching the ledger", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        const { token, expiresAt } = await BackupTokenService.issue({
            adminId: 77,
            scopeHash: "h",
            rowCounts: ROW_COUNTS,
            ttlMinutes: 1,
        });
        vi.setSystemTime(expiresAt + 1000);
        expect(await BackupTokenService.consume(token)).toEqual({
            valid: false,
            reason: "expired",
        });
        expect(consumeSpy).not.toHaveBeenCalled();
    });

    it("rejects a malformed token without touching the ledger", async () => {
        expect(await BackupTokenService.consume("garbage")).toEqual({
            valid: false,
            reason: "malformed",
        });
        expect(consumeSpy).not.toHaveBeenCalled();
    });

    it("rejects a correctly signed token that has no jti as malformed", async () => {
        const token = await signedToken({
            scopeHash: "h",
            rowCounts: ROW_COUNTS,
            adminId: 1,
            issuedAt: Date.now(),
            expiresAt: Date.now() + 60000,
        });
        expect(await BackupTokenService.consume(token)).toEqual({
            valid: false,
            reason: "malformed",
        });
        expect(consumeSpy).not.toHaveBeenCalled();
    });

    it("rejects a correctly signed token with an empty jti as malformed", async () => {
        const token = await signedToken({
            scopeHash: "h",
            rowCounts: ROW_COUNTS,
            adminId: 1,
            issuedAt: Date.now(),
            expiresAt: Date.now() + 60000,
            jti: "",
        });
        expect(await BackupTokenService.consume(token)).toEqual({
            valid: false,
            reason: "malformed",
        });
    });

    it("propagates a ledger failure other than a duplicate (fails closed)", async () => {
        consumeSpy.mockRejectedValueOnce(new Error("ORA-03113: end-of-file"));
        const { token } = await BackupTokenService.issue({
            adminId: 77,
            scopeHash: "h",
            rowCounts: ROW_COUNTS,
        });
        await expect(BackupTokenService.consume(token)).rejects.toThrow("ORA-03113");
    });
});
