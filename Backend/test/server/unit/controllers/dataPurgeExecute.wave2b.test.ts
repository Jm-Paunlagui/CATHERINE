/**
 * @fileoverview DataPurgeController.execute argument forwarding and defaults.
 */
import "../../../../src/config/cacheStores";
import DataPurgeController from "../../../../src/controllers/DataPurgeController";
import DataPurgeService from "../../../../src/services/DataPurgeService";

type Outcome = { status?: number; headers?: Record<string, string>; json?: any; sent?: unknown; error?: any };
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
const req = (extra: Record<string, unknown> = {}) => ({ user: { id: 7 }, params: { id: "arch-1" }, id: "rid", ...extra });

describe("DataPurgeController execute", () => {
    afterEach(() => vi.restoreAllMocks());

    it("execute forwards the body, caller, ip and request id", async () => {
        const spy = vi.spyOn(DataPurgeService, "executePurge").mockResolvedValue({ done: true } as never);
        const out = await run(DataPurgeController.execute, req({ ip: "1.2.3.4", body: { scope: { groups: ["a"] }, backupToken: "t", adminPassword: "p", confirmPhrase: "c", acknowledgeLockout: true } }));
        expect(out.status).toBe(200);
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ selection: { groups: ["a"] }, adminId: 7, clientIp: "1.2.3.4", requestId: "rid" }));
    });

    it("execute tolerates a missing body, ip and request id", async () => {
        const spy = vi.spyOn(DataPurgeService, "executePurge").mockResolvedValue({} as never);
        await run(DataPurgeController.execute, { user: { id: 7 } });
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ clientIp: null, requestId: null, selection: undefined }));
    });
});
