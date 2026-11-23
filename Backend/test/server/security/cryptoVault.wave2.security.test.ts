import crypto from "crypto";
import { createRequire } from "module";

type Vault = typeof import("../../../src/utils/encryption/CryptoVault");

const nativeRequire = createRequire(import.meta.url);
const bcrypt = nativeRequire("bcryptjs") as typeof import("bcryptjs");

const BASE_ENV: Record<string, string | undefined> = {
    PASSWORD_HASH_MODE: "argon2",
    PASSWORD_ENCRYPTION_MODE: undefined,
    ARGON2_PEPPER: "A".repeat(40),
    ARGON2_MEMORY_COST: "8192",
    ARGON2_TIME_COST: "1",
    ARGON2_PARALLELISM: "1",
    ARGON2_HASH_LENGTH: "32",
    ARGON2_MAX_PASSWORD_BYTES: undefined,
    BCRYPT_SALT_ROUNDS: "10",
    PASSWORD_KEY: "sec-key",
    DATA_SIGNING_SECRET: "S".repeat(40),
    NODE_ENV: "test",
};
const saved: Record<string, string | undefined> = {};
/** Every instance stays referenced so V8 keeps (and reports) coverage for superseded copies. */
const loaded: Vault[] = [];

async function load(env: Record<string, string | undefined> = {}): Promise<Vault> {
    for (const [k, v] of Object.entries({ ...BASE_ENV, ...env })) {
        if (!(k in saved)) saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    vi.resetModules();
    const mod = await import("../../../src/utils/encryption/CryptoVault");
    loaded.push(mod);
    return mod;
}

afterEach(() => {
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

describe("CryptoVault wave2 security: password hashing", () => {
    it("a hash made under one pepper never verifies under another (CWE-798 blast-radius)", async () => {
        const a = await load({ ARGON2_PEPPER: "A".repeat(40) });
        const hash = await a.CryptoVault.hashPassword("Correct-Horse-1");
        expect(await a.CryptoVault.verifyPassword("Correct-Horse-1", hash)).toBe(true);
        const b = await load({ ARGON2_PEPPER: "B".repeat(40) });
        expect(await b.CryptoVault.verifyPassword("Correct-Horse-1", hash)).toBe(false);
    });

    it("the same password hashes differently each time (per-hash salt)", async () => {
        const { CryptoVault } = await load();
        const [h1, h2] = await Promise.all([CryptoVault.hashPassword("same"), CryptoVault.hashPassword("same")]);
        expect(h1).not.toBe(h2);
    });

    it("an over-length password is refused before any hashing work (CWE-400)", async () => {
        const { CryptoVault } = await load({ ARGON2_MAX_PASSWORD_BYTES: "64" });
        const tooLong = "x".repeat(65);
        const hashSpy = vi.spyOn(bcrypt, "hash");
        await expect(CryptoVault.hashPassword(tooLong)).rejects.toThrow(RangeError);
        await expect(CryptoVault.verifyPassword(tooLong, "$argon2id$x")).rejects.toThrow(RangeError);
        await expect(CryptoVault.verifyAdminPassword(tooLong, "$argon2id$x")).rejects.toThrow(RangeError);
        expect(hashSpy).not.toHaveBeenCalled();
        // the limit counts bytes, not characters
        await expect(CryptoVault.hashPassword("é".repeat(33))).rejects.toThrow(RangeError);
    });

    it("bcrypt only sees 72 bytes, so admin passwords beyond that are refused instead of silently truncated (CWE-916)", async () => {
        const { CryptoVault } = await load({ PASSWORD_HASH_MODE: "bcrypt" });
        const base = "p".repeat(72);
        const hash = await CryptoVault.hashAdminPassword(base);
        // A different password sharing the same first 72 bytes must not log in.
        expect((await CryptoVault.verifyAdminPassword(base + "-different-tail", hash)).matched).toBe(false);
        await expect(CryptoVault.hashAdminPassword(base + "!")).rejects.toThrow(/72-byte/);
        const migrated = await CryptoVault.migrateFromBcrypt(base + "!", hash);
        expect(migrated).toEqual({ matched: false, argon2Hash: null, requiresReset: true });
    });

    it("plain mode is impossible in production and a weak mode never produces weak admin hashes", async () => {
        const prod = await load({ PASSWORD_HASH_MODE: "plain", NODE_ENV: "production" });
        await expect(prod.CryptoVault.hashPassword("x")).rejects.toThrow(/forbidden in production/);
        const weak = await load({ PASSWORD_HASH_MODE: "tripledes", PASSWORD_ENCRYPTION_MODE: "argon2" });
        const hash = await weak.CryptoVault.hashAdminPassword("Adm1n-pass");
        expect(hash.startsWith("$argon2id$")).toBe(true);
        expect(await weak.CryptoVault.hashPassword("Adm1n-pass")).not.toBe(hash);
    });

    it("failure messages never echo the password or the stored hash", async () => {
        const { CryptoVault } = await load();
        const secret = "My-Very-Secret-Pw";
        const err = await CryptoVault.verifyPassword(secret, "$argon2id$not-a-real-hash").catch((e: Error) => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).not.toContain(secret);
        expect((err as Error).message).not.toContain("not-a-real-hash");
    });
});

describe("CryptoVault wave2 security: record signing", () => {
    it("a record signed under one secret is rejected under another", async () => {
        const a = await load({ DATA_SIGNING_SECRET: "S".repeat(40) });
        const sig = await a.CryptoVault.signRecord("T_ADMINS_DEV", { USERNAME: "u", ROLE: "ADMIN" });
        const b = await load({ DATA_SIGNING_SECRET: "Z".repeat(40) });
        expect(await b.CryptoVault.verifyRecord("T_ADMINS_DEV", { USERNAME: "u", ROLE: "ADMIN" }, sig)).toBe(false);
    });

    it("a pipe inside a value cannot forge a second field (CWE-347)", async () => {
        const { CryptoVault } = await load();
        const honest = await CryptoVault.signRecord("T", { NOTE: "ok", STATUS: "PENDING" });
        const forged = { NOTE: "ok|STATUS=PENDING" };
        expect(CryptoVault.buildPayload("T", forged)).not.toBe(CryptoVault.buildPayload("T", { NOTE: "ok", STATUS: "PENDING" }));
        expect(await CryptoVault.verifyRecord("T", forged, honest)).toBe(false);
    });

    it("signature encodings that Buffer.from(hex) would silently accept are refused", async () => {
        const { CryptoVault } = await load();
        const sig = await CryptoVault.signData("payload");
        for (const bad of [sig + "zz", sig.slice(0, -1), sig + "0", ` ${sig}`, sig.replace(/^./, "g")]) {
            expect(await CryptoVault.verifySignature("payload", bad)).toBe(false);
        }
        expect(await CryptoVault.verifySignature("payload", sig)).toBe(true);
    });

    it("verifyRowHash never throws on non-ASCII input of equal string length and compares case-insensitively", async () => {
        const { CryptoVault } = await load();
        const canonical = "1|ORDER|alice|10.00";
        const real = crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
        expect(CryptoVault.verifyRowHash(canonical, real)).toBe(true);
        expect(CryptoVault.verifyRowHash(canonical, real.toUpperCase())).toBe(true);
        expect(() => CryptoVault.verifyRowHash(canonical, "é".repeat(real.length))).not.toThrow();
        expect(CryptoVault.verifyRowHash(canonical, "é".repeat(real.length))).toBe(false);
        expect(CryptoVault.verifyRowHash("", real)).toBe(false);
        expect(CryptoVault.verifyRowHash(canonical, "")).toBe(false);
    });
});
