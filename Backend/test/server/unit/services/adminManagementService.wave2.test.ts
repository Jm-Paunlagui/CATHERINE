import AdminManagementService from "../../../../src/services/AdminManagementService";
import AdminModel from "../../../../src/models/admin.model";
import UserModel from "../../../../src/models/user.model";
import { logger } from "../../../../src/utils/logger";
import { ADMIN_ERRORS } from "../../../../src/constants/errors";

const AMS = AdminManagementService;

beforeEach(() => {
    for (const lvl of ["info", "warning", "security"] as const) {
        vi.spyOn(logger, lvl).mockImplementation(() => undefined as never);
    }
});
afterEach(() => {
    vi.restoreAllMocks();
});

const denied = (fn: () => unknown) => {
    try {
        fn();
    } catch (e) {
        return e as { statusCode: number; message: string };
    }
    throw new Error("expected a refusal");
};

describe("AdminManagementService wave2: role policy defaults (security)", () => {
    it("an ADMIN is refused create / reset with no context supplied (fail closed)", () => {
        const create = denied(() => AMS._assertCanManage({ username: "alice", role: "ADMIN" }, "create"));
        expect(create.statusCode).toBe(403);
        expect(create.message).toBe(ADMIN_ERRORS.ADMIN_CREATE_USER_ONLY);
        const reset = denied(() => AMS._assertCanManage({ username: "alice", role: "ADMIN" }, "resetPassword"));
        expect(reset.message).toBe(ADMIN_ERRORS.ADMIN_RESET_USER_ONLY);
    });

    it("an unknown action gets the generic refusal even for an ADMIN, and the denial is audited", () => {
        const e = denied(() => AMS._assertCanManage({ username: "alice", role: "ADMIN" }, "bogus" as never, { target: "x" }));
        expect(e.statusCode).toBe(403);
        expect(e.message).toBe(ADMIN_ERRORS.ROLE_ACTION_FORBIDDEN);
        expect(logger.security).toHaveBeenCalledWith("ADMIN_ROLE_POLICY_DENIED", { action: "bogus", callerRole: "ADMIN", targetRole: null, newRole: null });
    });

    it("a caller without a role is refused and logged as unknown", () => {
        const e = denied(() => AMS._assertCanManage({ username: "ghost", role: undefined }, "changeRole"));
        expect(e.statusCode).toBe(403);
        denied(() => AMS._assertCanManage(null, "create"));
        expect((logger.warning as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toContain("unknown");
    });
});

describe("AdminManagementService wave2: notification channel flags", () => {
    it("maps only the supplied keys, Y stays Y and anything else becomes N", () => {
        expect(AMS._notifyChannelFlags({})).toEqual({});
        expect(AMS._notifyChannelFlags({ canReceiveSrvCrit: "Y", canReceiveSrvDeps: "N", canReceiveSrvRed: "maybe", isActive: "Y" })).toEqual({
            "server-critical-notification": "Y",
            "server-dependencies-notification": "N",
            "server-red-metrics-notification": "N",
        });
    });
});

describe("AdminManagementService wave2: last-SUPER_ADMIN guard", () => {
    it("takes no lock for a non-super or inactive super admin, but guards an active one (default IS_ACTIVE counts as active)", async () => {
        const guard = vi.spyOn(AdminModel, "withLastSuperAdminGuard").mockImplementation(async (_id, fn) => fn({} as never));
        const fn = vi.fn().mockResolvedValue("done");
        expect(await AMS._withSuperAdminGuard({ ID: 1, ROLE: "ADMIN", IS_ACTIVE: "Y" } as never, fn)).toBe("done");
        expect(await AMS._withSuperAdminGuard({ ID: 2, ROLE: "SUPER_ADMIN", IS_ACTIVE: "N" } as never, fn)).toBe("done");
        expect(guard).not.toHaveBeenCalled();
        expect(fn).toHaveBeenNthCalledWith(1, null);
        expect(fn).toHaveBeenNthCalledWith(2, null);
        expect(await AMS._withSuperAdminGuard({ ID: 3, ROLE: "SUPER_ADMIN" } as never, fn)).toBe("done");
        expect(guard).toHaveBeenCalledWith(3, fn);
    });
});

describe("AdminManagementService wave2: account search tolerates sparse rows", () => {
    it("matches on any one name field while others are null or missing", async () => {
        vi.spyOn(UserModel, "findAll").mockResolvedValue([
            { USERNAME: "u1", FIRST_NAME: null, LAST_NAME: "Zeta" },
            { USERNAME: "u2", FIRST_NAME: undefined, LAST_NAME: undefined },
            { USERNAME: null, FIRST_NAME: "Zed", LAST_NAME: null },
        ] as never);
        vi.spyOn(AdminModel, "search").mockResolvedValue([]);
        vi.spyOn(AdminModel, "findByUsernames").mockResolvedValue([]);
        const rows = await AMS.searchAccounts("  ZE ");
        expect(rows.map((r) => r.username)).toEqual(["u1", null]);
        expect(rows.every((r) => r.isAdmin === false)).toBe(true);
    });
});
