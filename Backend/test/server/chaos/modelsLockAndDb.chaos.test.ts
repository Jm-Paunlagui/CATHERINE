"use strict";

/**
 * @fileoverview Chaos: model behaviour when infrastructure misbehaves —
 * DB errors mid-purge propagate (so the transaction rolls back), a snapshot
 * failure is typed for the caller's fallback, concurrent demo token replays
 * stay exactly-once.
 */

import BackupTokenModel from "../../../src/models/backup-token.model";
import DataPurgeModel from "../../../src/models/data-purge.model";
import demo from "../../../src/models/demo/demoStore";
import { logger } from "../../../src/utils/logger";
import { fake } from "../helpers/modelsWrapperFake";

vi.mock("../../../src/utils/oracle-mongo-wrapper", async () => (await import("../helpers/modelsWrapperFake")).wrapperMock);

describe("models chaos", function () {
    afterEach(function () {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        vi.clearAllMocks();
        fake.withTransaction.mockReset();
        fake.withReadOnlyTransaction.mockReset();
        demo.backupTokensConsumed().clear();
    });

    it("a connection drop during the second table delete aborts the whole purge", async function () {
        const deleteMany = vi.fn().mockResolvedValueOnce({ deletedCount: 2 }).mockRejectedValueOnce(new Error("ORA-03113: end-of-file on communication channel"));
        const session = { collection: vi.fn(() => ({ deleteMany })) };
        fake.withTransaction.mockImplementation(async (fn: (s: unknown) => unknown) => fn(session));
        const steps: string[] = [];
        await expect(DataPurgeModel.purgeTables(["T_SERVER_ALERT_LOG_DEV", "T_SERVER_ALERT_ACK_DEV"], (t) => steps.push(t))).rejects.toThrow("ORA-03113");
        expect(steps).toHaveLength(1); // only the completed step was reported
    });

    it("an ORA-01555 mid-stream is surfaced as a typed, recoverable snapshot error", async function () {
        vi.spyOn(logger, "warning").mockImplementation(() => undefined as never);
        fake.withReadOnlyTransaction.mockRejectedValue(new Error("ORA-01555: snapshot too old"));
        await expect(DataPurgeModel.streamAllTables(["T_SERVER_ALERT_LOG_DEV"])).rejects.toMatchObject({ isSnapshotTooOld: true });
    });

    it("a burst of concurrent replays of one token yields exactly one consumer (demo store)", async function () {
        vi.stubEnv("DEMO_MODE", "true");
        const results = await Promise.all(Array.from({ length: 25 }, (_, i) => BackupTokenModel.consumeJti({ jti: "burst", adminId: i, expiresAt: new Date() })));
        expect(results.filter((r) => r.consumed)).toHaveLength(1);
        expect(demo.backupTokensConsumed().size).toBe(1);
    });
});
