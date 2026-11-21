"use strict";

/**
 * @fileoverview ServerAlertAckModel — currently acknowledged alerts.
 *
 * TABLE NAME (dynamic): `SERVER_ALERT_ACK_TABLE` env var when set; otherwise
 * `T_SERVER_ALERT_ACK` in production and `T_SERVER_ALERT_ACK_DEV` everywhere
 * else — the same resolution rule the audit-log model uses.
 *
 * WHAT THIS FILE DOES
 * -------------------
 * Thin data-access layer over the ack table — one row per alert that is
 * acknowledged RIGHT NOW. Unlike `serverAlertLog.model.js` (append-only
 * history) this table is a live set: `upsert()` replaces the row on every
 * (re-)acknowledge; `remove()` deletes it on unack, recovery, TTL expiry, or
 * escalation override.
 *
 * Every column here is a plain scalar (no CLOB), so this model uses the
 * standard `OracleCollection` surface directly — no raw-connection escape
 * hatch, in contrast to the alert-log model's DETAILS CLOB. `updateOne(filter,
 * update, { upsert: true })` takes the "UPDATE, and if zero rows matched then
 * plain INSERT" path, which involves no RETURNING clause on either branch — so
 * the "insertOne on a non-IDENTITY primary key needs `{ returning: [...] }`"
 * gotcha (ORA-00904 / ORA-32795) does not apply here.
 *
 * In DEMO_MODE the set lives in memory; no Oracle connection is opened.
 *
 * HOW IT WORKS
 * ------------
 *   - upsert(row)       — insert-or-replace keyed on ALERT_KEY. Re-acking an
 *                         already-acked key overwrites every column with a
 *                         fresh ACKED_AT / EXPIRES_AT / SEVERITY_AT_ACK / NOTE.
 *   - remove(alertKey)  — deletes the ack row; a missing key is a no-op, not an error.
 *   - findOne(alertKey) — single-row read.
 *   - findAll()         — every currently-acked row, used to hydrate
 *                         AlertNotifierService's in-memory ack map at start().
 *                         A restart must never lose an active ack, or the
 *                         cooldown nag resumes against an incident someone
 *                         already owns.
 *
 * EXAMPLE
 * -------
 *   const ServerAlertAckModel = require("./serverAlertAck.model");
 *   await ServerAlertAckModel.upsert({
 *       alertKey: "HIGH_LATENCY::POST /api/v1/auth/login",
 *       ackedBy: 3,
 *       expiresAt: new Date(Date.now() + 24 * 3_600_000),
 *       severityAtAck: "WARNING",
 *       note: "Known issue, ticket OPS-123 filed.",
 *   });
 *   const acks = await ServerAlertAckModel.findAll(); // hydrate on boot
 *   await ServerAlertAckModel.remove("HIGH_LATENCY::POST /api/v1/auth/login");
 */

const { createDb, OracleCollection } = require("../utils/oracle-mongo-wrapper");
const { isDemoMode } = require("../config/demoMode");

/** @returns {string} Resolved table name (env override or NODE_ENV default). */
function resolveTableName() {
    if (process.env.SERVER_ALERT_ACK_TABLE)
        return process.env.SERVER_ALERT_ACK_TABLE;
    return process.env.NODE_ENV === "production"
        ? "T_SERVER_ALERT_ACK"
        : "T_SERVER_ALERT_ACK_DEV";
}

let _col = null;
/** Lazily resolves the ack collection (never called in DEMO_MODE). */
function col() {
    if (!_col)
        _col = new OracleCollection(resolveTableName(), createDb("appDb"));
    return _col;
}

/** @type {Map<string, object>} DEMO_MODE store, keyed by ALERT_KEY. */
const _demoAcks = new Map();

class ServerAlertAckModel {
    /**
     * Upserts the acknowledgement row for `row.alertKey`. Re-acking an
     * already-acked key overwrites ACKED_BY / ACKED_AT / EXPIRES_AT /
     * SEVERITY_AT_ACK / NOTE with the new values.
     *
     * @param {object} row
     * @param {string} row.alertKey - Identity key: rule + "::" + (route ?? pool ?? "global")
     * @param {number|string} row.ackedBy - Admin id of the acknowledging user
     * @param {Date} row.expiresAt - ACKED_AT + ALERT_ACK_TTL_HOURS
     * @param {"WARNING"|"CRITICAL"} row.severityAtAck - Escalation-override baseline
     * @param {string|null} [row.note]
     * @returns {Promise<void>}
     */
    static async upsert(row) {
        const alertKey = String(row.alertKey).slice(0, 200);
        const fields = {
            ACKED_BY: Number(row.ackedBy),
            ACKED_AT: new Date(),
            EXPIRES_AT: row.expiresAt,
            SEVERITY_AT_ACK: row.severityAtAck,
            NOTE: row.note != null ? String(row.note).slice(0, 500) : null,
        };

        if (isDemoMode()) {
            _demoAcks.set(alertKey, { ALERT_KEY: alertKey, ...fields });
            return;
        }

        await col().updateOne(
            { ALERT_KEY: alertKey },
            { $set: fields },
            { upsert: true },
        );
    }

    /**
     * Deletes the ack row for `alertKey` — unack, recovery, TTL expiry, and
     * escalation-clear all funnel through here. A missing key is not an error.
     *
     * @param {string} alertKey
     * @returns {Promise<boolean>} true when a row was actually deleted
     */
    static async remove(alertKey) {
        if (isDemoMode()) return _demoAcks.delete(alertKey);
        const result = await col().deleteOne({ ALERT_KEY: alertKey });
        return (result?.deletedCount ?? 0) > 0;
    }

    /**
     * Reads a single ack row.
     *
     * @param {string} alertKey
     * @returns {Promise<object|null>}
     */
    static async findOne(alertKey) {
        if (isDemoMode()) return _demoAcks.get(alertKey) ?? null;
        return col().findOne({ ALERT_KEY: alertKey });
    }

    /**
     * Returns every currently-acked row — used to hydrate
     * AlertNotifierService's in-memory ack map at start().
     *
     * @returns {Promise<object[]>}
     */
    static async findAll() {
        if (isDemoMode()) return [..._demoAcks.values()];
        return col().find({}).toArray();
    }
}

module.exports = ServerAlertAckModel;
module.exports.resolveTableName = resolveTableName;
