import crypto from "crypto";
import { createRequire } from "module";
import { wrapTemporaryHash } from "../../../../src/utils/encryption/adminTempPassword";

// src loads these through its own native require(); spy on that same CJS instance.
const nativeRequire = createRequire(import.meta.url);
const bcrypt = nativeRequire("bcryptjs") as typeof import("bcryptjs");
const argon2 = nativeRequire("argon2") as typeof import("argon2");

type Vault = typeof import("../../../../src/utils/encryption/CryptoVault");

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
    PASSWORD_KEY: "wave2-key",
    DATA_SIGNING_SECRET: "s".repeat(40),
    NODE_ENV: "test",
};

const saved: Record<string, string | undefined> = {};
/** Every instance stays referenced so V8 keeps (and reports) coverage for superseded copies. */
const loaded: Vault[] = [];

/** Fresh module instance: mode/config singletons are cached per instance. */
async function load(env: Record<string, string | undefined> = {}): Promise<Vault> {
    for (const [k, v] of Object.entries({ ...BASE_ENV, ...env })) {
        if (!(k in saved)) saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    vi.resetModules();
    const mod = await import("../../../../src/utils/encryption/CryptoVault");
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

describe("CryptoVault wave2: SymmetricCrypto engine", () => {
    it("round-trips every algorithm and key length the engine maps", async () => {
        const { SymmetricCrypto: S } = await load();
        const A = S.EncryptionAlgorithm;
        const cases: Array<[number, number, number]> = [
            [A.Des, 8, 8],
            [A.Rc2, 16, 8],
            [A.TripleDes, 16, 8],
            [A.TripleDes, 24, 8],
            [A.Rijndael, 16, 16],
            [A.Rijndael, 24, 16],
            [A.Rijndael, 32, 16],
        ];
        for (const [alg, keyLen, ivLen] of cases) {
            const key = crypto.randomBytes(keyLen);
            const iv = crypto.randomBytes(ivLen);
            const enc = new S.Encryptor(alg);
            enc.IV = iv;
            const ct = enc.encrypt(Buffer.from("hello wave2"), key);
            expect(ct.toString()).not.toBe("hello wave2");
            expect(enc.IV).toEqual(iv);
            expect(enc.Key).toEqual(key);
            const dec = new S.Decryptor(alg);
            dec.IV = iv;
            expect(dec.decrypt(ct, key).toString()).toBe("hello wave2");
        }
    });

    it("EncryptTransformer generates a random key and IV when none is supplied", async () => {
        const { SymmetricCrypto: S } = await load();
        const t = new S.EncryptTransformer(S.EncryptionAlgorithm.Rijndael);
        expect(t.IV).toBeNull();
        expect(t.Key).toBeNull();
        const cipher = t.getCryptoServiceProvider(null);
        expect(cipher).toBeDefined();
        expect((t.Key as Buffer).length).toBe(32);
        expect((t.IV as Buffer).length).toBe(16);
        t.IV = Buffer.alloc(16, 1);
        t.getCryptoServiceProvider(undefined);
        expect(t.IV).toEqual(Buffer.alloc(16, 1));
    });

    it("rejects an unsupported algorithm id with a wrapped error", async () => {
        const { SymmetricCrypto: S } = await load();
        const enc = new S.Encryptor(99);
        expect(() => enc.encrypt(Buffer.from("x"), Buffer.alloc(8))).toThrow(/Algorithm ID '99' not supported/);
        const dt = new S.DecryptTransformer(99);
        dt.IV = Buffer.alloc(8);
        expect(() => dt.getCryptoServiceProvider(Buffer.alloc(8))).toThrow(/not supported/);
        const dec = new S.Decryptor(S.EncryptionAlgorithm.Des);
        expect(() => dec.decrypt(Buffer.from("garbage!"), Buffer.alloc(8))).toThrow(/Error while writing decrypted data/);
    });

    it("SecurityCryptHelper round-trips and fails closed without a key or on bad input", async () => {
        const { SymmetricCrypto: S } = await load();
        const H = S.SecurityCryptHelper;
        const ct = H.encryptText("Secret1!");
        expect(ct).toEqual(expect.any(String));
        expect(H.decryptText(ct)).toBe("Secret1!");
        expect(H.decryptText(null)).toBeNull();
        expect(H.decryptText("###not-base64-cipher###")).toBeNull();
        expect(H.decryptText(Buffer.from("short").toString("base64"))).toBeNull();
        delete process.env.PASSWORD_KEY;
        expect(H.encryptText("x")).toBeNull();
        expect(H.decryptText(ct)).toBeNull();
        process.env.PASSWORD_KEY = "ab";
        const short = H.encryptText("pad-key");
        expect(H.decryptText(short)).toBe("pad-key");
    });

    it("generateCodeID is prefixed and random", async () => {
        const { SymmetricCrypto: S } = await load();
        const a = S.SecurityCryptHelper.generateCodeID("USER001");
        const b = S.SecurityCryptHelper.generateCodeID("USER001");
        expect(a).toMatch(/^USER001-.{8}$/);
        expect(a).not.toBe(b);
    });

    it("exposes the engine via CryptoVault.symmetric", async () => {
        const { CryptoVault, SymmetricCrypto } = await load();
        expect(CryptoVault.symmetric).toBe(SymmetricCrypto);
    });
});

describe("CryptoVault wave2: configuration resolution", () => {
    it("rejects an invalid mode, plain in production, and out-of-range numbers", async () => {
        const bad = await load({ PASSWORD_HASH_MODE: "md5" });
        await expect(bad.CryptoVault.hashPassword("x")).rejects.toThrow(/Invalid PASSWORD_HASH_MODE/);
        const prod = await load({ PASSWORD_HASH_MODE: "plain", NODE_ENV: "production" });
        await expect(prod.CryptoVault.hashPassword("x")).rejects.toThrow(/forbidden in production/);
        // The adapter validates at load, so change the setting after load to reach the vault's own check.
        const rounds = await load({ PASSWORD_HASH_MODE: "bcrypt" });
        process.env.BCRYPT_SALT_ROUNDS = "3";
        await expect(rounds.CryptoVault.hashPassword("x")).rejects.toThrow("Password hashing failed.");
        const nan = await load({ PASSWORD_HASH_MODE: "bcrypt" });
        process.env.BCRYPT_SALT_ROUNDS = "abc";
        await expect(nan.CryptoVault.hashPassword("x")).rejects.toThrow("Password hashing failed.");
        const argon = await load({ ARGON2_TIME_COST: "0" });
        await expect(argon.CryptoVault.hashPassword("x")).rejects.toThrow(/ARGON2_TIME_COST must be between/);
        await expect(load({ ARGON2_MAX_PASSWORD_BYTES: "5" })).rejects.toThrow(/ARGON2_MAX_PASSWORD_BYTES/);
    });

    it("defaults bcrypt rounds to 12 when unset", async () => {
        const v = await load({ PASSWORD_HASH_MODE: "bcrypt", BCRYPT_SALT_ROUNDS: undefined });
        expect(v.CryptoVault.config).toEqual({ mode: "bcrypt", saltRounds: 12 });
    });

    it("config snapshot per mode", async () => {
        expect((await load({ PASSWORD_HASH_MODE: "plain" })).CryptoVault.config).toEqual({ mode: "plain" });
        expect((await load({ PASSWORD_HASH_MODE: " TripleDES " })).CryptoVault.config).toEqual({ mode: "tripledes" });
        expect((await load({ PASSWORD_HASH_MODE: "bcrypt" })).CryptoVault.config).toEqual({ mode: "bcrypt", saltRounds: 10 });
        const a = (await load()).CryptoVault.config;
        expect(a).toMatchObject({ mode: "argon2", memoryCost: 8192, timeCost: 1, parallelism: 1, hashLength: 32, maxPasswordBytes: 1024 });
        const dflt = (await load({ PASSWORD_HASH_MODE: undefined })).CryptoVault.config;
        expect(dflt.mode).toBe("argon2");
    });

    it("argon2 refuses to run without a long pepper", async () => {
        const v = await load({ ARGON2_PEPPER: "short" });
        await expect(v.CryptoVault.hashPassword("pw")).rejects.toThrow("Password hashing failed.");
        await expect(v.CryptoVault.verifyPassword("pw", "$argon2id$x")).rejects.toThrow("Password verification failed.");
    });

    it("signing requires DATA_SIGNING_SECRET of 32+ chars", async () => {
        const v = await load({ DATA_SIGNING_SECRET: "tiny" });
        await expect(v.CryptoVault.signData("p")).rejects.toThrow(/DATA_SIGNING_SECRET must be set/);
        const none = await load({ DATA_SIGNING_SECRET: undefined });
        await expect(none.CryptoVault.signRecord("T", { A: 1 })).rejects.toThrow(/DATA_SIGNING_SECRET/);
    });

    it("admin mode resolution: weak global mode needs a strong PASSWORD_ENCRYPTION_MODE", async () => {
        const missing = await load({ PASSWORD_HASH_MODE: "plain" });
        await expect(missing.CryptoVault.hashAdminPassword("pw")).rejects.toThrow(/PASSWORD_ENCRYPTION_MODE is not configured/);
        expect(() => missing.CryptoVault.maxPasswordBytes({ forHash: true })).toThrow(/not configured/);
        const weak = await load({ PASSWORD_HASH_MODE: "tripledes", PASSWORD_ENCRYPTION_MODE: "plain" });
        await expect(weak.CryptoVault.hashAdminPassword("pw")).rejects.toThrow(/is not allowed/);
        const ok = await load({ PASSWORD_HASH_MODE: "plain", PASSWORD_ENCRYPTION_MODE: " BCRYPT " });
        const h = await ok.CryptoVault.hashAdminPassword("pw");
        expect(h.startsWith("$2")).toBe(true);
        expect(ok.CryptoVault.maxPasswordBytes({ forHash: true })).toBe(72);
        expect(ok.CryptoVault.maxPasswordBytes()).toBe(1024);
        const arg = await load();
        expect(arg.CryptoVault.maxPasswordBytes({ forHash: true })).toBe(1024);
    });
});

describe("CryptoVault wave2: hashPassword / verifyPassword by mode", () => {
    it("input validation", async () => {
        const { CryptoVault } = await load({ PASSWORD_HASH_MODE: "plain" });
        await expect(CryptoVault.hashPassword("")).rejects.toThrow(TypeError);
        await expect(CryptoVault.hashPassword(5 as never)).rejects.toThrow(/non-empty string/);
        await expect(CryptoVault.hashPassword("x".repeat(1025))).rejects.toThrow(RangeError);
        await expect(CryptoVault.verifyPassword("pw", "")).rejects.toThrow(/Hashed password must be/);
        await expect(CryptoVault.verifyPassword("pw", 5 as never)).rejects.toThrow(TypeError);
    });

    it("plain mode returns the password and compares exactly", async () => {
        const { CryptoVault } = await load({ PASSWORD_HASH_MODE: "plain" });
        expect(await CryptoVault.hashPassword("pw")).toBe("pw");
        expect(await CryptoVault.verifyPassword("pw", "pw")).toBe(true);
        expect(await CryptoVault.verifyPassword("pw", "PW")).toBe(false);
    });

    it("tripledes mode encrypts, verifies, and refuses a wrong password; encryption failure throws", async () => {
        const { CryptoVault } = await load({ PASSWORD_HASH_MODE: "tripledes" });
        const h = await CryptoVault.hashPassword("Pa55word");
        expect(h).not.toBe("Pa55word");
        expect(await CryptoVault.verifyPassword("Pa55word", h)).toBe(true);
        expect(await CryptoVault.verifyPassword("other", h)).toBe(false);
        expect(await CryptoVault.verifyPassword("Pa55word", "@@@@")).toBe(false);
        delete process.env.PASSWORD_KEY;
        await expect(CryptoVault.hashPassword("Pa55word")).rejects.toThrow(/TripleDES encryption failed/);
    });

    it("bcrypt mode: hash, verify, wrong password, and error funnelling", async () => {
        const { CryptoVault } = await load({ PASSWORD_HASH_MODE: "bcrypt" });
        const h = await CryptoVault.hashPassword("Pa55word");
        expect(h).toMatch(/^\$2[ab]\$10\$/);
        expect(await CryptoVault.verifyPassword("Pa55word", h)).toBe(true);
        expect(await CryptoVault.verifyPassword("nope", h)).toBe(false);
        vi.spyOn(bcrypt, "hash").mockRejectedValueOnce(new Error("internal secret detail"));
        await expect(CryptoVault.hashPassword("pw")).rejects.toThrow("Password hashing failed.");
        vi.spyOn(bcrypt, "compare").mockRejectedValueOnce(new Error("internal secret detail"));
        await expect(CryptoVault.verifyPassword("pw", h)).rejects.toThrow("Password verification failed.");
    });

    it("argon2 mode: hash, verify, legacy-bcrypt acceptance, and sanitized errors", async () => {
        const { CryptoVault } = await load();
        const h = await CryptoVault.hashPassword("Pa55word");
        expect(h.startsWith("$argon2id$")).toBe(true);
        expect(await CryptoVault.verifyPassword("Pa55word", h)).toBe(true);
        expect(await CryptoVault.verifyPassword("nope", h)).toBe(false);
        const legacy = await bcrypt.hash("Pa55word", 4);
        expect(await CryptoVault.verifyPassword("Pa55word", legacy)).toBe(true);
        vi.spyOn(argon2, "hash").mockRejectedValueOnce(new Error("leak"));
        await expect(CryptoVault.hashPassword("pw")).rejects.toThrow("Password hashing failed.");
        vi.spyOn(argon2, "verify").mockRejectedValueOnce(new Error("leak"));
        await expect(CryptoVault.verifyPassword("pw", h)).rejects.toThrow("Password verification failed.");
    });

    it("a malformed argon2 string is an error, never a match", async () => {
        const { CryptoVault } = await load();
        await expect(CryptoVault.verifyPassword("pw", "$argon2id$garbage")).rejects.toThrow("Password verification failed.");
    });
});

describe("CryptoVault wave2: admin password paths", () => {
    it("argon2 admin hash round trip and error sanitising", async () => {
        const { CryptoVault } = await load();
        const h = await CryptoVault.hashAdminPassword("Adm1nPass!");
        expect(h.startsWith("$argon2id$")).toBe(true);
        expect(await CryptoVault.verifyAdminPassword("Adm1nPass!", h)).toEqual({ matched: true, newHash: null });
        expect(await CryptoVault.verifyAdminPassword("wrong", h)).toEqual({ matched: false, newHash: null });
        vi.spyOn(argon2, "hash").mockRejectedValueOnce(new Error("x"));
        await expect(CryptoVault.hashAdminPassword("pw")).rejects.toThrow("Admin password hashing failed.");
        vi.spyOn(argon2, "verify").mockRejectedValueOnce(new Error("x"));
        await expect(CryptoVault.verifyAdminPassword("pw", h)).rejects.toThrow("Admin password verification failed.");
    });

    it("bcrypt admin mode enforces the 72-byte limit on hash and verify, and sanitises errors", async () => {
        const { CryptoVault } = await load({ PASSWORD_HASH_MODE: "bcrypt" });
        const long = "a".repeat(73);
        await expect(CryptoVault.hashAdminPassword(long)).rejects.toThrow(/72-byte limit/);
        const h = await CryptoVault.hashAdminPassword("Adm1nPass!");
        expect(await CryptoVault.verifyAdminPassword("Adm1nPass!", h)).toEqual({ matched: true, newHash: null });
        expect(await CryptoVault.verifyAdminPassword(long, h)).toEqual({ matched: false, newHash: null });
        vi.spyOn(bcrypt, "hash").mockRejectedValueOnce(new Error("x"));
        await expect(CryptoVault.hashAdminPassword("pw")).rejects.toThrow("Admin password hashing failed.");
        vi.spyOn(bcrypt, "compare").mockRejectedValueOnce(new Error("x"));
        await expect(CryptoVault.verifyAdminPassword("pw", h)).rejects.toThrow("Admin password verification failed.");
    });

    it("verifyAdminPassword validates its inputs", async () => {
        const { CryptoVault } = await load();
        await expect(CryptoVault.verifyAdminPassword("", "h")).rejects.toThrow(TypeError);
        await expect(CryptoVault.verifyAdminPassword("pw", "")).rejects.toThrow(/Stored admin hash/);
        await expect(CryptoVault.verifyAdminPassword("pw", null as never)).rejects.toThrow(TypeError);
    });

    it("legacy TripleDES admin hash is matched once and upgraded to a strong hash", async () => {
        const { CryptoVault, SymmetricCrypto } = await load();
        const legacy = SymmetricCrypto.SecurityCryptHelper.encryptText("Adm1nPass!") as string;
        const ok = await CryptoVault.verifyAdminPassword("Adm1nPass!", legacy);
        expect(ok.matched).toBe(true);
        expect(ok.newHash).toMatch(/^\$argon2id\$/);
        expect(await CryptoVault.verifyAdminPassword("Adm1nPass!", ok.newHash as string)).toMatchObject({ matched: true });
        expect(await CryptoVault.verifyAdminPassword("wrong", legacy)).toEqual({ matched: false, newHash: null });
        expect(await CryptoVault.verifyAdminPassword("x", "###")).toEqual({ matched: false, newHash: null });
    });

    it("temporary password markers: valid, expired, wrong password and malformed", async () => {
        const { CryptoVault } = await load();
        const inner = await CryptoVault.hashAdminPassword("TempPass#1");
        const future = Date.now() + 3_600_000;
        const past = Date.now() - 3_600_000;
        const stored = (exp: number) => wrapTemporaryHash(inner, exp);
        const good = await CryptoVault.verifyAdminPassword("TempPass#1", stored(future));
        expect(good).toMatchObject({ matched: true, newHash: null, temporary: true, expired: false });
        const exp = await CryptoVault.verifyAdminPassword("TempPass#1", stored(past));
        expect(exp).toMatchObject({ matched: false, temporary: true, expired: true });
        const wrong = await CryptoVault.verifyAdminPassword("nope", stored(future));
        expect(wrong).toEqual({ matched: false, newHash: null, temporary: true, expired: false, expiresAt: null });
        const malformed = await CryptoVault.verifyAdminPassword("TempPass#1", "$t$!bad" + inner);
        expect(malformed).toEqual({ matched: false, newHash: null, temporary: true, expired: false, expiresAt: null });
    });

    it("adminNeedsRehash flags empty, legacy and weaker-argon2 hashes only", async () => {
        const { CryptoVault } = await load();
        expect(CryptoVault.adminNeedsRehash("")).toBe(true);
        expect(CryptoVault.adminNeedsRehash("TOcbase64==")).toBe(true);
        const bc = await bcrypt.hash("pw", 4);
        expect(CryptoVault.adminNeedsRehash(bc)).toBe(false);
        const current = await CryptoVault.hashAdminPassword("pw");
        expect(CryptoVault.adminNeedsRehash(current)).toBe(false);
        const weaker = await argon2.hash("pw", { type: argon2.argon2id, memoryCost: 8192, timeCost: 1, parallelism: 1 });
        const strong = await load({ ARGON2_MEMORY_COST: "16384" });
        expect(strong.CryptoVault.adminNeedsRehash(weaker)).toBe(true);
        expect(CryptoVault.adminNeedsRehash("$argon2id$broken")).toBe(false);
    });
});

describe("CryptoVault wave2: needsRehash and migrateFromBcrypt", () => {
    it("needsRehash is argon2-mode only and treats foreign hashes as stale", async () => {
        const bcryptMode = await load({ PASSWORD_HASH_MODE: "bcrypt" });
        expect(bcryptMode.CryptoVault.needsRehash("$argon2id$x")).toBe(false);
        const { CryptoVault } = await load();
        expect(CryptoVault.needsRehash(undefined as never)).toBe(false);
        expect(CryptoVault.needsRehash("")).toBe(false);
        expect(CryptoVault.needsRehash("$2b$10$abcdefghijklmnopqrstuv")).toBe(true);
        expect(CryptoVault.needsRehash("$argon2id$not-parseable")).toBe(true);
        const cur = await CryptoVault.hashPassword("pw");
        expect(CryptoVault.needsRehash(cur)).toBe(false);
        const weaker = await argon2.hash("pw", { type: argon2.argon2id, memoryCost: 8192, timeCost: 1, parallelism: 1 });
        const strong = await load({ ARGON2_MEMORY_COST: "16384" });
        expect(strong.CryptoVault.needsRehash(weaker)).toBe(true);
    });

    it("migrateFromBcrypt verifies the legacy hash before minting an argon2 hash", async () => {
        const { CryptoVault } = await load();
        const legacy = await bcrypt.hash("Pa55word", 4);
        await expect(CryptoVault.migrateFromBcrypt("", legacy)).rejects.toThrow(TypeError);
        await expect(CryptoVault.migrateFromBcrypt("pw", "$argon2id$x")).rejects.toThrow(/does not appear to be a bcrypt hash/);
        expect(await CryptoVault.migrateFromBcrypt("a".repeat(73), legacy)).toEqual({ matched: false, argon2Hash: null, requiresReset: true });
        expect(await CryptoVault.migrateFromBcrypt("wrong", legacy)).toEqual({ matched: false, argon2Hash: null });
        const r = await CryptoVault.migrateFromBcrypt("Pa55word", legacy);
        expect(r.matched).toBe(true);
        expect(r.argon2Hash).toMatch(/^\$argon2id\$/);
    });
});

describe("CryptoVault wave2: standalone adapters", () => {
    it("Argon2Adapter delegates to the vault", async () => {
        const { Argon2Adapter } = await load();
        const h = await Argon2Adapter.hashPassword("Pa55word");
        expect(await Argon2Adapter.verifyPassword("Pa55word", h)).toBe(true);
        expect(Argon2Adapter.needsRehash(h)).toBe(false);
        expect(Argon2Adapter.config.mode).toBe("argon2");
        const legacy = await bcrypt.hash("Pa55word", 4);
        expect((await Argon2Adapter.migrateFromBcrypt("Pa55word", legacy)).matched).toBe(true);
    });

    it("BCryptAdapter hashes, verifies, validates and sanitises errors", async () => {
        const { BCryptAdapter } = await load();
        expect(BCryptAdapter.saltRounds).toBe(10);
        const h = await BCryptAdapter.hashPassword("Pa55word");
        expect(await BCryptAdapter.verifyPassword("Pa55word", h)).toBe(true);
        expect(await BCryptAdapter.verifyPassword("bad", h)).toBe(false);
        await expect(BCryptAdapter.hashPassword("")).rejects.toThrow(/Password must be/);
        await expect(BCryptAdapter.verifyPassword("", h)).rejects.toThrow(/Password must be/);
        await expect(BCryptAdapter.verifyPassword("pw", "")).rejects.toThrow(/Hashed password must be/);
        vi.spyOn(bcrypt, "hash").mockRejectedValueOnce(new Error("x"));
        await expect(BCryptAdapter.hashPassword("pw")).rejects.toThrow("Password hashing failed.");
        vi.spyOn(bcrypt, "compare").mockRejectedValueOnce(new Error("x"));
        await expect(BCryptAdapter.verifyPassword("pw", h)).rejects.toThrow("Password verification failed.");
    });

    it("BCryptAdapter defaults rounds and rejects an out-of-range setting at load", async () => {
        const d = await load({ BCRYPT_SALT_ROUNDS: undefined });
        expect(d.BCryptAdapter.saltRounds).toBe(12);
        await expect(load({ BCRYPT_SALT_ROUNDS: "99" })).rejects.toThrow(/BCRYPT_SALT_ROUNDS must be/);
    });
});

describe("CryptoVault wave2: data signing", () => {
    it("buildPayload is canonical, escapes pipes and validates input", async () => {
        const { CryptoVault } = await load();
        expect(CryptoVault.buildPayload("T", { B: 2, A: "x|y" })).toBe("T:A=x||y|B=2");
        expect(() => CryptoVault.buildPayload("", {})).toThrow(/context/);
        expect(() => CryptoVault.buildPayload("T", null as never)).toThrow(/plain object/);
        expect(() => CryptoVault.buildPayload("T", [] as never)).toThrow(/plain object/);
    });

    it("sign / verify round trip, tamper detection and malformed signatures", async () => {
        const { CryptoVault } = await load();
        await expect(CryptoVault.signData("")).rejects.toThrow(/payload must be/);
        await expect(CryptoVault.verifySignature("", "x")).rejects.toThrow(/payload must be/);
        const sig = await CryptoVault.signData("payload");
        expect(sig).toMatch(/^[0-9a-f]{64}$/);
        expect(await CryptoVault.verifySignature("payload", sig)).toBe(true);
        expect(await CryptoVault.verifySignature("payload!", sig)).toBe(false);
        expect(await CryptoVault.verifySignature("payload", "")).toBe(false);
        expect(await CryptoVault.verifySignature("payload", 5 as never)).toBe(false);
        expect(await CryptoVault.verifySignature("payload", sig + "zz")).toBe(false);
        expect(await CryptoVault.verifySignature("payload", sig.slice(0, 62) + "zz")).toBe(false);
        expect(await CryptoVault.verifySignature("payload", sig.slice(0, 10))).toBe(false);
        expect(await CryptoVault.verifySignature("payload", sig.toUpperCase())).toBe(true);
    });

    it("signRecord / verifyRecord detect any field change and cross-context replay", async () => {
        const { CryptoVault } = await load();
        const fields = { USERNAME: "u", ROLE: "ADMIN" };
        const sig = await CryptoVault.signRecord("T_ADMINS_DEV", fields);
        expect(await CryptoVault.verifyRecord("T_ADMINS_DEV", { ROLE: "ADMIN", USERNAME: "u" }, sig)).toBe(true);
        expect(await CryptoVault.verifyRecord("T_ADMINS_DEV", { ...fields, ROLE: "SUPER" }, sig)).toBe(false);
        expect(await CryptoVault.verifyRecord("T_OTHER", fields, sig)).toBe(false);
        expect(await CryptoVault.verifyRecord("T_ADMINS_DEV", fields, null)).toBe(false);
        expect(await CryptoVault.verifyRecord("T_ADMINS_DEV", fields, undefined)).toBe(false);
    });
});
