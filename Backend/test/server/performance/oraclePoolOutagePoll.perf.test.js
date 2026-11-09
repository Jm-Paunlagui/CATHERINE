"use strict";

/**
 * @fileoverview Performance — one metrics poll during a wide Oracle outage.
 *
 * 200 pools go DOWN in the same tick: the poll must still send ONE digest per
 * channel (not one email per pool), finish inside a bounded time, and the
 * RESOLVED tick must do the same on the way back. The full render path runs
 * (ServerNotificationService + template fill); only sendMail is stubbed.
 * Budget generous for CI: p95 of a 200-pool FIRED or RESOLVED tick < 250 ms.
 */

const { AlertNotifierService } = require("../../../src/services/AlertNotifierService");
const SharedTransporter = require("../../../src/services/email/SharedTransporter");
const RecipientResolver = require("../../../src/services/email/RecipientResolver");
const MetricsService = require("../../../src/services/MetricsService");
const AdminModel = require("../../../src/models/admin.model");
const ServerAlertLogModel = require("../../../src/models/serverAlertLog.model");
const ServerAlertAckModel = require("../../../src/models/serverAlertAck.model");
const { MetricsStore } = require("../../../src/middleware/metrics");
const { logger } = require("../../../src/utils/logger");

const POOLS = 200;
const RUNS = 7;
const BUDGET_MS = 250;

beforeEach(function () {
    vi.stubEnv("ENABLE_SERVER_NOTIFICATIONS", "true");
    vi.stubEnv("APP_NAME", "CATHERINE");
    vi.stubEnv("SERVER_NOTIFY_TO", "ops@example.com");
    vi.stubEnv("ALERT_RECOVERY_CONFIRM_POLLS", "1");
    RecipientResolver.invalidate();
    vi.spyOn(AdminModel, "findServerNotifyRecipients").mockResolvedValue([]);
    vi.spyOn(AdminModel, "getNamesByIds").mockResolvedValue(new Map());
    vi.spyOn(ServerAlertLogModel, "insertOne").mockResolvedValue();
    vi.spyOn(ServerAlertAckModel, "findAll").mockResolvedValue([]);
    vi.spyOn(logger, "critical").mockImplementation(() => {});
    vi.spyOn(logger, "warning").mockImplementation(() => {});
});

afterEach(function () {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    RecipientResolver.invalidate();
});

const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1];

it(`${POOLS} pools DOWN then back: one email per tick, p95 tick < ${BUDGET_MS} ms`, async function () {
    const fired = [];
    const resolvedMs = [];
    for (let run = 0; run < RUNS; run++) {
        const notifier = new AlertNotifierService();
        const store = new MetricsStore();
        vi.spyOn(MetricsService, "getSnapshot").mockImplementation(() => store.getSnapshot());
        const sent = [];
        vi.spyOn(SharedTransporter.getTransporter(), "sendMail").mockImplementation(async (o) => {
            sent.push(o);
            return { messageId: "m" };
        });

        for (let i = 0; i < POOLS; i++) {
            store.recordPoolStats(`pool${i}`, { connectionsInUse: 0, connectionsOpen: 0, poolMax: 0, queueLength: 0, healthy: false, consecutiveFailures: 3 });
        }
        let t0 = performance.now();
        await notifier._pollTick();
        fired.push(performance.now() - t0);
        expect(sent).toHaveLength(1);
        expect(sent[0].subject).toBe(`[CATHERINE][CRITICAL] server-critical-notification: ${POOLS} alerts active — most severe: ORACLE_POOL_DOWN (CRITICAL)`);
        expect(new Set(sent[0].html.match(/ORACLE_POOL_DOWN &middot; pool\d+/g)).size).toBe(POOLS);

        for (let i = 0; i < POOLS; i++) {
            store.recordPoolStats(`pool${i}`, { connectionsInUse: 0, connectionsOpen: 1, poolMax: 4, queueLength: 0, healthy: true, consecutiveFailures: 0 });
        }
        t0 = performance.now();
        await notifier._pollTick();
        resolvedMs.push(performance.now() - t0);
        expect(sent).toHaveLength(2);
        expect(sent[1].subject).toBe(`[CATHERINE][RESOLVED] server-critical-notification: ${POOLS} alert(s) recovered`);
        await notifier._flushAlertLogQueue();
        notifier.stop();
        vi.mocked(MetricsService.getSnapshot).mockRestore();
    }
    expect(ServerAlertLogModel.insertOne).toHaveBeenCalledTimes(RUNS * POOLS * 2);
    expect(p95(fired), `FIRED tick ms: ${fired.map((x) => x.toFixed(1))}`).toBeLessThan(BUDGET_MS);
    expect(p95(resolvedMs), `RESOLVED tick ms: ${resolvedMs.map((x) => x.toFixed(1))}`).toBeLessThan(BUDGET_MS);
});
