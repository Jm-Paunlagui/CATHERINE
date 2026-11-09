"use strict";

/**
 * @fileoverview CWE-79 / CWE-200 — the Oracle-outage emails (ORACLE_POOL_DOWN
 * and its RESOLVED all-clear on the critical channel, ORACLE_POOL_DEGRADED on
 * the dependencies channel) escape the pool name in the HTML part and leak no
 * driver error text or DB secret.
 *
 * The pool name reaches the email from the metrics store key, which an attacker
 * cannot set today; the escaping is defence in depth, and before the row-shape fix
 * the critical channel dropped metric rows from the HTML entirely, so this
 * path had never rendered a pool name at all.
 */

const { AlertNotifierService } = require("../../../src/services/AlertNotifierService");
const SharedTransporter = require("../../../src/services/email/SharedTransporter");
const RecipientResolver = require("../../../src/services/email/RecipientResolver");
const MetricsService = require("../../../src/services/MetricsService");
const AdminModel = require("../../../src/models/admin.model");
const ServerAlertLogModel = require("../../../src/models/serverAlertLog.model");
const ServerAlertAckModel = require("../../../src/models/serverAlertAck.model");
const { MetricsStore } = require("../../../src/middleware/metrics");

const XSS_POOL = `appDb"><script>alert(1)</script><img src=x onerror=alert(2)>`;
const SECRET_KEYS = ["APP_DB_PASSWORD", "JWT_SECRET", "SMTP_PASS"];

let notifier;
let store;
let sent;

beforeEach(function () {
    vi.stubEnv("ENABLE_SERVER_NOTIFICATIONS", "true");
    vi.stubEnv("APP_NAME", "CATHERINE");
    vi.stubEnv("SERVER_NOTIFY_TO", "ops@example.com");
    vi.stubEnv("ALERT_RECOVERY_CONFIRM_POLLS", "1");
    notifier = new AlertNotifierService();
    store = new MetricsStore();
    RecipientResolver.invalidate();
    vi.spyOn(AdminModel, "findServerNotifyRecipients").mockResolvedValue([]);
    vi.spyOn(AdminModel, "getNamesByIds").mockResolvedValue(new Map());
    vi.spyOn(ServerAlertLogModel, "insertOne").mockResolvedValue();
    vi.spyOn(ServerAlertAckModel, "findAll").mockResolvedValue([]);
    vi.spyOn(MetricsService, "getSnapshot").mockImplementation(() => store.getSnapshot());
    sent = [];
    vi.spyOn(SharedTransporter.getTransporter(), "sendMail").mockImplementation(async (opts) => {
        sent.push(opts);
        return { messageId: "m" };
    });
});

afterEach(function () {
    notifier.stop();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    RecipientResolver.invalidate();
});

const record = (healthy, consecutiveFailures) =>
    store.recordPoolStats(XSS_POOL, { connectionsInUse: 0, connectionsOpen: 0, poolMax: 0, queueLength: 0, healthy, consecutiveFailures });

function assertSafe(mail) {
    expect(mail.html).not.toContain("<script>alert(1)</script>");
    expect(mail.html).not.toContain("<img src=x");
    expect(mail.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(mail.html).not.toMatch(/ORA-\d|NJS-\d/);
    for (const k of SECRET_KEYS) {
        if (process.env[k]) {
            expect(mail.html).not.toContain(process.env[k]);
            expect(mail.text).not.toContain(process.env[k]);
        }
    }
}

describe("Oracle outage emails — pool name escaping (CWE-79)", function () {
    it("DEGRADED, DOWN and RESOLVED emails escape a hostile pool name in the HTML part", async function () {
        record(true, 1);
        await notifier._pollTick();
        record(false, 3);
        await notifier._pollTick();
        store.recordPoolStats(XSS_POOL, { connectionsInUse: 0, connectionsOpen: 1, poolMax: 4, queueLength: 0, healthy: true, consecutiveFailures: 0 });
        await notifier._pollTick();

        const kinds = sent.map((m) => m.subject.match(/^\[CATHERINE\]\[(\w+)\] ([\w-]+):/).slice(1).join(" "));
        expect(kinds).toEqual(expect.arrayContaining([
            "WARNING server-dependencies-notification",
            "CRITICAL server-critical-notification",
            "RESOLVED server-critical-notification",
        ]));
        for (const mail of sent) assertSafe(mail);

        // The rule row with the (escaped) pool really is rendered on the critical channel.
        const resolved = sent.find((m) => m.subject.startsWith("[CATHERINE][RESOLVED] server-critical-notification:"));
        expect(resolved.html).toContain("ORACLE_POOL_DOWN &middot; appDb&quot;&gt;&lt;script&gt;");
    });
});
