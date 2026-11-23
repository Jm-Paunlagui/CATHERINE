import {
    TEMP_PASSWORD_TTL_MS,
    STORED_PASSWORD_MAX_BYTES,
    ALPHABET,
    generateTemporaryPassword,
    wrapTemporaryHash,
    parseStoredAdminPassword,
    isTemporaryExpired,
    temporaryExpiryIso,
} from "../../../../src/utils/encryption/adminTempPassword";

const ARGON = "$argon2id$v=19$m=8192,t=1,p=1$c29tZXNhbHQ$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNo";
const BCRYPT = "$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234";

describe("generateTemporaryPassword", () => {
    it("produces 4 hyphen-joined groups of 4 from the unambiguous alphabet", () => {
        const pw = generateTemporaryPassword();
        expect(pw).toMatch(/^[^-]{4}(-[^-]{4}){3}$/);
        for (const ch of pw.replace(/-/g, "")) expect(ALPHABET).toContain(ch);
        expect(ALPHABET).not.toMatch(/[IOlo01]/);
    });

    it("rejects samples lacking a character class until all three are present", () => {
        // first 16 draws: all index 0 ('A', upper only) -> rejected; then a mixed sample
        const mixed = [0, 25, 50, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        const seq = [...Array(16).fill(0), ...mixed];
        let i = 0;
        const pw = generateTemporaryPassword(() => seq[i++]);
        expect(i).toBe(32);
        expect(pw.replace(/-/g, "")).toMatch(/[A-Z]/);
        expect(pw.replace(/-/g, "")).toMatch(/[a-z]/);
        expect(pw.replace(/-/g, "")).toMatch(/[0-9]/);
    });

    it("never repeats across draws (CSPRNG)", () => {
        const s = new Set(Array.from({ length: 50 }, () => generateTemporaryPassword()));
        expect(s.size).toBe(50);
    });
});

describe("wrapTemporaryHash / parseStoredAdminPassword", () => {
    it("round-trips argon2 and bcrypt, flooring expiry to whole seconds", () => {
        for (const h of [ARGON, BCRYPT]) {
            const w = wrapTemporaryHash(h, 1_700_000_000_999);
            const p = parseStoredAdminPassword(w);
            expect(p).toEqual({ hash: h, temporary: true, expiresAt: 1_700_000_000_000, malformed: false });
        }
    });

    it("refuses to wrap non-strong hashes, bad expiries, and oversized results", () => {
        expect(() => wrapTemporaryHash("plain", 1000)).toThrow(TypeError);
        expect(() => wrapTemporaryHash(5 as unknown as string, 1000)).toThrow(TypeError);
        expect(() => wrapTemporaryHash(ARGON, 0)).toThrow(TypeError);
        expect(() => wrapTemporaryHash(ARGON, NaN)).toThrow(TypeError);
        expect(() => wrapTemporaryHash(ARGON + "x".repeat(STORED_PASSWORD_MAX_BYTES), 1000)).toThrow(RangeError);
    });

    it("passes unmarked values through untouched", () => {
        expect(parseStoredAdminPassword(ARGON)).toEqual({ hash: ARGON, temporary: false, expiresAt: null, malformed: false });
        expect(parseStoredAdminPassword(null as unknown as string)).toEqual({ hash: null, temporary: false, expiresAt: null, malformed: false });
    });

    it.each([
        ["$t$"],
        ["$t$abc"],
        ["$t$abc$plaintext"],
        ["$t$abc" + "TRIPLEDESBASE64=="],
        ["$t$0" + ARGON],
        ["$t$zzzzzzzzzzz" + ARGON],
        ["$t$" + "a".repeat(12) + ARGON],
    ])("marks %s malformed (fail closed)", (v) => {
        expect(parseStoredAdminPassword(v)).toEqual({ hash: null, temporary: true, expiresAt: null, malformed: true });
    });
});

describe("isTemporaryExpired / temporaryExpiryIso", () => {
    it("treats the boundary instant as expired", () => {
        const p = { temporary: true, expiresAt: 1000 };
        expect(isTemporaryExpired(p, 999)).toBe(false);
        expect(isTemporaryExpired(p, 1000)).toBe(true);
    });

    it("non-temporary never expires; temporary without expiry always does", () => {
        expect(isTemporaryExpired({ temporary: false, expiresAt: null }, 1e15)).toBe(false);
        expect(isTemporaryExpired(undefined as unknown as { temporary: boolean; expiresAt: null })).toBe(false);
        expect(isTemporaryExpired({ temporary: true, expiresAt: null }, 0)).toBe(true);
    });

    it("defaults now to the wall clock", () => {
        vi.useFakeTimers();
        vi.setSystemTime(5000);
        expect(isTemporaryExpired({ temporary: true, expiresAt: 4000 })).toBe(true);
        expect(isTemporaryExpired({ temporary: true, expiresAt: 6000 })).toBe(false);
        vi.useRealTimers();
    });

    it("renders ISO for a well-formed marker only", () => {
        const w = wrapTemporaryHash(ARGON, TEMP_PASSWORD_TTL_MS);
        expect(temporaryExpiryIso(w)).toBe(new Date(TEMP_PASSWORD_TTL_MS).toISOString());
        expect(temporaryExpiryIso(ARGON)).toBeNull();
        expect(temporaryExpiryIso("$t$bad")).toBeNull();
    });
});
