"use strict";

/**
 * @fileoverview AlertSignatureStore - remembers "the finding I last
 * emailed" for a rule across process restarts, so an unchanged alert is not
 * re-sent after a restart.
 *
 * STATE LIVES IN SERVER_ALERT_LOG - no schema change. One
 * "state row" is written per transition:
 *   FIRED     severity CRITICAL, EMAIL_STATUS SKIPPED, DETAILS carries the
 *             keyed signature hash (never member ids - F2).
 *   RECOVERED severity RESOLVED, EMAIL_STATUS SKIPPED, VALUE_NUM 0.
 * EMAIL_STATUS is SKIPPED because this row sends nothing; the email's own row
 * is the critical tap's CRITICAL_LOG row. The latest row per
 * `<rule>::<scopeKey>` decides the state.
 *
 * Writes go straight to the model, NOT through AlertNotifierService's queue:
 * that service only runs when notifications are enabled, and dedupe state must
 * persist regardless. This class must not import AlertNotifierService.
 *
 * Nothing here throws: a read failure yields `undefined` ("unknown", caller
 * fails open and escalates - the safe direction); a write failure yields
 * `false`. Both log one warning.
 *
 * Security: CWE-359 (no identifiers stored), CWE-89 (binds only, in the model).
 */

const ServerAlertLogModel = require("../models/serverAlertLog.model");

const STATE_CHANNEL = "server-critical-notification";

class AlertSignatureStore {
    /**
     * @param {object} deps
     * @param {string} deps.rule - Rule name, e.g. "ORPHAN_ORDER_ROWS" (<= 64 chars).
     * @param {{findLatestByAlertKey: Function, insertOne: Function}} [deps.model]
     * @param {{warning: Function}} deps.logger
     * @param {{readFailed: Function, writeFailed: Function}} deps.messages -
     *   (scopeKey, cause, label) => string, from the module's constants/messages file.
     */
    constructor({ rule, model = ServerAlertLogModel, logger, messages }) {
        this._rule = rule;
        this._model = model;
        this._logger = logger;
        this._messages = messages;
    }

    /** @param {string} scopeKey @returns {string} */
    alertKey(scopeKey) {
        return `${this._rule}::${scopeKey}`;
    }

    /**
     * @param {string} scopeKey - e.g. the period or batch id the signature covers.
     * @param {{label?: string}} [opts]
     * @returns {Promise<string|null|undefined>} the last FIRED signature hash;
     *   null = nothing alerted (no row, or the last row is RECOVERED);
     *   undefined = the read failed (unknown).
     */
    async getLastSignature(scopeKey, { label = "" } = {}) {
        try {
            const row = await this._model.findLatestByAlertKey(this._rule, this.alertKey(scopeKey));
            if (!row || row.TRANSITION !== "FIRED") return null;
            const hash = row.DETAILS?.signatureHash;
            return typeof hash === "string" && hash ? hash : null;
        } catch (err) {
            this._warn(this._messages.readFailed, scopeKey, err, label);
            return undefined;
        }
    }

    /**
     * @param {string} scopeKey
     * @param {{signatureHash: string, kind: string, count: number, label: string, description: string}} f
     * @returns {Promise<boolean>} true when the row was written
     */
    async recordFired(scopeKey, { signatureHash, kind, count, label, description }) {
        return this._insert(
            scopeKey,
            label,
            {
                severity: "CRITICAL",
                transition: "FIRED",
                valueNum: count,
                description,
                details: { signatureHash, kind, count, label, stateRow: true },
            },
        );
    }

    /**
     * @param {string} scopeKey
     * @param {{label: string, description: string}} r
     * @returns {Promise<boolean>} true when the row was written
     */
    async recordResolved(scopeKey, { label, description }) {
        return this._insert(scopeKey, label, {
            severity: "RESOLVED",
            transition: "RECOVERED",
            valueNum: 0,
            description,
            details: { signatureHash: null, kind: null, count: 0, label, stateRow: true },
        });
    }

    /** @private */
    async _insert(scopeKey, label, row) {
        try {
            await this._model.insertOne({
                alertKey: this.alertKey(scopeKey),
                rule: this._rule,
                channel: STATE_CHANNEL,
                notificationId: null,
                emailStatus: "SKIPPED",
                emailError: null,
                ...row,
            });
            return true;
        } catch (err) {
            this._warn(this._messages.writeFailed, scopeKey, err, label);
            return false;
        }
    }

    /** @private */
    _warn(template, scopeKey, err, label) {
        try {
            this._logger.warning(template(scopeKey, err?.message ?? String(err), label));
        } catch {
            /* logging must never break the sweep */
        }
    }
}

module.exports = AlertSignatureStore;
