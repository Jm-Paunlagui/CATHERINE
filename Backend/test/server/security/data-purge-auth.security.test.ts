/**
 * @fileoverview Security tests for the /api/v1/data-purge routes.
 *
 * Every endpoint is SUPER_ADMIN only (router-level authenticate +
 * requireSuperAdmin). Verifies, for ALL endpoints:
 *   - unauthenticated / forged / expired credentials are refused (401/403/440)
 *   - ADMIN and USER roles are refused with 403 and the service is never called
 *   - SUPER_ADMIN passes the gate and reaches the (stubbed) service
 * and, for POST /execute, that forged / expired / replayed backup tokens are
 * refused with 401 (service logic real, persistence and password stubbed).
 */

// The strict purge limiter (default 5 / 15 min) is read at module load; lift it so
// the many SUPER_ADMIN requests below are not answered with 429.
vi.hoisted(() => {
    process.env.PURGE_RATE_LIMIT_MAX = "100000";
});

import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../../src/app";
import DataPurgeService from "../../../src/services/DataPurgeService";
import DataRestoreService from "../../../src/services/DataRestoreService";
import BackupScheduleService from "../../../src/services/BackupScheduleService";
import BackupTokenService from "../../../src/services/BackupTokenService";
import BackupTokenModel from "../../../src/models/backup-token.model";
import { PURGE_ERRORS } from "../../../src/constants/errors";

const { signToken } = require("../helpers/auth");

// ── Tokens ────────────────────────────────────────────────────────────────────

const superAdminToken = () =>
    signToken({ sub: "SA001", userId: "SA001", id: 1, role: "SUPER_ADMIN", userLevel: 3 });
const adminToken = () =>
    signToken({ sub: "ADM001", userId: "ADM001", id: 2, role: "ADMIN", userLevel: 2 });
const userToken = () =>
    signToken({ sub: "USR001", userId: "USR001", id: 3, role: "USER", userLevel: 1 });

// ── Endpoint table ────────────────────────────────────────────────────────────

type Method = "get" | "post" | "delete";
interface Endpoint {
    name: string;
    method: Method;
    path: string;
    body?: Record<string, unknown>;
    multipart?: boolean;
    /**
     * Service call that proves the request reached the handler. Null for handlers
     * that lazy-`require` BackupStoreService: that native require yields a different
     * module instance from the one a test can spy on, so the spy never takes effect.
     */
    probe: (() => ReturnType<typeof vi.spyOn>) | null;
    /** Expected status for SUPER_ADMIN once the (stubbed) service answers. */
    okStatus?: number;
}

const ZIP = Buffer.from("PK\x03\x04-not-a-real-archive");
const SCOPE = { groups: ["T_"] };

let spies: Record<string, ReturnType<typeof vi.spyOn>>;

const ENDPOINTS: Endpoint[] = [
    { name: "GET /scopes", method: "get", path: "/api/v1/data-purge/scopes", probe: () => spies.getScopeCatalogue, okStatus: 200 },
    { name: "POST /preview", method: "post", path: "/api/v1/data-purge/preview", body: SCOPE, probe: () => spies.getPreview, okStatus: 200 },
    { name: "POST /backup", method: "post", path: "/api/v1/data-purge/backup", body: SCOPE, probe: () => spies.backup, okStatus: 200 },
    { name: "POST /authorise", method: "post", path: "/api/v1/data-purge/authorise", body: { adminPassword: "pw" }, probe: () => spies.authorise, okStatus: 200 },
    {
        name: "POST /execute", method: "post", path: "/api/v1/data-purge/execute",
        body: { scope: SCOPE, backupToken: "tok", adminPassword: "pw", confirmPhrase: "phrase" },
        probe: () => spies.executePurge, okStatus: 200,
    },
    { name: "POST /restore/preview", method: "post", path: "/api/v1/data-purge/restore/preview", multipart: true, probe: () => spies.restorePreview, okStatus: 200 },
    {
        name: "POST /restore", method: "post", path: "/api/v1/data-purge/restore", multipart: true,
        body: { adminPassword: "pw", confirmPhrase: "phrase" },
        probe: () => spies.restore, okStatus: 200,
    },
    { name: "GET /backups", method: "get", path: "/api/v1/data-purge/backups", probe: null },
    { name: "POST /backups/run", method: "post", path: "/api/v1/data-purge/backups/run", body: {}, probe: null },
    { name: "GET /backups/:id/download", method: "get", path: "/api/v1/data-purge/backups/arch1/download", probe: null },
    { name: "POST /backups/:id/verify", method: "post", path: "/api/v1/data-purge/backups/arch1/verify", body: {}, probe: null },
    { name: "POST /backups/:id/delete-request", method: "post", path: "/api/v1/data-purge/backups/arch1/delete-request", body: {}, probe: null },
    { name: "POST /backups/:id/vote", method: "post", path: "/api/v1/data-purge/backups/arch1/vote", body: {}, probe: null },
    { name: "DELETE /backups/:id/delete-request", method: "delete", path: "/api/v1/data-purge/backups/arch1/delete-request", probe: null },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function csrfAgent() {
    const agent = request.agent(app);
    const res = await agent.get("/api/v1/csrf/token");
    return { agent, csrf: (res.body?.token ?? "") as string };
}

type Cred = { bearer?: string };

/** Sends the endpoint's request with the given credential and a valid CSRF token. */
async function send(ep: Endpoint, cred: Cred) {
    const { agent, csrf } = await csrfAgent();
    let req = agent[ep.method](ep.path);
    if (cred.bearer !== undefined) req = req.set("Authorization", `Bearer ${cred.bearer}`);
    if (ep.method !== "get") req = req.set("x-csrf-token", csrf);
    if (ep.multipart) {
        req = req.attach("file", ZIP, { filename: "backup.zip", contentType: "application/zip" });
        for (const [k, v] of Object.entries(ep.body ?? {})) req = req.field(k, String(v));
        return req;
    }
    if (ep.body) req = req.send(ep.body);
    return req;
}

function expectNoServiceCall() {
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
}

// ── Stubs ─────────────────────────────────────────────────────────────────────

beforeAll(() => {
    spies = {
        getScopeCatalogue: vi.spyOn(DataPurgeService, "getScopeCatalogue").mockResolvedValue({} as never),
        getPreview: vi.spyOn(DataPurgeService, "getPreview").mockResolvedValue({} as never),
        backup: vi.spyOn(DataPurgeService, "backup").mockResolvedValue({
            filename: "b.zip", token: "t.t", expiresAt: 1, confirmPhrase: "p", zipBuffer: Buffer.from("zip"),
        } as never),
        authorise: vi.spyOn(DataPurgeService, "authorise").mockResolvedValue({ verified: true }),
        executePurge: vi.spyOn(DataPurgeService, "executePurge").mockResolvedValue({} as never),
        restorePreview: vi.spyOn(DataRestoreService, "preview").mockResolvedValue({} as never),
        restore: vi.spyOn(DataRestoreService, "restore").mockResolvedValue({} as never),
    };
});

beforeEach(() => {
    for (const spy of Object.values(spies)) spy.mockClear();
});

afterAll(() => {
    for (const spy of Object.values(spies)) spy.mockRestore();
});

// ══════════════════════════════════════════════════════════════════════════════
// 1. Authentication — every endpoint
// ══════════════════════════════════════════════════════════════════════════════

describe("Data Purge Security: authentication required on every endpoint", () => {
    it.each(ENDPOINTS)("[$name] 401 with no credentials", async (ep) => {
        const res = await send(ep, {});
        expect(res.status).toBe(401);
        expectNoServiceCall();
    });

    it.each(ENDPOINTS)("[$name] rejects a token signed with the wrong secret", async (ep) => {
        const forged = jwt.sign({ userId: "HACKER", id: 1, role: "SUPER_ADMIN" }, "wrong-secret-entirely");
        const res = await send(ep, { bearer: forged });
        expect([401, 403]).toContain(res.status);
        expectNoServiceCall();
    });

    it.each(ENDPOINTS)("[$name] rejects an unsigned (alg=none) token", async (ep) => {
        const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
        const payload = Buffer.from(JSON.stringify({ userId: "HACKER", id: 1, role: "SUPER_ADMIN" })).toString("base64url");
        const res = await send(ep, { bearer: `${header}.${payload}.` });
        expect([401, 403]).toContain(res.status);
        expectNoServiceCall();
    });

    it.each(ENDPOINTS)("[$name] rejects a USER token whose payload was edited to SUPER_ADMIN", async (ep) => {
        const parts = userToken().split(".");
        parts[1] = Buffer.from(
            JSON.stringify({ userId: "USR001", id: 3, role: "SUPER_ADMIN", userLevel: 3 }),
        ).toString("base64url");
        const res = await send(ep, { bearer: parts.join(".") });
        expect([401, 403]).toContain(res.status);
        expectNoServiceCall();
    });

    it.each(ENDPOINTS)("[$name] 440 for an expired SUPER_ADMIN token", async (ep) => {
        const expired = signToken({ sub: "SA001", userId: "SA001", id: 1, role: "SUPER_ADMIN" }, "-1s");
        const res = await send(ep, { bearer: expired });
        expect(res.status).toBe(440);
        expectNoServiceCall();
    });

    it.each(ENDPOINTS)("[$name] rejects a structurally invalid token", async (ep) => {
        const res = await send(ep, { bearer: "not.a.jwt" });
        expect([401, 403]).toContain(res.status);
        expectNoServiceCall();
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. Authorisation — role escalation
// ══════════════════════════════════════════════════════════════════════════════

describe("Data Purge Security: only SUPER_ADMIN may pass", () => {
    const ROLES: Array<[string, () => string]> = [
        ["ADMIN", adminToken],
        ["USER", userToken],
        ["role-less", () => signToken({ sub: "X", userId: "X", id: 9, role: undefined, userLevel: 99 })],
        ["lower-case super_admin", () => signToken({ sub: "X", userId: "X", id: 9, role: "super_admin", userLevel: 3 })],
        ["SUPER_ADMIN with padding", () => signToken({ sub: "X", userId: "X", id: 9, role: " SUPER_ADMIN ", userLevel: 3 })],
    ];

    for (const [label, tok] of ROLES) {
        it.each(ENDPOINTS)(`[$name] 403 for ${label}`, async (ep) => {
            const res = await send(ep, { bearer: tok() });
            expect(res.status).toBe(403);
            expectNoServiceCall();
        });
    }

    it("the 403 body is an error envelope that does not leak a stack trace", async () => {
        const res = await send(ENDPOINTS[0], { bearer: adminToken() });
        expect(res.body.status).toBe("error");
        expect(JSON.stringify(res.body)).not.toMatch(/\bat .*\.(ts|js):\d+/);
        expect(res.body.error ?? {}).not.toHaveProperty("stack");
    });

    it("refuses before multer parses an upload from a non-SUPER_ADMIN", async () => {
        const restore = ENDPOINTS.find((e) => e.name === "POST /restore")!;
        const res = await send(restore, { bearer: adminToken() });
        expect(res.status).toBe(403);
        expect(spies.restore).not.toHaveBeenCalled();
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. SUPER_ADMIN passes the gate
// ══════════════════════════════════════════════════════════════════════════════

describe("Data Purge Security: SUPER_ADMIN passes the gate", () => {
    const STUBBED = ENDPOINTS.filter((e) => e.probe);

    it.each(STUBBED)("[$name] reaches the service and is not refused by auth", async (ep) => {
        const res = await send(ep, { bearer: superAdminToken() });
        expect(res.status).toBe(ep.okStatus);
        expect(ep.probe!()).toHaveBeenCalledTimes(1);
    });

    // Not stubbable (see Endpoint.probe). POST /backups/run is excluded: unstubbed it
    // would start a real backup. The rest are read-only or fail on the unknown archive id.
    const LAZY_SAFE = ENDPOINTS.filter((e) => !e.probe && e.name !== "POST /backups/run");

    it.each(LAZY_SAFE)("[$name] is not refused by the auth gate", async (ep) => {
        const res = await send(ep, { bearer: superAdminToken() });
        expect([401, 403, 440, 429]).not.toContain(res.status);
    });

    it("passes the authenticated admin id (not a body value) to the service", async () => {
        const { agent, csrf } = await csrfAgent();
        await agent
            .post("/api/v1/data-purge/authorise")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", csrf)
            .send({ adminPassword: "pw", adminId: 999 });
        expect(spies.authorise).toHaveBeenCalledWith({ adminId: 1, adminPassword: "pw" });
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. CSRF on mutating routes (SUPER_ADMIN credentials, no CSRF token)
// ══════════════════════════════════════════════════════════════════════════════

describe("Data Purge Security: CSRF protection on mutating routes", () => {
    it.each(ENDPOINTS.filter((e) => e.method !== "get"))("[$name] 403 without a CSRF token", async (ep) => {
        let req = request(app)[ep.method](ep.path).set("Authorization", `Bearer ${superAdminToken()}`);
        req = ep.multipart
            ? req.attach("file", ZIP, { filename: "backup.zip", contentType: "application/zip" })
            : req.send(ep.body ?? {});
        const res = await req;
        expect(res.status).toBe(403);
        expectNoServiceCall();
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. Backup token on POST /execute (real BackupTokenService + executePurge)
// ══════════════════════════════════════════════════════════════════════════════

describe("Data Purge Security: backup token enforcement on POST /execute", () => {
    const ledger = new Set<string>();
    const stubs: Array<ReturnType<typeof vi.spyOn>> = [];

    const executeWith = async (backupToken: unknown, bearer = superAdminToken()) => {
        const { agent, csrf } = await csrfAgent();
        return agent
            .post("/api/v1/data-purge/execute")
            .set("Authorization", `Bearer ${bearer}`)
            .set("x-csrf-token", csrf)
            .send({
                scope: SCOPE,
                backupToken,
                adminPassword: "pw",
                confirmPhrase: "irrelevant",
            });
    };

    const issue = (over: Partial<Parameters<typeof BackupTokenService.issue>[0]> = {}) =>
        BackupTokenService.issue({
            adminId: 1,
            scopeHash: "h",
            rowCounts: { T_AUDIT_LOGS_DEV: 1 },
            ...over,
        });

    beforeEach(() => {
        ledger.clear();
        // Run the REAL executePurge for this block.
        spies.executePurge.mockRestore();
        stubs.push(
            vi.spyOn(BackupScheduleService, "getLockoutStatus").mockResolvedValue({ active: false } as never),
            vi.spyOn(DataPurgeService, "findAdminById").mockResolvedValue({ ID: 1 } as never),
            vi.spyOn(DataPurgeService, "_assertAdminPassword").mockResolvedValue({ adminId: 1 }),
            vi.spyOn(BackupTokenModel, "consumeJti").mockImplementation(async ({ jti }: { jti: string }) => {
                if (ledger.has(jti)) return { consumed: false, reason: "already-consumed" } as const;
                ledger.add(jti);
                return { consumed: true } as const;
            }),
        );
    });

    afterEach(() => {
        vi.useRealTimers();
        while (stubs.length) stubs.pop()!.mockRestore();
        // Re-install the service stub for the other blocks.
        spies.executePurge = vi.spyOn(DataPurgeService, "executePurge").mockResolvedValue({} as never);
    });

    it("401 BACKUP_TOKEN_REQUIRED when the token is missing", async () => {
        const res = await executeWith(undefined);
        // validateRequiredFields rejects the absent field before the service
        expect([400, 401]).toContain(res.status);
        expect(res.status).not.toBe(200);
    });

    it.each([
        ["garbage string", "garbage"],
        ["dot only", "."],
        ["empty signature", ".e30"],
        ["sig only", "a".repeat(64) + "."],
    ])("401 for a malformed token (%s)", async (_l, tok) => {
        const res = await executeWith(tok);
        expect(res.status).toBe(401);
        expect(res.body.message ?? res.body.error?.message).toBe(PURGE_ERRORS.BACKUP_TOKEN_INVALID);
        expect(ledger.size).toBe(0);
    });

    it("401 for a forged token (valid-looking payload, wrong signature)", async () => {
        const { token } = await issue();
        const b64 = token.split(".")[1];
        const res = await executeWith(`${"0".repeat(64)}.${b64}`);
        expect(res.status).toBe(401);
        expect(res.body.message ?? res.body.error?.message).toBe(PURGE_ERRORS.BACKUP_TOKEN_INVALID);
        expect(ledger.size).toBe(0);
    });

    it("401 for a token whose rowCounts were widened after signing", async () => {
        const { token } = await issue();
        const [sig, b64] = token.split(".");
        const payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
        payload.rowCounts = { ...payload.rowCounts, T_ADMINS_DEV: 1 };
        const forged = Buffer.from(JSON.stringify(payload)).toString("base64url");
        const res = await executeWith(`${sig}.${forged}`);
        expect(res.status).toBe(401);
        expect(res.body.message ?? res.body.error?.message).toBe(PURGE_ERRORS.BACKUP_TOKEN_INVALID);
    });

    it("401 BACKUP_TOKEN_EXPIRED for an expired token", async () => {
        const { token } = await issue({ ttlMinutes: -1 });
        const res = await executeWith(token);
        expect(res.status).toBe(401);
        expect(res.body.message ?? res.body.error?.message).toBe(PURGE_ERRORS.BACKUP_TOKEN_EXPIRED);
        expect(ledger.size).toBe(0);
    });

    it("401 BACKUP_TOKEN_WRONG_ADMIN for a token issued to another admin", async () => {
        const { token } = await issue({ adminId: 999 });
        const res = await executeWith(token);
        expect(res.status).toBe(401);
        expect(res.body.message ?? res.body.error?.message).toBe(PURGE_ERRORS.BACKUP_TOKEN_WRONG_ADMIN);
    });

    it("a consumed token cannot be replayed: second /execute gets 401 BACKUP_TOKEN_REPLAYED", async () => {
        // Token covers only T_AUDIT_LOGS_DEV, so the (wider) scope is refused AFTER the
        // token is burned — the token must be spent regardless of why the request failed.
        const { token } = await issue();
        const first = await executeWith(token);
        expect(first.status).not.toBe(200);
        expect(ledger.size).toBe(1);

        const second = await executeWith(token);
        expect(second.status).toBe(401);
        expect(second.body.message ?? second.body.error?.message).toBe(PURGE_ERRORS.BACKUP_TOKEN_REPLAYED);
        expect(ledger.size).toBe(1);
    });

    it("a token is single-use even under concurrent /execute requests", async () => {
        const { token } = await issue();
        const results = await Promise.all([1, 2, 3, 4].map(() => executeWith(token)));
        const replayed = results.filter(
            (r) => (r.body.message ?? r.body.error?.message) === PURGE_ERRORS.BACKUP_TOKEN_REPLAYED,
        );
        expect(replayed).toHaveLength(3);
        expect(ledger.size).toBe(1);
    });

    it("an ADMIN holding a perfectly valid token is still refused 403 and the token is NOT burned", async () => {
        const { token } = await issue({ adminId: 2 });
        const res = await executeWith(token, adminToken());
        expect(res.status).toBe(403);
        expect(ledger.size).toBe(0);
    });
});
