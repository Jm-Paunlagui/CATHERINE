import crypto from "crypto";
import { createRequire } from "module";

const nativeRequire = createRequire(import.meta.url);

type Vault = typeof import("../../../src/utils/encryption/CryptoVault");

const BASE_ENV: Record<string, string | undefined> = {
    PASSWORD_HASH_MODE: "argon2",
    PASSWORD_ENCRYPTION_MODE: undefined,
    ARGON2_PEPPER: "p".repeat(40),
    ARGON2_MEMORY_COST: "8192",
    ARGON2_TIME_COST: "1",
    ARGON2_PARALLELISM: "1",
    ARGON2_HASH_LENGTH: "32",
    ARGON2_MAX_PASSWORD_BYTES: undefined,
    BCRYPT_SALT_ROUNDS: "10",
    PASSWORD_KEY: "unit-test-key",
    DATA_SIGNING_SECRET: "s".repeat(40),
    NODE_ENV: "test",
};

const saved: Record<string, string | undefined> = {};
/** Every module instance stays referenced so V8 keeps (and reports) coverage for superseded copies. */
const loaded: Vault[] = [];

/** Loads a fresh CryptoVault module (its mode/config are cached per module instance). */
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
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    vi.restoreAllMocks();
});

describe("CryptoVault - password modes", () => {
    it("plain mode stores verbatim and compares exactly", async () => {
        const { CryptoVault } = await load({ PASSWORD_HASH_MODE: "plain" });
        expect(await CryptoVault.hashPassword("pw")).toBe("pw");
        expect(await CryptoVault.verifyPassword("pw", "pw")).toBe(true);
        expect(await CryptoVault.verifyPassword("pw", "PW")).toBe(false);
        expect(CryptoVault.needsRehash("pw")).toBe(false);
        expect(CryptoVault.config).toEqual({ mode: "plain" });
    });

    it("refuses plain mode in production", async () => {
        const { CryptoVault } = await load({ PASSWORD_HASH_MODE: "plain", NODE_ENV: "production" });
        await expect(CryptoVault.hashPassword("pw")).rejects.toThrow(/forbidden in production/);
    });

    it("rejects an unknown mode", async () => {
        const { CryptoVault } = await load({ PASSWORD_HASH_MODE: "md5" });
        await expect(CryptoVault.hashPassword("pw")).rejects.toThrow(/Invalid PASSWORD_HASH_MODE/);
    });

    it("tripledes mode round-trips and rejects a wrong password", async () => {
        const { CryptoVault } = await load({
            PASSWORD_HASH_MODE: "tripledes",
            PASSWORD_ENCRYPTION_MODE: "bcrypt",
        });
        const enc = await CryptoVault.hashPassword("Secret1!");
        expect(enc).not.toBe("Secret1!");
        expect(await CryptoVault.verifyPassword("Secret1!", enc)).toBe(true);
        expect(await CryptoVault.verifyPassword("Other", enc)).toBe(false);
        expect(CryptoVault.maxPasswordBytes({ forHash: true })).toBe(72);
        expect(CryptoVault.maxPasswordBytes()).toBe(1024);
    });

    it("tripledes hashing fails closed when PASSWORD_KEY is missing", async () => {
        const { CryptoVault } = await load({
            PASSWORD_HASH_MODE: "tripledes",
            PASSWORD_ENCRYPTION_MODE: "bcrypt",
            PASSWORD_KEY: undefined,
        });
        await expect(CryptoVault.hashPassword("pw")).rejects.toThrow(/TripleDES encryption failed/);
    });

    it("bcrypt mode hashes, verifies, and exposes its rounds", async () => {
        const { CryptoVault, BCryptAdapter } = await load({ PASSWORD_HASH_MODE: "bcrypt" });
        const h = await CryptoVault.hashPassword("pw");
        expect(h).toMatch(/^\$2[ab]\$10\$/);
        expect(await CryptoVault.verifyPassword("pw", h)).toBe(true);
        expect(await CryptoVault.verifyPassword("nope", h)).toBe(false);
        expect(CryptoVault.config).toEqual({ mode: "bcrypt", saltRounds: 10 });
        expect(CryptoVault.needsRehash(h)).toBe(false);
        expect(BCryptAdapter.saltRounds).toBe(10);
        const h2 = await BCryptAdapter.hashPassword("x");
        expect(await BCryptAdapter.verifyPassword("x", h2)).toBe(true);
    });

    it("argon2 mode hashes with pepper, reports config and detects weaker params", async () => {
        const { CryptoVault, Argon2Adapter } = await load();
        const h = await CryptoVault.hashPassword("pw");
        expect(h).toMatch(/^\$argon2id\$/);
        expect(await Argon2Adapter.verifyPassword("pw", h)).toBe(true);
        expect(await CryptoVault.verifyPassword("bad", h)).toBe(false);
        expect(CryptoVault.config).toMatchObject({ mode: "argon2", memoryCost: 8192, maxPasswordBytes: 1024 });
        expect(Argon2Adapter.config).toMatchObject({ mode: "argon2" });
        expect(Argon2Adapter.needsRehash(h)).toBe(false);
        // bcrypt hash under argon2 mode must be flagged, not thrown on
        expect(CryptoVault.needsRehash("$2b$10$abcdefghijklmnopqrstuv")).toBe(true);
        expect(CryptoVault.needsRehash("")).toBe(false);
        expect(CryptoVault.needsRehash("$argon2id$garbage")).toBe(true);
        const stronger = await load({ ARGON2_MEMORY_COST: "16384" });
        expect(stronger.CryptoVault.needsRehash(h)).toBe(true);
    });

    it("argon2 mode transparently verifies legacy bcrypt hashes (migration)", async () => {
        const bc = await load({ PASSWORD_HASH_MODE: "bcrypt" });
        const legacy = await bc.CryptoVault.hashPassword("pw");
        const { CryptoVault, Argon2Adapter } = await load();
        expect(await CryptoVault.verifyPassword("pw", legacy)).toBe(true);
        const mig = await Argon2Adapter.migrateFromBcrypt("pw", legacy);
        expect(mig.matched).toBe(true);
        expect(mig.argon2Hash).toMatch(/^\$argon2id\$/);
        expect(await CryptoVault.migrateFromBcrypt("wrong", legacy)).toEqual({ matched: false, argon2Hash: null });
    });

    it("migrateFromBcrypt refuses non-bcrypt hashes and over-72-byte passwords", async () => {
        const { CryptoVault } = await load();
        await expect(CryptoVault.migrateFromBcrypt("pw", "$argon2id$x")).rejects.toThrow(TypeError);
        const res = await CryptoVault.migrateFromBcrypt("a".repeat(73), "$2b$10$abcdefghijklmnopqrstuv");
        expect(res).toEqual({ matched: false, argon2Hash: null, requiresReset: true });
    });

    it("a pepper change invalidates stored argon2 hashes", async () => {
        const a = await load();
        const h = await a.CryptoVault.hashPassword("pw");
        const b = await load({ ARGON2_PEPPER: "q".repeat(40) });
        expect(await b.CryptoVault.verifyPassword("pw", h)).toBe(false);
    });
});

describe("CryptoVault - input validation (DoS and type confusion)", () => {
    it.each<[unknown, string]>([["", "empty"], [undefined, "undefined"], [123, "number"], [null, "null"]])(
        "rejects password %p (%s)",
        async (bad) => {
            const { CryptoVault } = await load();
            await expect(CryptoVault.hashPassword(bad as unknown as string)).rejects.toThrow(TypeError);
            await expect(CryptoVault.verifyPassword(bad as unknown as string, "x")).rejects.toThrow(TypeError);
        },
    );

    it("rejects passwords over the byte cap using bytes, not characters", async () => {
        const { CryptoVault } = await load({ ARGON2_MAX_PASSWORD_BYTES: "64" });
        await expect(CryptoVault.hashPassword("é".repeat(33))).rejects.toThrow(RangeError);
        await expect(CryptoVault.hashPassword("é".repeat(32))).resolves.toMatch(/^\$argon2/);
    });

    it("rejects an empty or non-string stored hash", async () => {
        const { CryptoVault } = await load();
        await expect(CryptoVault.verifyPassword("pw", "")).rejects.toThrow(TypeError);
        await expect(CryptoVault.verifyPassword("pw", 5 as unknown as string)).rejects.toThrow(TypeError);
        await expect(CryptoVault.verifyAdminPassword("pw", "")).rejects.toThrow(TypeError);
    });

    it("rejects out-of-range numeric config at load", async () => {
        const { CryptoVault } = await load({ ARGON2_TIME_COST: "0" });
        await expect(CryptoVault.hashPassword("pw")).rejects.toThrow(RangeError);
        // BCryptAdapter validates the rounds when the module loads, so an invalid value refuses the whole module.
        await expect(load({ PASSWORD_HASH_MODE: "bcrypt", BCRYPT_SALT_ROUNDS: "4" })).rejects.toThrow(RangeError);
        await expect(load({ BCRYPT_SALT_ROUNDS: "99" })).rejects.toThrow(/BCRYPT_SALT_ROUNDS/);
    });

    it("requires a pepper of at least 32 characters", async () => {
        const { CryptoVault } = await load({ ARGON2_PEPPER: "short" });
        await expect(CryptoVault.hashPassword("pw")).rejects.toThrow("Password hashing failed.");
    });
});

describe("CryptoVault - library failures surface as generic errors (no leakage)", () => {
    it("argon2 hash/verify errors are masked", async () => {
        const { CryptoVault } = await load();
        const argon2 = (await import("argon2")).default ?? (await import("argon2"));
        vi.spyOn(argon2, "hash").mockRejectedValue(new Error("secret internals"));
        vi.spyOn(argon2, "verify").mockRejectedValue(new Error("secret internals"));
        await expect(CryptoVault.hashPassword("pw")).rejects.toThrow("Password hashing failed.");
        await expect(CryptoVault.verifyPassword("pw", "$argon2id$x")).rejects.toThrow("Password verification failed.");
        await expect(CryptoVault.hashAdminPassword("pw")).rejects.toThrow("Admin password hashing failed.");
        await expect(CryptoVault.verifyAdminPassword("pw", "$argon2id$x")).rejects.toThrow("Admin password verification failed.");
    });

    it("bcrypt hash/verify errors are masked", async () => {
        const { CryptoVault, BCryptAdapter } = await load({ PASSWORD_HASH_MODE: "bcrypt" });
        const bcrypt = nativeRequire("bcryptjs");
        vi.spyOn(bcrypt, "hash").mockRejectedValue(new Error("boom"));
        vi.spyOn(bcrypt, "compare").mockRejectedValue(new Error("boom"));
        await expect(CryptoVault.hashPassword("pw")).rejects.toThrow("Password hashing failed.");
        await expect(CryptoVault.verifyPassword("pw", "$2b$10$x")).rejects.toThrow("Password verification failed.");
        await expect(CryptoVault.hashAdminPassword("pw")).rejects.toThrow("Admin password hashing failed.");
        await expect(CryptoVault.verifyAdminPassword("pw", "$2b$10$x")).rejects.toThrow("Admin password verification failed.");
        await expect(BCryptAdapter.hashPassword("pw")).rejects.toThrow("Password hashing failed.");
        await expect(BCryptAdapter.verifyPassword("pw", "h")).rejects.toThrow("Password verification failed.");
        await expect(BCryptAdapter.hashPassword("")).rejects.toThrow(TypeError);
        await expect(BCryptAdapter.verifyPassword("", "h")).rejects.toThrow(TypeError);
        await expect(BCryptAdapter.verifyPassword("p", "")).rejects.toThrow(TypeError);
    });
});

describe("CryptoVault - admin password handling", () => {
    it("PASSWORD_HASH_MODE weak without PASSWORD_ENCRYPTION_MODE fails closed", async () => {
        const { CryptoVault } = await load({ PASSWORD_HASH_MODE: "plain" });
        await expect(CryptoVault.hashAdminPassword("pw")).rejects.toThrow(/PASSWORD_ENCRYPTION_MODE is not configured/);
        const bad = await load({ PASSWORD_HASH_MODE: "plain", PASSWORD_ENCRYPTION_MODE: "plain" });
        await expect(bad.CryptoVault.hashAdminPassword("pw")).rejects.toThrow(/not allowed/);
    });

    it("bcrypt admin mode refuses >72 bytes on hash (CWE-916) and fails verify", async () => {
        const { CryptoVault } = await load({ PASSWORD_HASH_MODE: "bcrypt" });
        await expect(CryptoVault.hashAdminPassword("a".repeat(73))).rejects.toThrow(RangeError);
        const h = await CryptoVault.hashAdminPassword("a".repeat(72));
        expect(await CryptoVault.verifyAdminPassword("a".repeat(72), h)).toEqual({ matched: true, newHash: null });
        // a 73-byte password sharing the 72-byte prefix must NOT match
        expect(await CryptoVault.verifyAdminPassword("a".repeat(73), h)).toEqual({ matched: false, newHash: null });
        expect(CryptoVault.adminNeedsRehash(h)).toBe(false);
    });

    it("argon2 admin hash verifies, rejects wrong password, reports rehash needs", async () => {
        const { CryptoVault } = await load();
        const h = await CryptoVault.hashAdminPassword("Adm1n!pw");
        expect(await CryptoVault.verifyAdminPassword("Adm1n!pw", h)).toEqual({ matched: true, newHash: null });
        expect(await CryptoVault.verifyAdminPassword("x", h)).toEqual({ matched: false, newHash: null });
        expect(CryptoVault.adminNeedsRehash(h)).toBe(false);
        expect(CryptoVault.adminNeedsRehash("")).toBe(true);
        expect(CryptoVault.adminNeedsRehash("legacyBase64==")).toBe(true);
        expect(CryptoVault.adminNeedsRehash("$argon2id$garbage")).toBe(false);
        const stronger = await load({ ARGON2_TIME_COST: "3" });
        expect(stronger.CryptoVault.adminNeedsRehash(h)).toBe(true);
    });

    it("legacy TripleDES admin hash upgrades on match and is not an oracle on mismatch", async () => {
        const td = await load({ PASSWORD_HASH_MODE: "tripledes", PASSWORD_ENCRYPTION_MODE: "argon2" });
        const legacy = await td.CryptoVault.hashPassword("Legacy1!");
        const res = await td.CryptoVault.verifyAdminPassword("Legacy1!", legacy);
        expect(res.matched).toBe(true);
        expect(res.newHash).toMatch(/^\$argon2id\$/);
        expect(await td.CryptoVault.verifyAdminPassword("wrong", legacy)).toEqual({ matched: false, newHash: null });
        expect(await td.CryptoVault.verifyAdminPassword("x", "not-a-valid-ciphertext")).toEqual({ matched: false, newHash: null });
    });

    describe("temporary password marker", () => {
        it("accepts a correct unexpired temp password and reports its expiry", async () => {
            const { CryptoVault } = await load();
            const { wrapTemporaryHash } = await import("../../../src/utils/encryption/adminTempPassword");
            const inner = await CryptoVault.hashAdminPassword("Temp-pw-1");
            const exp = Date.now() + 3600_000;
            const stored = wrapTemporaryHash(inner, exp);
            const r = await CryptoVault.verifyAdminPassword("Temp-pw-1", stored);
            expect(r).toMatchObject({ matched: true, temporary: true, expired: false, newHash: null });
            expect(r.expiresAt).toBe(Math.floor(exp / 1000) * 1000);
        });

        it("refuses an expired temp password (matched=false, expired=true)", async () => {
            const { CryptoVault } = await load();
            const { wrapTemporaryHash } = await import("../../../src/utils/encryption/adminTempPassword");
            const stored = wrapTemporaryHash(await CryptoVault.hashAdminPassword("Temp-pw-1"), Date.now() - 5000);
            expect(await CryptoVault.verifyAdminPassword("Temp-pw-1", stored)).toMatchObject({
                matched: false,
                expired: true,
                temporary: true,
            });
        });

        it("never discloses expiry for a wrong password", async () => {
            const { CryptoVault } = await load();
            const { wrapTemporaryHash } = await import("../../../src/utils/encryption/adminTempPassword");
            const stored = wrapTemporaryHash(await CryptoVault.hashAdminPassword("Temp-pw-1"), Date.now() - 5000);
            expect(await CryptoVault.verifyAdminPassword("wrong", stored)).toEqual({
                matched: false,
                newHash: null,
                temporary: true,
                expired: false,
                expiresAt: null,
            });
        });

        it("fails closed on a malformed marker, even if the tail equals the password", async () => {
            const { CryptoVault } = await load();
            const r = await CryptoVault.verifyAdminPassword("$t$zzz-plain", "$t$zzz-plain");
            expect(r).toMatchObject({ matched: false, temporary: true, expired: false });
        });
    });
});

describe("CryptoVault - data signing (tamper, replay, forgery)", () => {
    it("buildPayload sorts keys and escapes pipes so values cannot fake fields", async () => {
        const { CryptoVault } = await load();
        expect(CryptoVault.buildPayload("T", { B: 2, A: 1 })).toBe("T:A=1|B=2");
        const injected = CryptoVault.buildPayload("T", { A: "ok|STATUS=APPROVED" });
        const honest = CryptoVault.buildPayload("T", { A: "ok", STATUS: "APPROVED" });
        expect(injected).not.toBe(honest);
    });

    it("buildPayload validates context and fields", async () => {
        const { CryptoVault } = await load();
        expect(() => CryptoVault.buildPayload("", {})).toThrow(TypeError);
        expect(() => CryptoVault.buildPayload("T", null as unknown as Record<string, unknown>)).toThrow(TypeError);
        expect(() => CryptoVault.buildPayload("T", [] as unknown as Record<string, unknown>)).toThrow(TypeError);
    });

    it("signRecord/verifyRecord detect field tampering and cross-context replay", async () => {
        const { CryptoVault } = await load();
        const fields = { ID: 1, ROLE: "USER" };
        const sig = await CryptoVault.signRecord("T_ADMINS", fields);
        expect(sig).toMatch(/^[0-9a-f]{64}$/);
        expect(await CryptoVault.verifyRecord("T_ADMINS", fields, sig)).toBe(true);
        expect(await CryptoVault.verifyRecord("T_ADMINS", { ...fields, ROLE: "SUPER_ADMIN" }, sig)).toBe(false);
        expect(await CryptoVault.verifyRecord("T_USERS", fields, sig)).toBe(false);
        expect(await CryptoVault.verifyRecord("T_ADMINS", fields, null)).toBe(false);
        expect(await CryptoVault.verifyRecord("T_ADMINS", fields, undefined)).toBe(false);
    });

    it("rejects signatures that are not the exact hex encoding", async () => {
        const { CryptoVault } = await load();
        const sig = await CryptoVault.signData("payload");
        expect(await CryptoVault.verifySignature("payload", sig)).toBe(true);
        expect(await CryptoVault.verifySignature("payload", sig.toUpperCase())).toBe(true);
        expect(await CryptoVault.verifySignature("payload", sig + "zz")).toBe(false);
        expect(await CryptoVault.verifySignature("payload", sig.slice(0, 62) + "zz")).toBe(false);
        expect(await CryptoVault.verifySignature("payload", sig.slice(0, 63))).toBe(false);
        expect(await CryptoVault.verifySignature("payload", "")).toBe(false);
        expect(await CryptoVault.verifySignature("payload", 5 as unknown as string)).toBe(false);
        expect(await CryptoVault.verifySignature("payload2", sig)).toBe(false);
    });

    it("signData and verifySignature reject empty payloads", async () => {
        const { CryptoVault } = await load();
        await expect(CryptoVault.signData("")).rejects.toThrow(TypeError);
        await expect(CryptoVault.verifySignature("", "a")).rejects.toThrow(TypeError);
    });

    it("a different signing secret invalidates signatures; a short one is refused", async () => {
        const a = await load();
        const sig = await a.CryptoVault.signData("p");
        const b = await load({ DATA_SIGNING_SECRET: "t".repeat(40) });
        expect(await b.CryptoVault.verifySignature("p", sig)).toBe(false);
        const c = await load({ DATA_SIGNING_SECRET: "short" });
        await expect(c.CryptoVault.signData("p")).rejects.toThrow(/DATA_SIGNING_SECRET/);
    });

    it("verifyRowHash handles missing input and non-ASCII length-collision", async () => {
        const { CryptoVault } = await load();
        const good = crypto.createHash("sha256").update("x", "utf8").digest("hex");
        expect(CryptoVault.verifyRowHash("x", good)).toBe(true);
        expect(CryptoVault.verifyRowHash("", good)).toBe(false);
        expect(CryptoVault.verifyRowHash("x", "")).toBe(false);
        expect(CryptoVault.verifyRowHash("x", "é".repeat(64))).toBe(false);
    });
});

describe("CryptoVault - SymmetricCrypto engine", () => {
    it("encryptText/decryptText round-trip and are null-safe", async () => {
        const { SymmetricCrypto, CryptoVault } = await load();
        const h = SymmetricCrypto.SecurityCryptHelper;
        const c = h.encryptText("hello");
        expect(c).toBeTypeOf("string");
        expect(h.decryptText(c)).toBe("hello");
        expect(h.decryptText(null)).toBeNull();
        expect(h.decryptText("%%%notbase64")).toBeNull();
        expect(h.generateCodeID("X")).toMatch(/^X-.{8}$/);
        expect(CryptoVault.symmetric).toBe(SymmetricCrypto);
    });

    it("a short PASSWORD_KEY is padded, and a different key cannot decrypt", async () => {
        const a = await load({ PASSWORD_KEY: "ab" });
        const c = a.SymmetricCrypto.SecurityCryptHelper.encryptText("hello");
        expect(a.SymmetricCrypto.SecurityCryptHelper.decryptText(c)).toBe("hello");
        process.env.PASSWORD_KEY = "zzzzzzzz";
        expect(a.SymmetricCrypto.SecurityCryptHelper.decryptText(c)).not.toBe("hello");
        delete process.env.PASSWORD_KEY;
        expect(a.SymmetricCrypto.SecurityCryptHelper.decryptText(c)).toBeNull();
    });

    it("Encryptor/Decryptor round-trip AES at 16/24/32 byte keys and TripleDES at 16/24", async () => {
        const { SymmetricCrypto: S } = await load();
        const E = S.EncryptionAlgorithm;
        const cases: [number, number, number][] = [
            [E.Rijndael, 16, 16],
            [E.Rijndael, 24, 16],
            [E.Rijndael, 32, 16],
            [E.TripleDes, 16, 8],
            [E.TripleDes, 24, 8],
        ];
        for (const [alg, keyLen, ivLen] of cases) {
            const key = crypto.randomBytes(keyLen);
            const iv = crypto.randomBytes(ivLen);
            const enc = new S.Encryptor(alg);
            enc.IV = iv;
            const ct = enc.encrypt(Buffer.from("data"), key);
            const dec = new S.Decryptor(alg);
            dec.IV = iv;
            expect(dec.decrypt(ct, key).toString()).toBe("data");
        }
    });

    it("generates a random key and IV when none are supplied", async () => {
        const { SymmetricCrypto: S } = await load();
        const enc = new S.Encryptor(S.EncryptionAlgorithm.Rijndael);
        const ct = enc.encrypt(Buffer.from("x"), undefined as unknown as Buffer);
        expect((enc.Key as Buffer).length).toBe(32);
        expect(enc.IV?.length).toBe(16);
        const dec = new S.Decryptor(S.EncryptionAlgorithm.Rijndael);
        dec.IV = enc.IV;
        expect(dec.decrypt(ct, enc.Key as Buffer).toString()).toBe("x");
        const t = new S.EncryptTransformer(S.EncryptionAlgorithm.TripleDes);
        t.IV = null;
        expect(t.IV).toBeNull();
    });

    it("rejects unsupported algorithms and tampered ciphertext", async () => {
        const { SymmetricCrypto: S } = await load();
        const bad = new S.Encryptor(99);
        expect(() => bad.encrypt(Buffer.from("x"), undefined as unknown as Buffer)).toThrow(/not supported/);
        const key = crypto.randomBytes(32);
        const iv = crypto.randomBytes(16);
        const enc = new S.Encryptor(S.EncryptionAlgorithm.Rijndael);
        enc.IV = iv;
        const ct = enc.encrypt(Buffer.from("secret"), key);
        ct[ct.length - 1] ^= 0xff;
        const dec = new S.Decryptor(S.EncryptionAlgorithm.Rijndael);
        dec.IV = iv;
        expect(() => dec.decrypt(ct, key)).toThrow(/writing decrypted data/);
        const noIv = new S.Decryptor(S.EncryptionAlgorithm.Rijndael);
        expect(() => noIv.decrypt(ct, key)).toThrow(/writing decrypted data/);
    });

    it("legacy DES and RC2 either round-trip or fail closed with a wrapped error, per OpenSSL build", async () => {
        const { SymmetricCrypto: S } = await load();
        const ciphers = crypto.getCiphers();
        const cases: [number, string, number, number][] = [
            [S.EncryptionAlgorithm.Des, "des-cbc", 8, 8],
            [S.EncryptionAlgorithm.Rc2, "rc2-cbc", 16, 8],
        ];
        for (const [alg, name, keyLen, ivLen] of cases) {
            const key = crypto.randomBytes(keyLen);
            const iv = crypto.randomBytes(ivLen);
            const enc = new S.Encryptor(alg);
            enc.IV = iv;
            if (ciphers.includes(name)) {
                const ct = enc.encrypt(Buffer.from("d"), key);
                const dec = new S.Decryptor(alg);
                dec.IV = iv;
                expect(dec.decrypt(ct, key).toString()).toBe("d");
            } else {
                expect(() => enc.encrypt(Buffer.from("d"), key)).toThrow(/writing encrypted data/);
            }
            // default-size path (no key supplied) is resolved before the provider is built
            const auto = new S.Encryptor(alg);
            if (ciphers.includes(name)) {
                auto.encrypt(Buffer.from("d"), undefined as unknown as Buffer);
                expect((auto.Key as Buffer).length).toBe(keyLen);
            } else {
                expect(() => auto.encrypt(Buffer.from("d"), undefined as unknown as Buffer)).toThrow(/writing encrypted data/);
            }
        }
    });
});
