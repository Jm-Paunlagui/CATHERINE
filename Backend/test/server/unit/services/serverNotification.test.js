"use strict";

/**
 * @fileoverview Unit tests for ServerNotificationService — the server-email-
 * notifications sender. Stubs SharedTransporter's shared nodemailer
 * transporter (`vi.spyOn`, not a `vi.mock` factory — the module exports a
 * CJS singleton instance), matching the established pattern in
 * emailProtection.test.js / qrStubEmailService.test.js.
 *
 * Covers (server-email-notifications-plan.md step 11 + Phase 2):
 *   - recipient resolution: env floor parsing/dedupe; DB opt-ins while the DB
 *     answers, SERVER_NOTIFY_TO otherwise (Phase 2 — Access Control recipients; see recipientResolver.test.js
 *     for RecipientResolver's own cache/staleness/invalidation contract)
 *   - subject/body content + HTML-escaping of injected alert rows (CWE-79)
 *   - send failure → logger.warning (never throws), recordNotificationDelivery(false)
 *   - send success → recordNotificationDelivery(true)
 *   - disabled / unknown channel / no recipients → no-op, no SMTP call
 *   - loop guard (R1b): every logger call in this service carries `_noNotify: true`
 *
 * AdminModel.findServerNotifyRecipients is ALWAYS stubbed here (never hit a real Oracle connection) — RecipientResolver
 * is invalidated in beforeEach so no state leaks between tests in this file.
 */

const SharedTransporter = require("../../../../src/services/email/SharedTransporter");
const ServerNotificationService = require("../../../../src/services/email/ServerNotificationService");
const RecipientResolver = require("../../../../src/services/email/RecipientResolver");
const AdminModel = require("../../../../src/models/admin.model");
const { metricsStore } = require("../../../../src/middleware/metrics");
const { logger } = require("../../../../src/utils/logger");

const ORIGINAL_ENV = { ...process.env };

function enable(recipients = "ops@example.com") {
    process.env.ENABLE_SERVER_NOTIFICATIONS = "true";
    process.env.SERVER_NOTIFY_TO = recipients;
}

beforeEach(function () {
    RecipientResolver.invalidate();
    // Default: no DB opt-ins, so every test is env-floor-only unless it
    // explicitly overrides this stub to exercise the union path.
    vi.spyOn(AdminModel, "findServerNotifyRecipients").mockResolvedValue([]);
});

afterEach(function () {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
    RecipientResolver.invalidate();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Recipient resolution — env floor (Phase 1 behavior, still exercised)
// ═══════════════════════════════════════════════════════════════════════════════

describe("ServerNotificationService.resolveRecipients — env floor", function () {
    it("returns [] when SERVER_NOTIFY_TO is unset and there are no DB opt-ins", async function () {
        delete process.env.SERVER_NOTIFY_TO;
        expect(await ServerNotificationService.resolveRecipients("server-system-notification")).toEqual([]);
    });

    it("returns [] when SERVER_NOTIFY_TO is an empty string", async function () {
        process.env.SERVER_NOTIFY_TO = "";
        expect(await ServerNotificationService.resolveRecipients("server-system-notification")).toEqual([]);
    });

    it("parses a comma-separated list and trims whitespace", async function () {
        process.env.SERVER_NOTIFY_TO = " a@x.com , b@x.com ,c@x.com";
        expect(await ServerNotificationService.resolveRecipients("server-system-notification")).toEqual([
            "a@x.com",
            "b@x.com",
            "c@x.com",
        ]);
    });

    it("dedupes repeated addresses", async function () {
        process.env.SERVER_NOTIFY_TO = "a@x.com,b@x.com,a@x.com";
        expect(await ServerNotificationService.resolveRecipients("server-system-notification")).toEqual([
            "a@x.com",
            "b@x.com",
        ]);
    });

    it("drops empty entries from stray commas", async function () {
        process.env.SERVER_NOTIFY_TO = "a@x.com,,  ,b@x.com,";
        expect(await ServerNotificationService.resolveRecipients("server-system-notification")).toEqual([
            "a@x.com",
            "b@x.com",
        ]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Recipient resolution — Phase 2: DB opt-ins while the DB answers, else env
// ═══════════════════════════════════════════════════════════════════════════════

describe("ServerNotificationService.resolveRecipients — Phase 2 DB opt-ins vs env fallback", function () {
    it("database up with opt-ins: mails only the DB opt-in emails (SERVER_NOTIFY_TO excluded)", async function () {
        process.env.SERVER_NOTIFY_TO = "ops@example.com";
        AdminModel.findServerNotifyRecipients.mockImplementation(async (channel) =>
            channel === "server-system-notification" ? ["admin1@example.com", "admin2@example.com"] : [],
        );

        const out = await ServerNotificationService.resolveRecipients("server-system-notification");
        expect(out.sort()).toEqual(["admin1@example.com", "admin2@example.com"].sort());
    });

    it("dedupes when a DB opt-in email is already in the env floor", async function () {
        process.env.SERVER_NOTIFY_TO = "admin1@example.com";
        AdminModel.findServerNotifyRecipients.mockResolvedValue(["admin1@example.com", "admin1@example.com"]);

        const out = await ServerNotificationService.resolveRecipients("server-system-notification");
        expect(out).toEqual(["admin1@example.com"]);
    });

    it("drops opted-in admins with no email address", async function () {
        process.env.SERVER_NOTIFY_TO = "";
        AdminModel.findServerNotifyRecipients.mockResolvedValue([null, ""]);

        expect(await ServerNotificationService.resolveRecipients("server-system-notification")).toEqual([]);
    });

    it("cold boot / DB down: getDbRecipients failure still returns the env floor alone (never throws)", async function () {
        process.env.SERVER_NOTIFY_TO = "ops@example.com";
        AdminModel.findServerNotifyRecipients.mockRejectedValue(new Error("ORA-12541"));

        const out = await ServerNotificationService.resolveRecipients("server-system-notification");
        expect(out).toEqual(["ops@example.com"]);
    });

    it("channels resolve independently — a DB opt-in for one channel does not leak into another", async function () {
        process.env.SERVER_NOTIFY_TO = "";
        AdminModel.findServerNotifyRecipients.mockImplementation(async (channel) =>
            channel === "server-critical-notification" ? ["crit@example.com"] : [],
        );

        expect(await ServerNotificationService.resolveRecipients("server-critical-notification")).toEqual([
            "crit@example.com",
        ]);
        expect(await ServerNotificationService.resolveRecipients("server-system-notification")).toEqual([]);
    });
});

describe("ServerNotificationService.invalidateRecipientCache", function () {
    it("forces the next resolveRecipients call to re-query the DB", async function () {
        process.env.SERVER_NOTIFY_TO = "";
        AdminModel.findServerNotifyRecipients.mockResolvedValue([]);
        await ServerNotificationService.resolveRecipients("server-system-notification");
        expect(AdminModel.findServerNotifyRecipients).toHaveBeenCalled();

        AdminModel.findServerNotifyRecipients.mockClear();
        // Within the refresh interval — should NOT re-query.
        await ServerNotificationService.resolveRecipients("server-system-notification");
        expect(AdminModel.findServerNotifyRecipients).not.toHaveBeenCalled();

        ServerNotificationService.invalidateRecipientCache();
        await ServerNotificationService.resolveRecipients("server-system-notification");
        expect(AdminModel.findServerNotifyRecipients).toHaveBeenCalled();
    });
});

describe("ServerNotificationService.maskEmail", function () {
    it("keeps the first local-part character and the full domain", function () {
        expect(ServerNotificationService.maskEmail("johnmoisespaunlagui113@gmail.com")).toMatch(
            /^j\*+@gmail\.com$/,
        );
    });

    it("returns *** for an unparseable value", function () {
        expect(ServerNotificationService.maskEmail("not-an-email")).toBe("***");
        expect(ServerNotificationService.maskEmail(null)).toBe("***");
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// isEnabled / master switch
// ═══════════════════════════════════════════════════════════════════════════════

describe("ServerNotificationService.isEnabled", function () {
    it("defaults to false when ENABLE_SERVER_NOTIFICATIONS is unset", function () {
        delete process.env.ENABLE_SERVER_NOTIFICATIONS;
        expect(ServerNotificationService.isEnabled()).toBe(false);
    });

    it("is true only for the exact string 'true'", function () {
        process.env.ENABLE_SERVER_NOTIFICATIONS = "true";
        expect(ServerNotificationService.isEnabled()).toBe(true);
        process.env.ENABLE_SERVER_NOTIFICATIONS = "yes";
        expect(ServerNotificationService.isEnabled()).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// sendChannelDigest — guard rails (no SMTP call)
// ═══════════════════════════════════════════════════════════════════════════════

describe("ServerNotificationService.sendChannelDigest — guard rails", function () {
    it("no-ops when disabled (no SMTP call)", async function () {
        delete process.env.ENABLE_SERVER_NOTIFICATIONS;
        process.env.SERVER_NOTIFY_TO = "ops@example.com";
        const sendMail = vi.spyOn(SharedTransporter.getTransporter(), "sendMail");

        const result = await ServerNotificationService.sendChannelDigest("server-system-notification", {
            severity: "WARNING",
            headline: "test",
            summary: "test",
            rows: [],
        });

        expect(result).toEqual({ sent: false, reason: "disabled" });
        expect(sendMail).not.toHaveBeenCalled();
    });

    it("no-ops on an unknown channel (no SMTP call, warns with _noNotify)", async function () {
        enable();
        const sendMail = vi.spyOn(SharedTransporter.getTransporter(), "sendMail");
        const warnSpy = vi.spyOn(logger, "warning");

        const result = await ServerNotificationService.sendChannelDigest("not-a-real-channel", {
            severity: "WARNING",
            headline: "test",
            summary: "test",
        });

        expect(result).toEqual({ sent: false, reason: "unknown-channel" });
        expect(sendMail).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalled();
        const [, meta] = warnSpy.mock.calls[warnSpy.mock.calls.length - 1];
        expect(meta._noNotify).toBe(true);
    });

    it("no-ops when there are no resolvable recipients (records a failed delivery)", async function () {
        process.env.ENABLE_SERVER_NOTIFICATIONS = "true";
        delete process.env.SERVER_NOTIFY_TO;
        const sendMail = vi.spyOn(SharedTransporter.getTransporter(), "sendMail");
        const recordSpy = vi.spyOn(metricsStore, "recordNotificationDelivery");
        const warnSpy = vi.spyOn(logger, "warning");

        const result = await ServerNotificationService.sendChannelDigest("server-system-notification", {
            severity: "WARNING",
            headline: "test",
            summary: "test",
        });

        expect(result).toEqual({ sent: false, reason: "no-recipients" });
        expect(sendMail).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalled();
        const [, meta] = warnSpy.mock.calls[warnSpy.mock.calls.length - 1];
        expect(meta._noNotify).toBe(true);
        // no-recipients is not a transporter-level delivery failure — no SMTP
        // attempt occurred, so no delivery outcome is recorded for it.
        expect(recordSpy).not.toHaveBeenCalled();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// sendChannelDigest — content, escaping, delivery recording
// ═══════════════════════════════════════════════════════════════════════════════

describe("ServerNotificationService.sendChannelDigest — content + delivery outcome", function () {
    beforeEach(function () {
        enable();
    });

    it("send success → recordNotificationDelivery(channel, true), sent:true with a notificationId", async function () {
        const sendMail = vi.spyOn(SharedTransporter.getTransporter(), "sendMail").mockResolvedValue({});
        const recordSpy = vi.spyOn(metricsStore, "recordNotificationDelivery");

        const result = await ServerNotificationService.sendChannelDigest("server-system-notification", {
            severity: "CRITICAL",
            headline: "Heap usage at 92%",
            summary: "1 alert is firing.",
            rows: [{ rule: "HIGH_HEAP", scope: "global", description: "desc", severity: "critical" }],
            kv: { heapUsedMb: 1900, heapLimitMb: 2048, heapPct: "92.8%", eventLoopLagMs: 12, gcOverheadPct: "3%" },
        });

        expect(result.sent).toBe(true);
        expect(result.notificationId).toMatch(/^NTF-/);
        expect(sendMail).toHaveBeenCalledTimes(1);
        expect(recordSpy).toHaveBeenCalledWith("server-system-notification", true);
    });

    it("send failure → logger.warning (never throws), recordNotificationDelivery(channel, false, cause)", async function () {
        vi.spyOn(SharedTransporter.getTransporter(), "sendMail").mockRejectedValue(
            new Error("SMTP connection refused"),
        );
        const recordSpy = vi.spyOn(metricsStore, "recordNotificationDelivery");
        const warnSpy = vi.spyOn(logger, "warning");

        const result = await ServerNotificationService.sendChannelDigest("server-system-notification", {
            severity: "WARNING",
            headline: "test",
            summary: "test",
            rows: [],
        });

        expect(result).toEqual({
            sent: false,
            reason: "send-error",
            cause: "SMTP connection refused",
            recipientCount: 1,
        });
        expect(recordSpy).toHaveBeenCalledWith(
            "server-system-notification",
            false,
            "SMTP connection refused",
        );
        expect(warnSpy).toHaveBeenCalled();
        const [, meta] = warnSpy.mock.calls[warnSpy.mock.calls.length - 1];
        expect(meta._noNotify).toBe(true); // R1b loop guard
    });

    it("builds the subject as [<APP_NAME>][<SEVERITY>] <channel>: <headline>", async function () {
        process.env.APP_NAME = "TESTAPP";
        let captured;
        vi.spyOn(SharedTransporter.getTransporter(), "sendMail").mockImplementation(async (opts) => {
            captured = opts;
            return {};
        });

        await ServerNotificationService.sendChannelDigest("server-dependencies-notification", {
            severity: "CRITICAL",
            headline: 'Oracle pool "appDb" unhealthy',
            summary: "test",
            rows: [],
        });

        expect(captured.subject).toBe(
            '[TESTAPP][CRITICAL] server-dependencies-notification: Oracle pool "appDb" unhealthy',
        );
    });

    it("HTML-escapes dynamic row values (CWE-79) while the plain-text body stays literal", async function () {
        let captured;
        vi.spyOn(SharedTransporter.getTransporter(), "sendMail").mockImplementation(async (opts) => {
            captured = opts;
            return {};
        });

        const xss = '<script>alert(1)</script>';
        await ServerNotificationService.sendChannelDigest("server-system-notification", {
            severity: "WARNING",
            headline: "test",
            summary: "test",
            rows: [{ rule: "HIGH_HEAP", scope: "global", description: xss, severity: "warning" }],
        });

        expect(captured.html).not.toContain(xss);
        expect(captured.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
        expect(captured.html).not.toContain("{{alertRows}}");
        // Plain-text alternative is not HTML-rendered — literal value is fine there.
        expect(captured.text).toContain(xss);
    });

    it("HTML-escapes critical-channel row fields (message + requestId)", async function () {
        let captured;
        vi.spyOn(SharedTransporter.getTransporter(), "sendMail").mockImplementation(async (opts) => {
            captured = opts;
            return {};
        });

        await ServerNotificationService.sendChannelDigest("server-critical-notification", {
            severity: "CRITICAL",
            headline: "1 critical event",
            summary: "test",
            rows: [
                {
                    level: "CRITICAL",
                    module: "OracleAdapter",
                    message: '<img src=x onerror=alert(1)>',
                    requestId: "req_123",
                    time: "10:00:00.000",
                },
            ],
            kv: { eventCount: 1, windowLabel: "30s", firstEventAt: new Date().toISOString() },
        });

        expect(captured.html).not.toContain("<img src=x onerror=alert(1)>");
        expect(captured.html).toContain("&lt;img");
        expect(captured.html).toContain("req_123");
    });

    it("attaches the AUMOVIO logos as cid attachments", async function () {
        let captured;
        vi.spyOn(SharedTransporter.getTransporter(), "sendMail").mockImplementation(async (opts) => {
            captured = opts;
            return {};
        });

        await ServerNotificationService.sendChannelDigest("server-red-metrics-notification", {
            severity: "WARNING",
            headline: "test",
            summary: "test",
            rows: [],
        });

        const cids = captured.attachments.map((a) => a.cid);
        expect(cids).toContain("app-logo-light");
        expect(cids).toContain("app-logo-dark");
    });

    it("adds a recent-send entry retrievable via getRecentSends()", async function () {
        vi.spyOn(SharedTransporter.getTransporter(), "sendMail").mockResolvedValue({});
        await ServerNotificationService.sendChannelDigest("server-system-notification", {
            severity: "WARNING",
            headline: "distinctive-headline-for-test",
            summary: "test",
            rows: [],
        });
        const recent = ServerNotificationService.getRecentSends();
        expect(recent.some((r) => r.headline === "distinctive-headline-for-test" && r.sent === true)).toBe(
            true,
        );
    });
});
