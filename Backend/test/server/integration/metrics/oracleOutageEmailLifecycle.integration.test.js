"use strict";

/**
 * oracleOutageEmailLifecycle.integration.test.js â€” a whole Oracle outage, from
 * the pool-health payloads the adapter records to the composed email handed to
 * the mail transport, and back to the all-clear.
 *
 * Only the two edges are stubbed (same seam as alertNotifierPollToEmail.test.js):
 *   INPUT  â€” `MetricsService.getSnapshot` returns a REAL MetricsStore snapshot fed
 *            with the exact `recordPoolStats` payloads oracle.js pushes; the rules
 *            (`evaluateAlerts`) run for real.
 *   OUTPUT â€” `SharedTransporter.getTransporter().sendMail`.
 * Oracle models are stubbed (no real connection), and are made to REJECT where
 * the scenario has the database down.
 *
 *   OG1  DEGRADED -> DOWN -> healthy x3 -> RESOLVED all-clear email (gap 1)
 *   OG2  cold boot with the DB down: alert + "Server started" go to SERVER_NOTIFY_TO only (gap 2)
 *   OG4  restart mid-outage: acked -> no FIRED, unacked -> exactly one FIRED,
 *        ack read failed at boot -> retried before the alert is re-sent (gap 4)
 *   OG5  SERVER_ALERT_LOG rows queued during the outage are written once on recovery (gap 5)
 */

const { AlertNotifierService } = require("../../../../src/services/AlertNotifierService");
const SharedTransporter = require("../../../../src/services/email/SharedTransporter");
const RecipientResolver = require("../../../../src/services/email/RecipientResolver");
const MetricsService = require("../../../../src/services/MetricsService");
const AdminModel = require("../../../../src/models/admin.model");
const ServerAlertLogModel = require("../../../../src/models/serverAlertLog.model");
const ServerAlertAckModel = require("../../../../src/models/serverAlertAck.model");
const StartupNotifier = require("../../../../src/utils/lifecycle/StartupNotifier");
const { MetricsStore } = require("../../../../src/middleware/metrics");
const { SERVER_RUN_MARKER } = require("../../../../src/constants/serverRunMarker");
const { logger } = require("../../../../src/utils/logger");

const ORIGINAL_ENV = { ...process.env };
const CRIT = "server-critical-notification";
const DEPS = "server-dependencies-notification";
const DB_DOWN = () => Promise.reject(new Error("NJS-503: connection to host failed"));

/** oracle.js PoolHealthMonitor success-path payload. */
const healthy = () => ({ connectionsInUse: 1, connectionsOpen: 4, poolMax: 10, queueLength: 0, healthy: true, consecutiveFailures: 0 });
/** oracle.js catch-path payload (marked unhealthy at maxFailures = 3). */
const failing = (n) => ({ connectionsInUse: 0, connectionsOpen: 0, poolMax: 0, queueLength: 0, healthy: n < 3, consecutiveFailures: n });

let notifier;
let store;
let sent;

beforeEach(function () {
    process.env.ENABLE_SERVER_NOTIFICATIONS = "true";
    process.env.APP_NAME = "CATHERINE";
    process.env.SERVER_NOTIFY_TO = "ops@example.com";
    process.env.ALERT_EMAIL_COOLDOWN_MIN = "30";
    process.env.ALERT_NOTIFY_RECOVERY = "true";
    process.env.ALERT_RECOVERY_CONFIRM_POLLS = "3";

    notifier = new AlertNotifierService();
    store = new MetricsStore();
    RecipientResolver.invalidate();

    vi.spyOn(AdminModel, "findServerNotifyRecipients").mockResolvedValue([]);
    vi.spyOn(AdminModel, "getNamesByIds").mockResolvedValue(new Map());
    vi.spyOn(ServerAlertLogModel, "insertOne").mockResolvedValue();
    vi.spyOn(ServerAlertLogModel, "findRecent").mockResolvedValue([]);
    vi.spyOn(ServerAlertLogModel, "purgeOlderThan").mockResolvedValue(0);
    vi.spyOn(ServerAlertAckModel, "findAll").mockResolvedValue([]);
    vi.spyOn(ServerAlertAckModel, "upsert").mockResolvedValue();
    vi.spyOn(ServerAlertAckModel, "remove").mockResolvedValue(true);
    vi.spyOn(ServerAlertAckModel, "findOne").mockResolvedValue(null);
    vi.spyOn(MetricsService, "getSnapshot").mockImplementation(() => store.getSnapshot());

    sent = [];
    vi.spyOn(SharedTransporter.getTransporter(), "sendMail").mockImplementation(async (opts) => {
        sent.push(opts);
        return { messageId: `probe-${sent.length}` };
    });
});

afterEach(function () {
    notifier.stop();
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
    RecipientResolver.invalidate();
});

async function poll(pool, payload) {
    if (payload) store.recordPoolStats(pool, payload);
    await notifier._pollTick();
}

const onChannel = (channel, severity) =>
    sent.filter((m) => m.subject.startsWith(`[CATHERINE][${severity}] ${channel}:`));

/** A rendered email must carry the rule and pool in BOTH parts and leave no placeholder unfilled. */
function expectRendered(mail, rule, pool) {
    expect(mail.text).toContain(rule);
    expect(mail.text).toContain(pool);
    expect(mail.html, "rule + pool row missing from the HTML part").toContain(`${rule} &middot; ${pool}`);
    expect(mail.html, "unfilled {{placeholder}} in the HTML part").not.toMatch(/\{\{\w+\}\}/);
}

describe("OG1 â€” outage to all-clear, end to end (gap 1)", function () {
    it("DEGRADED -> DOWN -> 3 healthy polls sends one RESOLVED email per channel, rendered with rule + pool", async function () {
        await poll("appDb", failing(1));
        const degraded = onChannel(DEPS, "WARNING");
        expect(degraded).toHaveLength(1);
        expectRendered(degraded[0], "ORACLE_POOL_DEGRADED", "appDb");

        await poll("appDb", failing(3));
        const down = onChannel(CRIT, "CRITICAL");
        expect(down).toHaveLength(1);
        expect(down[0].subject).toContain("is DOWN");
        expectRendered(down[0], "ORACLE_POOL_DOWN", "appDb");

        // DB back: the success path records healthy:true / 0 failures.
        await poll("appDb", healthy());
        await poll("appDb");
        expect(onChannel(CRIT, "RESOLVED"), "no all-clear before ALERT_RECOVERY_CONFIRM_POLLS").toHaveLength(0);
        await poll("appDb");

        const resolved = onChannel(CRIT, "RESOLVED");
        expect(resolved).toHaveLength(1);
        expect(resolved[0].subject).toBe(`[CATHERINE][RESOLVED] ${CRIT}: ORACLE_POOL_DOWN back to normal`);
        expect(String(resolved[0].to)).toBe("ops@example.com");
        expectRendered(resolved[0], "ORACLE_POOL_DOWN", "appDb");
        expect(resolved[0].text).toContain("Recovered - no longer firing.");

        // DEGRADED stopped firing when DOWN took over (mutually exclusive) -> its own all-clear.
        expect(onChannel(DEPS, "RESOLVED")).toHaveLength(1);

        // Stays quiet afterwards: no duplicate all-clear.
        for (let i = 0; i < 5; i++) await poll("appDb");
        expect(onChannel(CRIT, "RESOLVED")).toHaveLength(1);
        expect(sent).toHaveLength(4);
    });

    it("a flap (DOWN, 1 healthy poll, DOWN) sends neither a RESOLVED nor a second FIRED", async function () {
        await poll("appDb", failing(3));
        await poll("appDb", healthy());
        await poll("appDb", failing(3));
        await poll("appDb");
        expect(onChannel(CRIT, "CRITICAL")).toHaveLength(1);
        expect(onChannel(CRIT, "RESOLVED")).toHaveLength(0);
    });
});

describe("OG2 â€” cold boot with the DB already down (gap 2)", function () {
    it("ORACLE_POOL_DOWN still emails, to SERVER_NOTIFY_TO only, while every DB read fails", async function () {
        AdminModel.findServerNotifyRecipients.mockImplementation(DB_DOWN);
        ServerAlertAckModel.findAll.mockImplementation(DB_DOWN);
        ServerAlertLogModel.insertOne.mockImplementation(DB_DOWN);
        await notifier._hydrateAcks();

        await poll("appDb", failing(3));

        const down = onChannel(CRIT, "CRITICAL");
        expect(down).toHaveLength(1);
        expect(String(down[0].to)).toBe("ops@example.com");
        expect(AdminModel.findServerNotifyRecipients).toHaveBeenCalled();
    });

    it("the 'Server started' email still goes out, env floor only, when the DB is down (BOOT_ANNOUNCE fallback path)", async function () {
        AdminModel.findServerNotifyRecipients.mockImplementation(DB_DOWN);
        ServerAlertLogModel.insertOne.mockImplementation(DB_DOWN);
        const startup = new StartupNotifier({ alertNotifier: notifier, logger });
        const res = await startup.announce({
            verdict: SERVER_RUN_MARKER.VERDICTS.FIRST_BOOT,
            previous: null,
            current: { pid: process.pid, version: "1.0.0", bootedAtMs: Date.now() },
            lastStartNoticeAt: null,
            nowMs: Date.now(),
        });
        expect(res.sent).toBe(true);
        const mail = sent.find((m) => m.subject.includes("Server started on"));
        expect(mail).toBeDefined();
        expect(String(mail.to)).toBe("ops@example.com");
        // server.js sends it after BOOT_ANNOUNCE_MAX_WAIT_MS at the latest when the pools hang.
        expect(SERVER_RUN_MARKER.BOOT_ANNOUNCE_MAX_WAIT_MS).toBeLessThanOrEqual(10_000);
    });
});

describe("OG4 â€” restart mid-outage (gap 4)", function () {
    const KEY = "ORACLE_POOL_DOWN::appDbBulk";
    const ackRow = () => ({
        ALERT_KEY: KEY,
        ACKED_BY: 7,
        ACKED_AT: new Date(Date.now() - 60_000),
        EXPIRES_AT: new Date(Date.now() + 3_600_000),
        SEVERITY_AT_ACK: "CRITICAL",
        NOTE: null,
    });

    it("acknowledged before the restart -> the fresh process sends no FIRED email", async function () {
        ServerAlertAckModel.findAll.mockResolvedValue([ackRow()]);
        await notifier._hydrateAcks();
        for (let i = 0; i < 4; i++) await poll("appDbBulk", failing(3 + i));
        expect(onChannel(CRIT, "CRITICAL")).toHaveLength(0);
    });

    it("not acknowledged -> exactly one FIRED email across many polls", async function () {
        await notifier._hydrateAcks();
        for (let i = 0; i < 6; i++) await poll("appDbBulk", failing(3 + i));
        expect(onChannel(CRIT, "CRITICAL")).toHaveLength(1);
    });

    it("ack read failed at boot (appDb briefly down) -> retried before the incident is re-announced", async function () {
        ServerAlertAckModel.findAll.mockImplementationOnce(DB_DOWN).mockResolvedValue([ackRow()]);
        await notifier._hydrateAcks(); // start()'s fire-and-forget hydrate, DB down
        expect(notifier._acks.has(KEY)).toBe(false);

        // appDb is back; the acked appDbBulk outage is still live.
        for (let i = 0; i < 4; i++) await poll("appDbBulk", failing(3 + i));

        expect(onChannel(CRIT, "CRITICAL"), "acked incident re-emailed: ack hydration is never retried").toHaveLength(0);
        expect(notifier._acks.has(KEY)).toBe(true);
    });
});

describe("OG5 â€” alert-log rows queued during the outage (gap 5)", function () {
    it("rows that failed to write while the DB was down are written once, in order, on recovery", async function () {
        const written = [];
        let dbUp = false;
        ServerAlertLogModel.insertOne.mockImplementation(async (row) => {
            if (!dbUp) throw new Error("NJS-503: connection to host failed");
            written.push(`${row.transition}:${row.alertKey}`);
        });

        await poll("appDb", failing(1)); // DEGRADED FIRED row
        await poll("appDb", failing(3)); // DOWN FIRED row
        await poll("appDb", failing(4));
        await poll("appDb", failing(5)); // DEGRADED RECOVERED row (DOWN replaced it)
        await new Promise((r) => setImmediate(r));
        expect(written).toEqual([]);
        expect(notifier._alertLogQueue.map((r) => r.transition)).toEqual(["FIRED", "FIRED", "RECOVERED"]);

        dbUp = true;
        await poll("appDb", failing(6)); // flush runs at the top of the tick
        await notifier._flushAlertLogQueue();

        expect(written).toEqual([
            "FIRED:ORACLE_POOL_DEGRADED::appDb",
            "FIRED:ORACLE_POOL_DOWN::appDb",
            "RECOVERED:ORACLE_POOL_DEGRADED::appDb",
        ]);
        expect(notifier._alertLogQueue).toHaveLength(0);

        await poll("appDb");
        await notifier._flushAlertLogQueue();
        expect(new Set(written).size, "a queued row was written twice").toBe(written.length);
    });

    it("overflow while the DB is down drops the oldest and warns with the _noNotify loop guard", async function () {
        ServerAlertLogModel.insertOne.mockImplementation(DB_DOWN);
        const warn = vi.spyOn(logger, "warning");
        const rows = Array.from({ length: 505 }, (_, i) => ({ alertKey: `K${i}`, rule: "ORACLE_POOL_DOWN", transition: "FIRED", details: {} }));
        await notifier._writeAlertLogRows(rows);
        expect(notifier._alertLogQueue).toHaveLength(500);
        expect(notifier._alertLogQueue[0].alertKey).toBe("K5");
        const drop = warn.mock.calls.find(([msg]) => /dropped 5 oldest/.test(msg));
        expect(drop).toBeDefined();
        expect(drop[1]).toMatchObject({ _noNotify: true });
    });
});
