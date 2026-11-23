import { vi } from "vitest";

import DataPurgeService from "../../../src/services/DataPurgeService";
import DataPurgeModel from "../../../src/models/data-purge.model";
import AuditLogModel from "../../../src/models/audit.log.model";
import TamperDetectionService from "../../../src/services/TamperDetectionService";
import { CryptoVault } from "../../../src/utils/encryption/CryptoVault";
import { Transaction } from "../../../src/utils/oracle-mongo-wrapper";
import { registry } from "../../../src/middleware/cache";
import { logger } from "../../../src/utils/logger";

/** Stubs every collaborator of DataRestoreService.restore; the transaction records commit / rollback. */
export function stubRestoreWorld() {
    const world = { inserts: [] as Array<{ table: string; rows: Record<string, any>[] }>, committed: 0, rolledBack: 0, bulkUpdate: vi.fn() };
    for (const m of ["info", "notice", "warning", "alert", "security", "error"] as const) {
        vi.spyOn(logger, m).mockImplementation(() => undefined as never);
    }
    vi.spyOn(DataPurgeModel, "countRows").mockImplementation(async (tables: string[]) => Object.fromEntries(tables.map((t) => [t, 0])));
    vi.spyOn(DataPurgeService, "findAdminById").mockResolvedValue({ ID: 1, PASSWORD: "h" } as never);
    vi.spyOn(CryptoVault, "verifyAdminPassword").mockResolvedValue({ matched: true, newHash: null });
    vi.spyOn(AuditLogModel, "insert").mockResolvedValue({ rowsAffected: 1 });
    vi.spyOn(registry, "flushAll").mockImplementation(() => undefined as never);
    const counters: Record<string, number> = { W2_PARENT: 100, W2_CHILD: 200 };
    vi.spyOn(DataPurgeModel, "insertRestoreBatch").mockImplementation((async (table: string, rows: Record<string, any>[]) => {
        world.inserts.push({ table, rows: rows.map((r) => ({ ...r })) });
        return { insertedCount: rows.length, returning: rows.map(() => ({ ID: ++counters[table] })) };
    }) as never);
    vi.spyOn(TamperDetectionService, "buildSignedFields").mockImplementation(((_d: string, row: Record<string, unknown>) => ({ ID: String(row.ID ?? row.KEY) })) as never);
    const realVerify = CryptoVault.verifyRecord.bind(CryptoVault);
    const realSign = CryptoVault.signRecord.bind(CryptoVault);
    vi.spyOn(CryptoVault, "verifyRecord").mockImplementation((async (d: string, f: any, sig: any) => (d.startsWith("W2_") ? sig === "good" : realVerify(d, f, sig))) as never);
    vi.spyOn(CryptoVault, "signRecord").mockImplementation((async (d: string, f: any) => (d.startsWith("W2_") ? `signed:${f.ID}` : realSign(d, f))) as never);
    world.bulkUpdate.mockResolvedValue({ acknowledged: true });
    const session = {
        execute: vi.fn().mockResolvedValue({ rows: [] }),
        collection: () => ({ bulkUpdateByKeys: world.bulkUpdate }),
    };
    vi.spyOn(Transaction.prototype, "withTransaction").mockImplementation((async (fn: (s: unknown) => Promise<unknown>) => {
        try {
            const r = await fn(session);
            world.committed++;
            return r;
        } catch (e) {
            world.rolledBack++;
            throw e;
        }
    }) as never);
    return { world, session };
}
