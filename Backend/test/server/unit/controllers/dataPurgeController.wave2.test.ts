import { afterEach, describe, expect, it, vi } from "vitest";

import "../../../../src/config/cacheStores";
import DataPurgeController from "../../../../src/controllers/DataPurgeController";
import DataPurgeService from "../../../../src/services/DataPurgeService";
import DataRestoreService from "../../../../src/services/DataRestoreService";
import { PURGE_ERRORS } from "../../../../src/constants/errors";

afterEach(() => {
    vi.restoreAllMocks();
});

type Outcome = { status?: number; headers?: Record<string, string>; json?: any; sent?: unknown; error?: any };

/** Runs an express handler against a fake req/res and resolves when it responds or calls next(err). */
function run(handler: (req: any, res: any, next: any) => void, req: Record<string, unknown>): Promise<Outcome> {
    return new Promise((resolve) => {
        const out: Outcome = {};
        const res: any = {
            status(c: number) { out.status = c; return res; },
            set(h: Record<string, string>) { out.headers = h; return res; },
            json(b: unknown) { out.json = b; resolve(out); return res; },
            send(b: unknown) { out.sent = b; resolve(out); return res; },
        };
        handler(req, res, (err: unknown) => { out.error = err; resolve(out); });
    });
}

const user = { id: 7 };

describe("DataPurgeController - caller identity", () => {
    it("fails with 401 when the route was wired without authentication", async () => {
        const out = await run(DataPurgeController.authorise, { body: { adminPassword: "x" } });
        expect(out.error).toMatchObject({ statusCode: 401 });
    });

    it("falls back to the userId claim when the token carries no numeric id", async () => {
        const spy = vi.spyOn(DataPurgeService, "authorise").mockResolvedValue({ ok: true } as never);
        await run(DataPurgeController.authorise, { user: { userId: "SA001" }, body: { adminPassword: "pw" } });
        expect(spy).toHaveBeenCalledWith({ adminId: "SA001", adminPassword: "pw" });
    });

    it("authorise tolerates a missing body (the service rejects the empty password)", async () => {
        const spy = vi.spyOn(DataPurgeService, "authorise").mockRejectedValue(Object.assign(new Error("pw"), { statusCode: 400 }));
        const out = await run(DataPurgeController.authorise, { user });
        expect(spy).toHaveBeenCalledWith({ adminId: 7, adminPassword: undefined });
        expect(out.error).toMatchObject({ statusCode: 400 });
    });
});

describe("DataPurgeController - purge endpoints", () => {
    it("getScopes returns the live catalogue", async () => {
        vi.spyOn(DataPurgeService, "getScopeCatalogue").mockResolvedValue({ groups: [], generatedAt: "t" });
        const out = await run(DataPurgeController.getScopes, {});
        expect(out.status).toBe(200);
        expect(out.json.data).toEqual({ groups: [], generatedAt: "t" });
    });

    it("preview forwards groups/tables and tolerates a missing body", async () => {
        const spy = vi.spyOn(DataPurgeService, "getPreview").mockResolvedValue({ x: 1 } as never);
        await run(DataPurgeController.preview, { body: { groups: ["T_"], tables: ["A"] } });
        expect(spy).toHaveBeenLastCalledWith({ groups: ["T_"], tables: ["A"] });
        await run(DataPurgeController.preview, {});
        expect(spy).toHaveBeenLastCalledWith({ groups: undefined, tables: undefined });
    });

    it("backup streams the zip with token headers and a URL-encoded confirm phrase", async () => {
        const zip = Buffer.from("zip");
        const spy = vi.spyOn(DataPurgeService, "backup").mockResolvedValue({ zipBuffer: zip, filename: "b.zip", token: "tk", expiresAt: 99, confirmPhrase: "DELETE T_, S 5 ROWS" } as never);
        const out = await run(DataPurgeController.backup, { user, body: { groups: ["T_"] }, id: "rq1" });
        expect(spy).toHaveBeenCalledWith({ selection: { groups: ["T_"], tables: undefined }, adminId: 7, requestId: "rq1" });
        expect(out.sent).toBe(zip);
        expect(out.headers).toEqual({
            "Content-Type": "application/zip",
            "Content-Disposition": 'attachment; filename="b.zip"',
            "X-Backup-Token": "tk",
            "X-Backup-Token-Expires-At": "99",
            "X-Confirm-Phrase": "DELETE%20T_%2C%20S%205%20ROWS",
        });
    });

    it("backup passes a null request id when none is set and tolerates a missing body", async () => {
        const spy = vi.spyOn(DataPurgeService, "backup").mockResolvedValue({ zipBuffer: Buffer.alloc(0), filename: "f", token: "t", expiresAt: 1, confirmPhrase: "p" } as never);
        await run(DataPurgeController.backup, { user });
        expect(spy).toHaveBeenCalledWith({ selection: { groups: undefined, tables: undefined }, adminId: 7, requestId: null });
    });

    it("execute forwards every field including client ip and request id", async () => {
        const spy = vi.spyOn(DataPurgeService, "executePurge").mockResolvedValue({ totalDeleted: 1 } as never);
        const body = { scope: { groups: ["T_"] }, backupToken: "bt", adminPassword: "pw", confirmPhrase: "cp", acknowledgeLockout: true };
        const out = await run(DataPurgeController.execute, { user, body, ip: "1.2.3.4", id: "r9" });
        expect(spy).toHaveBeenCalledWith({ selection: body.scope, backupToken: "bt", adminId: 7, adminPassword: "pw", confirmPhrase: "cp", acknowledgeLockout: true, clientIp: "1.2.3.4", requestId: "r9" });
        expect(out.json.data).toEqual({ totalDeleted: 1 });
    });

    it("execute defaults ip and request id to null and survives a missing body", async () => {
        const spy = vi.spyOn(DataPurgeService, "executePurge").mockResolvedValue({} as never);
        await run(DataPurgeController.execute, { user });
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ selection: undefined, clientIp: null, requestId: null }));
    });

    it("execute funnels a service rejection to next()", async () => {
        vi.spyOn(DataPurgeService, "executePurge").mockRejectedValue(new Error("nope"));
        const out = await run(DataPurgeController.execute, { user, body: {} });
        expect(out.error.message).toBe("nope");
        expect(out.json).toBeUndefined();
    });
});

describe("DataPurgeController - restore endpoints", () => {
    it.each([["restorePreview"], ["restore"]] as const)("%s without an uploaded file is a 400 and never reaches the service", async (name) => {
        const p = vi.spyOn(DataRestoreService, "preview");
        const r = vi.spyOn(DataRestoreService, "restore");
        const out = await run(DataPurgeController[name], { user, body: {} });
        expect(out.error).toMatchObject({ message: PURGE_ERRORS.RESTORE_NO_FILE, statusCode: 400, details: [{ field: "file", issue: "No archive file was uploaded." }] });
        expect(p).not.toHaveBeenCalled();
        expect(r).not.toHaveBeenCalled();
    });

    it("restorePreview hands the uploaded buffer to the engine", async () => {
        const buf = Buffer.from("z");
        const spy = vi.spyOn(DataRestoreService, "preview").mockResolvedValue({ kind: "FULL_SCOPE" } as never);
        const out = await run(DataPurgeController.restorePreview, { file: { buffer: buf } });
        expect(spy).toHaveBeenCalledWith({ zipBuffer: buf });
        expect(out.json.data).toEqual({ kind: "FULL_SCOPE" });
    });

    it("restore forwards credentials, confirm phrase, ip and request id", async () => {
        const buf = Buffer.from("z");
        const spy = vi.spyOn(DataRestoreService, "restore").mockResolvedValue({ totalInserted: 2 } as never);
        const out = await run(DataPurgeController.restore, { user, file: { buffer: buf }, body: { adminPassword: "pw", confirmPhrase: "cp" }, ip: "9.9.9.9", id: "rq" });
        expect(spy).toHaveBeenCalledWith({ zipBuffer: buf, adminId: 7, adminPassword: "pw", confirmPhrase: "cp", clientIp: "9.9.9.9", requestId: "rq" });
        expect(out.json.data).toEqual({ totalInserted: 2 });
    });

    it("restore defaults a missing body, ip and request id", async () => {
        const spy = vi.spyOn(DataRestoreService, "restore").mockResolvedValue({} as never);
        await run(DataPurgeController.restore, { user, file: { buffer: Buffer.alloc(1) } });
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ adminPassword: undefined, confirmPhrase: undefined, clientIp: null, requestId: null }));
    });
});
