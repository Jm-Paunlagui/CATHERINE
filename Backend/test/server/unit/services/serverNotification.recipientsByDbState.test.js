"use strict";

/**
 * @fileoverview Server alert recipients depend on whether the
 * database answered the Access Control opt-in lookup.
 *
 *   - Database answering (last lookup succeeded): Access Control opt-ins only.
 *     SERVER_NOTIFY_TO is left out, so an admin whose opt-in address differs from
 *     the SERVER_NOTIFY_TO address is no longer emailed twice (the reported
 *     duplicate: one address via SERVER_NOTIFY_TO + another via opt-in).
 *   - Database answering but nobody opted into the channel: SERVER_NOTIFY_TO, so
 *     a channel is never silent.
 *   - Database down (last lookup failed, or cold boot with no successful lookup):
 *     SERVER_NOTIFY_TO only — the cached opt-in list is not used.
 */

const ServerNotificationService = require("../../../../src/services/email/ServerNotificationService");
const RecipientResolver = require("../../../../src/services/email/RecipientResolver");
const AdminModel = require("../../../../src/models/admin.model");
const { logger } = require("../../../../src/utils/logger");

const CH = "server-critical-notification";
const ENV_ADDR = "ops@example.com";
const OPT_IN = "admin@example.org";

function freshResolver() {
    RecipientResolver._cache = new Map();
    RecipientResolver._lastRefreshAt = 0;
    RecipientResolver._refreshPromise = null;
    RecipientResolver._lastRefreshOk = false;
}

function dbUp(emailsByChannel = { [CH]: [OPT_IN] }) {
    vi.spyOn(AdminModel, "findServerNotifyRecipients").mockImplementation(async (ch) => emailsByChannel[ch] ?? []);
}

function dbDown() {
    vi.spyOn(AdminModel, "findServerNotifyRecipients").mockRejectedValue(new Error("ORA-12541: no listener"));
}

beforeEach(function () {
    vi.stubEnv("SERVER_NOTIFY_TO", ENV_ADDR);
    vi.stubEnv("RECIPIENT_REFRESH_MIN", "5");
    vi.spyOn(logger, "warning").mockImplementation(() => {});
    freshResolver();
});

afterEach(function () {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    freshResolver();
});

describe("server alert recipients follow the database state", function () {
    it("database answering: opt-ins only, SERVER_NOTIFY_TO left out (no duplicate email)", async function () {
        dbUp();
        expect(await ServerNotificationService.resolveRecipients(CH)).toEqual([OPT_IN]);
    });

    it("database answering, nobody opted in: falls back to SERVER_NOTIFY_TO so the channel is never silent", async function () {
        dbUp({});
        expect(await ServerNotificationService.resolveRecipients(CH)).toEqual([ENV_ADDR]);
    });

    it("cold boot with the database down: SERVER_NOTIFY_TO only", async function () {
        dbDown();
        expect(await ServerNotificationService.resolveRecipients(CH)).toEqual([ENV_ADDR]);
    });

    it("database goes down after a good lookup: SERVER_NOTIFY_TO only, the cached opt-ins are not used", async function () {
        dbUp();
        expect(await ServerNotificationService.resolveRecipients(CH)).toEqual([OPT_IN]);

        vi.restoreAllMocks();
        vi.spyOn(logger, "warning").mockImplementation(() => {});
        dbDown();
        RecipientResolver.invalidate();
        expect(await ServerNotificationService.resolveRecipients(CH)).toEqual([ENV_ADDR]);
    });

    it("database back up: opt-ins only again", async function () {
        dbDown();
        expect(await ServerNotificationService.resolveRecipients(CH)).toEqual([ENV_ADDR]);

        vi.restoreAllMocks();
        vi.spyOn(logger, "warning").mockImplementation(() => {});
        dbUp();
        RecipientResolver.invalidate();
        expect(await ServerNotificationService.resolveRecipients(CH)).toEqual([OPT_IN]);
    });

    it("database answering with SERVER_NOTIFY_TO unset: opt-ins only", async function () {
        vi.stubEnv("SERVER_NOTIFY_TO", "");
        dbUp();
        expect(await ServerNotificationService.resolveRecipients(CH)).toEqual([OPT_IN]);
    });

    it("database down with SERVER_NOTIFY_TO unset: nobody (the send reports no-recipients)", async function () {
        vi.stubEnv("SERVER_NOTIFY_TO", "");
        dbDown();
        expect(await ServerNotificationService.resolveRecipients(CH)).toEqual([]);
    });

    it("pool health monitor says appDb is down: SERVER_NOTIFY_TO at once, without waiting for the cache to expire", async function () {
        dbUp();
        expect(await ServerNotificationService.resolveRecipients(CH)).toEqual([OPT_IN]);

        const db = require("../../../../src/config");
        vi.spyOn(db, "isPoolHealthy").mockImplementation((name) => name !== "appDb");
        // No invalidate(): the cached successful lookup is still fresh.
        expect(await ServerNotificationService.resolveRecipients(CH)).toEqual([ENV_ADDR]);

        db.isPoolHealthy.mockReturnValue(true);
        expect(await ServerNotificationService.resolveRecipients(CH)).toEqual([OPT_IN]);
    });

    it("a lookup that hangs past the wait counts as down: SERVER_NOTIFY_TO only", async function () {
        dbUp();
        expect(await ServerNotificationService.resolveRecipients(CH)).toEqual([OPT_IN]);

        vi.restoreAllMocks();
        vi.spyOn(logger, "warning").mockImplementation(() => {});
        vi.spyOn(AdminModel, "findServerNotifyRecipients").mockImplementation(() => new Promise(() => {}));
        const saved = RecipientResolver.constructor.REFRESH_WAIT_MS;
        RecipientResolver.constructor.REFRESH_WAIT_MS = 20;
        try {
            RecipientResolver.invalidate();
            expect(await ServerNotificationService.resolveRecipients(CH)).toEqual([ENV_ADDR]);
        } finally {
            RecipientResolver.constructor.REFRESH_WAIT_MS = saved;
            RecipientResolver._refreshPromise = null;
        }
    });
});
