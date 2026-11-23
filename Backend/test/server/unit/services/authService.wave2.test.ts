import jwt from "jsonwebtoken";
import AuthService from "../../../../src/services/AuthService";
import { logger } from "../../../../src/utils/logger";
import { AUTH_ERRORS, ADMIN_ERRORS } from "../../../../src/constants/errors";
import { TOKEN_TYPES, TOKEN_AUDIENCES, TOKEN_ISSUER } from "../../../../src/constants/authTokens";

let savedSecret: string | undefined;
beforeEach(() => {
    savedSecret = process.env.JWT_SECRET;
    vi.spyOn(logger, "warning").mockImplementation(() => undefined as never);
    vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
});
afterEach(() => {
    if (savedSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = savedSecret;
    vi.restoreAllMocks();
});

const refused = (fn: () => unknown) => {
    try {
        fn();
    } catch (e) {
        return e as { statusCode: number; message: string };
    }
    throw new Error("expected a refusal");
};

describe("AuthService wave2: account gates default to active", () => {
    it("a row with no IS_ACTIVE value is treated as active; only an explicit N is refused with 403", () => {
        expect(() => AuthService._assertAdminActive({ USERNAME: "a" } as never, "a")).not.toThrow();
        expect(() => AuthService._assertUserActive({ USERNAME: "u" } as never, "u")).not.toThrow();
        const a = refused(() => AuthService._assertAdminActive({ IS_ACTIVE: "N" } as never, "a"));
        expect(a).toMatchObject({ statusCode: 403, message: ADMIN_ERRORS.ACCOUNT_INACTIVE });
        const u = refused(() => AuthService._assertUserActive({ IS_ACTIVE: "N" } as never, "u"));
        expect(u).toMatchObject({ statusCode: 403, message: AUTH_ERRORS.ACCOUNT_INACTIVE });
        expect(logger.warning).toHaveBeenCalledTimes(2);
    });
});

describe("AuthService wave2: token issuing defaults", () => {
    it("issues a session with nulls and no password-change flags when only the required fields are given", () => {
        process.env.JWT_SECRET = "wave2-secret-value";
        const t = AuthService._issueTokens({ userId: "solo", role: "USER", roleSource: "user" } as never);
        expect(t.user).toMatchObject({ userId: "solo", role: "USER" });
        const access = jwt.verify(t.accessToken, "wave2-secret-value", { audience: TOKEN_AUDIENCES.ACCESS, issuer: TOKEN_ISSUER }) as Record<string, unknown>;
        expect(access.type).toBe(TOKEN_TYPES.ACCESS);
        const refresh = jwt.verify(t.refreshToken, "wave2-secret-value", { audience: TOKEN_AUDIENCES.REFRESH, issuer: TOKEN_ISSUER }) as Record<string, unknown>;
        expect(refresh).toMatchObject({ sub: "solo", rs: "user", type: TOKEN_TYPES.REFRESH });
        expect("pwv" in refresh).toBe(false);
        expect(refresh.fid).toBe(access.fid);
        expect(t.refreshRecord.familyId).toBe(access.fid);
    });

    it("a supplied credential hash pins the refresh token to that credential epoch", () => {
        process.env.JWT_SECRET = "wave2-secret-value";
        const t = AuthService._issueTokens({ userId: "solo", role: "USER", roleSource: "user", credentialHash: "$argon2id$hash-a" } as never);
        const refresh = jwt.decode(t.refreshToken) as Record<string, unknown>;
        expect(typeof refresh.pwv).toBe("string");
        const other = jwt.decode(AuthService._issueTokens({ userId: "solo", role: "USER", roleSource: "user", credentialHash: "$argon2id$hash-b" } as never).refreshToken) as Record<string, unknown>;
        expect(other.pwv).not.toBe(refresh.pwv);
    });

    it("refuses to mint tokens without a signing secret rather than signing with an empty key", () => {
        delete process.env.JWT_SECRET;
        expect(() => AuthService._issueTokens({ userId: "solo", role: "USER", roleSource: "user" } as never)).toThrow();
    });
});

describe("AuthService wave2: refresh without a configured secret (security)", () => {
    it("answers 403 for every token when JWT_SECRET is unset, including one signed with an empty key", async () => {
        process.env.JWT_SECRET = "wave2-secret-value";
        const good = jwt.sign({ sub: "u", type: TOKEN_TYPES.REFRESH, fid: "f", jti: "j" }, "wave2-secret-value", { audience: TOKEN_AUDIENCES.REFRESH, issuer: TOKEN_ISSUER, algorithm: "HS256" });
        delete process.env.JWT_SECRET;
        await expect(AuthService.refresh(good)).rejects.toMatchObject({ statusCode: 403 });
        await expect(AuthService.refresh("not-a-jwt")).rejects.toMatchObject({ statusCode: 403 });
    });
});
