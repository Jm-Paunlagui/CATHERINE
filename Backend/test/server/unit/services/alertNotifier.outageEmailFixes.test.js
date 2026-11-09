"use strict";

/**
 * @fileoverview Unit locks for the two Oracle-outage email fixes.
 *
 *   OF-1  Critical channel renders metric-rule rows (ORACLE_POOL_DOWN / RESOLVED):
 *         `_buildRow` dispatches on row shape; log rows keep the critical markup.
 *   OF-2  `_buildChannelKv` fills the critical template's eventCount / windowLabel /
 *         firstEventAt for metric digests.
 *   OF-3  A failed boot-time SERVER_ALERT_ACK read is retried on the next poll
 *         (single-flight), and stops being retried after the first success.
 *   OF-4  The retry wait is bounded: a hung ack read never holds the DOWN email.
 */

const { AlertNotifierService } = require("../../../../src/services/AlertNotifierService");
const ServerNotificationService = require("../../../../src/services/email/ServerNotificationService");
const ServerAlertLogModel = require("../../../../src/models/serverAlertLog.model");
const ServerAlertAckModel = require("../../../../src/models/serverAlertAck.model");
const MetricsService = require("../../../../src/services/MetricsService");

const CRIT = "server-critical-notification";
const DOWN_ALERT = { rule: "ORACLE_POOL_DOWN", severity: "critical", pool: "appDb", description: "Oracle pool \"appDb\" is DOWN" };

let notifier;

beforeEach(function () {
    vi.stubEnv("ENABLE_SERVER_NOTIFICATIONS", "true");
    vi.stubEnv("SERVER_NOTIFY_TO", "ops@example.com");
    notifier = new AlertNotifierService();
    vi.spyOn(ServerAlertLogModel, "insertOne").mockResolvedValue();
    vi.spyOn(MetricsService, "getSnapshot").mockReturnValue({});
    vi.spyOn(MetricsService, "evaluateAlertHolds").mockReturnValue([]);
});

afterEach(function () {
    notifier.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe("OF-1 — critical channel row dispatch", function () {
    it("a metric row renders rule, scope, description and severity", function () {
        const html = ServerNotificationService._buildRow(CRIT, { rule: "ORACLE_POOL_DOWN", scope: "appDb", description: "Recovered - no longer firing.", severity: "resolved" }, true);
        expect(html).toContain("ORACLE_POOL_DOWN &middot; appDb");
        expect(html).toContain("Recovered - no longer firing.");
        expect(html).toContain("RESOLVED");
        expect(html).not.toContain("unknown");
    });

    it("a log row (has level) keeps the critical log markup", function () {
        const html = ServerNotificationService._buildRow(CRIT, { level: "CRITICAL", module: "oracle", message: "pool down", requestId: null, time: "10:00:00.000" }, false);
        expect(html).toContain("CRITICAL &middot; oracle");
        expect(html).toContain("10:00:00.000");
    });
});

describe("OF-2 — critical channel KV for metric digests", function () {
    it("fills every critical template placeholder", function () {
        vi.stubEnv("ALERT_POLL_INTERVAL_MS", "60000");
        const kv = notifier._buildChannelKv(CRIT, {}, 2);
        expect(kv.eventCount).toBe(2);
        expect(kv.windowLabel).toBe("60s metrics poll");
        expect(kv.firstEventAt).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}:\d{2} [AP]M UTC[+-]\d{2}:\d{2}$/);
    });

    it("'First event' reads in local time like the 'sent' line, never a raw UTC ISO string", function () {
        vi.stubEnv("DB_TIMEZONE_OFFSET_MINUTES", "480");
        // The drill email showed "2026-11-03T06:32:05.672Z" beside "sent Nov 3, 2026, 2:32 PM UTC+08:00".
        expect(notifier._formatEmailStamp("2026-11-03T06:32:05.672Z")).toBe("Nov 3, 2026, 2:32:05 PM UTC+08:00");
        vi.stubEnv("DB_TIMEZONE_OFFSET_MINUTES", "-210");
        expect(notifier._formatEmailStamp("2026-11-03T06:32:05.672Z")).toBe("Nov 3, 2026, 3:02:05 AM UTC-03:30");
        expect(notifier._formatEmailStamp("not a date")).toBe("not a date");
    });

    it("the critical-log digest stamps its first event in local time too", async function () {
        vi.stubEnv("DB_TIMEZONE_OFFSET_MINUTES", "480");
        const send = vi.spyOn(ServerNotificationService, "sendChannelDigest").mockResolvedValue({ sent: true });
        vi.spyOn(notifier, "_writeAlertLogRows").mockResolvedValue();
        await notifier._dispatchCriticalDigest(
            [{ level: "CRITICAL", message: "pool down", meta: {}, requestId: null, timestamp: "2026-11-03T06:32:05.672Z" }],
            "",
        );
        expect(send.mock.calls[0][1].kv.firstEventAt).toBe("Nov 3, 2026, 2:32:05 PM UTC+08:00");
    });

    it("the poll digest passes the event count through", async function () {
        const send = vi.spyOn(ServerNotificationService, "sendChannelDigest").mockResolvedValue({ sent: true });
        await notifier._dispatchMetricDigest(CRIT, [{ alert: DOWN_ALERT, key: "ORACLE_POOL_DOWN::appDb", transitionType: "FIRED" }], {}, false);
        expect(send.mock.calls[0][1].kv).toMatchObject({ eventCount: 1 });
    });
});

describe("OF-3 — ack hydration retried until the first success", function () {
    it("retries on each poll while failing, then never again", async function () {
        vi.spyOn(ServerNotificationService, "sendChannelDigest").mockResolvedValue({ sent: true });
        vi.spyOn(MetricsService, "evaluateAlerts").mockReturnValue([]);
        const findAll = vi.spyOn(ServerAlertAckModel, "findAll")
            .mockRejectedValueOnce(new Error("NJS-503"))
            .mockRejectedValueOnce(new Error("NJS-503"))
            .mockResolvedValue([]);

        await notifier._hydrateAcksShared();
        expect(notifier._acksHydrated).toBe(false);
        await notifier._pollTick();
        await notifier._ackHydration;
        expect(notifier._acksHydrated).toBe(false);
        await notifier._pollTick();
        await notifier._ackHydration;
        expect(notifier._acksHydrated).toBe(true);
        await notifier._pollTick();
        await notifier._pollTick();
        expect(findAll).toHaveBeenCalledTimes(3);
    });

    it("concurrent callers share one in-flight read", async function () {
        let release;
        const findAll = vi.spyOn(ServerAlertAckModel, "findAll").mockReturnValue(new Promise((r) => { release = r; }));
        const a = notifier._hydrateAcksShared();
        const b = notifier._hydrateAcksShared();
        expect(a).toBe(b);
        release([]);
        await a;
        expect(findAll).toHaveBeenCalledTimes(1);
    });
});

describe("OF-4 — bounded wait on a hung ack read", function () {
    it("the DOWN email is still sent after ~2 s when SERVER_ALERT_ACK never answers", async function () {
        vi.useFakeTimers();
        vi.spyOn(ServerAlertAckModel, "findAll").mockReturnValue(new Promise(() => {}));
        vi.spyOn(MetricsService, "evaluateAlerts").mockReturnValue([DOWN_ALERT]);
        const send = vi.spyOn(ServerNotificationService, "sendChannelDigest").mockResolvedValue({ sent: true });

        const tick = notifier._pollTick();
        await vi.advanceTimersByTimeAsync(1_900);
        expect(send).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(200);
        await tick;
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0][0]).toBe(CRIT);
    });
});
