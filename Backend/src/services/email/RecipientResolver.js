"use strict";

/**
 * @fileoverview Server Email Notifications — Phase 2 recipient cache.
 *
 * WHAT THIS FILE DOES
 * -------------------
 * Resolves the Access Control DB opt-in half of `recipients(channel) = env
 * floor ∪ DB opt-ins` (server-email-notifications-plan.md "Phase 2 —
 * Recipients managed in Access Control"). Holds a short-TTL, per-channel,
 * last-known-good cache of resolved email addresses so a DB outage can
 * never mute a notification channel — the whole point of an ops-alert
 * pipeline is to still work when the database is the thing that's down.
 *
 * HOW IT WORKS
 * ------------
 * `getDbRecipients(channel)` refreshes ALL FOUR channels together (one
 * `Promise.all` wave of `AdminModel.findServerNotifyRecipients` calls)
 * whenever the cache is older than `RECIPIENT_REFRESH_MIN` (default 5)
 * minutes, then returns the cached list for the requested channel.
 *
 * - Cold boot (no successful refresh yet) + DB down → returns `[]` for
 *   every channel. `ServerNotificationService.resolveRecipients` still
 *   returns the env floor alone in this case — the DB half of the union
 *   contributes nothing, but nothing errors.
 * - Warm cache + DB goes down on a later refresh attempt → the stale
 *   snapshot keeps being served; the refresh failure is logged at
 *   `warning` with `_noNotify: true` (loop guard, R1b) and the cache
 *   timestamp is bumped anyway so the resolver backs off for a full
 *   interval before retrying (never hammers a down DB on every send).
 * - `invalidate()` forces the NEXT read to refresh immediately — call it from
 *   wherever your app writes a `CAN_RECEIVE_SRV_*` flag (e.g. an Access
 *   Control permissions endpoint, or `AdminModel.setNotifyFlags`' caller) so a
 *   toggle takes effect on the very next notification instead of waiting out
 *   the TTL.
 * - Concurrent callers during a refresh share ONE in-flight request
 *   (`_refreshPromise`) instead of firing N redundant DB round-trips.
 *
 * Addresses come straight from `T_ADMINS_DEV.EMAIL` via
 * `AdminModel.findServerNotifyRecipients`, which already drops admins with no
 * address on file. If your deployment keeps emails in a separate HR directory,
 * resolve them inside that model method — this resolver deliberately knows
 * nothing about where an address comes from.
 *
 * EXAMPLE
 * -------
 *   const RecipientResolver = require("./RecipientResolver");
 *   const emails = await RecipientResolver.getDbRecipients("server-system-notification");
 *   // later, after an Access Control flag toggle:
 *   RecipientResolver.invalidate();
 */

const { logger } = require("../../utils/logger");
const { notificationMessages } = require("../../constants/messages");

class RecipientResolver {
    constructor() {
        /** @type {Map<string, string[]>} channel -> resolved DB opt-in emails */
        this._cache = new Map();
        /** @type {number} ms timestamp of the last refresh attempt (success or failure) */
        this._lastRefreshAt = 0;
        /** @type {Promise<void>|null} in-flight refresh, shared by concurrent callers */
        this._refreshPromise = null;
    }

    /**
     * Returns the resolver's cached DB opt-in email list for `channel`,
     * refreshing first if the cache is stale. Never throws.
     *
     * @param {string} channel - One of the four server notification channel keys
     * @returns {Promise<string[]>}
     */
    async getDbRecipients(channel) {
        await this._maybeRefresh();
        return this._cache.get(channel) ?? [];
    }

    /**
     * Forces the next {@link getDbRecipients} call to refresh immediately,
     * regardless of TTL. Call after any `CAN_RECEIVE_SRV_*` flag write.
     */
    invalidate() {
        this._lastRefreshAt = 0;
    }

    /**
     * Minutes before the cache is considered stale, read live from env on
     * every call (not frozen at construction) so it can be changed per test.
     * @returns {number}
     */
    _refreshMinutes() {
        return Number(process.env.RECIPIENT_REFRESH_MIN) || 5;
    }

    /**
     * Refreshes the cache if stale. De-dupes concurrent callers onto one
     * in-flight refresh.
     * @returns {Promise<void>}
     */
    async _maybeRefresh() {
        const staleMs = this._refreshMinutes() * 60_000;
        const isStale = Date.now() - this._lastRefreshAt >= staleMs;
        if (!isStale) return;

        if (!this._refreshPromise) {
            this._refreshPromise = this._doRefresh().finally(() => {
                this._refreshPromise = null;
            });
        }
        await this._refreshPromise;
    }

    /**
     * Performs one refresh: fetches the opt-in email list for every channel in
     * parallel and replaces the cache wholesale. On failure the OLD cache is
     * left untouched (stale-serve) and the refresh timestamp is still bumped,
     * so a down DB is retried at most once per interval rather than on every
     * call.
     * @returns {Promise<void>}
     * @private
     */
    async _doRefresh() {
        // Lazy require — avoids a load-order cycle with admin.model.js pulling
        // in the DB config before it is ready, and keeps this file requirable
        // standalone in unit tests.
        const AdminModel = require("../../models/admin.model");

        try {
            const channels = Object.keys(AdminModel.SERVER_NOTIFY_FLAG_COLUMNS);
            const emailLists = await Promise.all(
                channels.map((channel) =>
                    AdminModel.findServerNotifyRecipients(channel),
                ),
            );

            const next = new Map();
            channels.forEach((channel, i) => {
                next.set(channel, emailLists[i]);
            });

            this._cache = next;
        } catch (err) {
            logger.warning(
                notificationMessages.EMAIL_FAILED(
                    "recipient-resolver",
                    `refresh failed, serving stale cache: ${err?.message ?? String(err)}`,
                ),
                { _noNotify: true }, // R1b loop guard
            );
            // _cache intentionally left untouched — stale-serve, or [] on cold boot.
        } finally {
            this._lastRefreshAt = Date.now();
        }
    }
}

module.exports = new RecipientResolver();
module.exports.RecipientResolver = RecipientResolver;
