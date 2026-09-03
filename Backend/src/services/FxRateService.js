"use strict";

/**
 * @fileoverview FxRateService — resolves an exchange rate as of a date.
 *
 * ============================================================================
 * SCOPE: SHAPE + SERVICE + ADAPTER INTERFACE. NO PROVIDER INTEGRATION. (§3.7.9)
 * ============================================================================
 * The template ships the rate TABLE SHAPE, this service, and a documented
 * adapter interface — and nothing more. Manual admin entry is the only shipped
 * path. A scheduled pull from an external rate provider is a documented adapter
 * a copier implements; it is deliberately NOT built here.
 *
 * The engineering case is YAGNI: a provider integration drags in an outbound
 * dependency and therefore a timeout, a bounded retry budget with jitter, a
 * circuit breaker in /health/deps, an SSRF host allow-list (CWE-918), API-key
 * secret management, and provider rate-limit handling — all to populate a table
 * the template itself never reads. `RetryPolicy` and `BatchGuard` are already in
 * the tree, so a copier who needs it has the parts.
 *
 * The accounting case is stronger: a rate used for reporting conversion must be
 * AUDITABLE — who set it, when, from what source, effective over what window.
 * A manually entered rate with an audit row satisfies that; a silent API pull
 * does not unless it records the same facts, which is why every rate row carries
 * them regardless of source.
 *
 * ============================================================================
 * TABLE SHAPE (reference DDL lives commented in Backend/sql/README.md)
 * ============================================================================
 *   CURRENCY_CODE   VARCHAR2(3)   ISO 4217, the NON-base side. The base currency
 *                                 is a system fact (MONEY_BASE_CURRENCY), never a
 *                                 column on a transaction row (§3.0 rule 1).
 *   RATE            NUMBER(19,8)  A rate, NEVER a posting (§3.7.3). Higher scale
 *                                 than a posted amount; read back as a STRING via
 *                                 the fetchTypeHandler, never a JS double.
 *   EFFECTIVE_FROM  DATE          Start of the window this rate governs.
 *   EFFECTIVE_TO    DATE (null)   End of the window; null = still in force.
 *   SOURCE          VARCHAR2(32)  'MANUAL' or a provider identifier.
 *   RETRIEVED_AT    DATE          When the value was obtained (distinct from when
 *                                 it takes effect).
 *   SET_BY          VARCHAR2(...) The admin or system principal responsible.
 *
 * ============================================================================
 * APPEND-ONLY (§3.7.9)
 * ============================================================================
 * Rate rows are append-only, exactly like ledger rows. A rate is NEVER UPDATEd;
 * a correction CLOSES the current window (sets EFFECTIVE_TO) and OPENS a new one.
 * Rule 4 requires that converting a historical figure reproduces the same rate
 * forever — an in-place rate edit silently rewrites every report that used it.
 *
 * ============================================================================
 * INERT UNTIL A COPIER CREATES THE TABLE
 * ============================================================================
 * The table is named by configuration (MONEY_FX_TABLE). With no such env var and
 * DEMO_MODE off, this service is inert — it throws a clear operational error
 * rather than querying a table that does not exist. Under DEMO_MODE=true it
 * resolves against the in-memory rate fixture, so the whole conversion path is
 * exercisable with zero schema.
 *
 * ============================================================================
 * ADAPTER INTERFACE (for a copier who DOES want a provider — build it yourself)
 * ============================================================================
 * A provider adapter is any object with:
 *
 *   async fetchRate(currencyCode, asOf): Promise<{
 *     rate: string,          // fixed-scale-8 string, e.g. "56.25000000"
 *     source: string,        // provider identifier, e.g. "ECB"
 *     retrievedAt: Date,     // when the provider was queried
 *   }>
 *
 * A copier registers an adapter and schedules it (node-cron is already a dep),
 * then calls `FxRateService.recordRate(...)` with the adapter's result so the
 * row lands append-only WITH its audit fields. This service never calls an
 * adapter itself — wiring one is the copier's decision, and its cost.
 */

const { AppError } = require("../constants/errors");
const { isValidCurrency } = require("../constants/currencies");
const { isDemoMode } = require("../config/demoMode");
const demo = require("../models/demo/demoStore");

// Rates are stored at scale 8 (NUMBER(19,8)) — a rate carries more precision than
// a posted amount and is never itself a posting (§3.7.3).
const RATE_SCALE = 8;

/**
 * Name of the FX rate table, from configuration. When unset (and not in demo
 * mode) the service is inert by design.
 * @returns {string|undefined}
 */
function fxTableName() {
    return process.env.MONEY_FX_TABLE;
}

/**
 * Whether `asOf` falls within a rate row's effective window. `EFFECTIVE_TO` null
 * means the window is still open.
 * @param {object} row
 * @param {Date} asOf
 * @returns {boolean}
 */
function _inWindow(row, asOf) {
    const from = row.EFFECTIVE_FROM instanceof Date ? row.EFFECTIVE_FROM : new Date(row.EFFECTIVE_FROM);
    if (asOf < from) return false;
    if (row.EFFECTIVE_TO == null) return true;
    const to = row.EFFECTIVE_TO instanceof Date ? row.EFFECTIVE_TO : new Date(row.EFFECTIVE_TO);
    return asOf <= to;
}

class FxRateService {
    /**
     * Resolves the rate for `currencyCode` in force at `asOf`. This is the
     * load-bearing accounting rule (§3.0 rule 4): a historical figure converts
     * with the rate that was effective on ITS OWN date, so inserting a newer rate
     * never changes a past report.
     *
     * @param {string} currencyCode - Registered ISO 4217 code (the non-base side).
     * @param {Date} [asOf=new Date()] - The date whose effective rate to resolve.
     * @returns {Promise<{currencyCode: string, rate: string, source: string,
     *   effectiveFrom: Date, effectiveTo: (Date|null), retrievedAt: (Date|null),
     *   setBy: (string|null)}>}
     * @throws {AppError} 400 on an unknown currency; 404 when no rate covers `asOf`;
     *   503 when the service is inert (no table configured, not in demo mode).
     */
    static async rateAsOf(currencyCode, asOf = new Date()) {
        if (!isValidCurrency(currencyCode)) {
            throw new AppError(`Unknown currency ${currencyCode} for FX lookup.`, 400, {
                type: "ValidationError",
            });
        }
        const when = asOf instanceof Date ? asOf : new Date(asOf);

        const rows = await FxRateService._loadRates(currencyCode);
        // Newest effective window that still covers `asOf` wins — a later
        // correction that opened after `asOf` must not shadow the historical rate.
        const candidates = rows
            .filter((r) => r.CURRENCY_CODE === currencyCode && _inWindow(r, when))
            .sort((a, b) => new Date(b.EFFECTIVE_FROM) - new Date(a.EFFECTIVE_FROM));

        const row = candidates[0];
        if (!row) {
            throw new AppError(`No FX rate for ${currencyCode} effective ${when.toISOString()}.`, 404, {
                type: "NotFoundError",
            });
        }
        return {
            currencyCode: row.CURRENCY_CODE,
            rate: String(row.RATE),
            source: row.SOURCE,
            effectiveFrom: row.EFFECTIVE_FROM,
            effectiveTo: row.EFFECTIVE_TO ?? null,
            retrievedAt: row.RETRIEVED_AT ?? null,
            setBy: row.SET_BY ?? null,
        };
    }

    /**
     * Appends a new rate row WITH its audit fields (§3.7.9). Never updates an
     * existing row. A correction should first close the current window
     * (EFFECTIVE_TO) then call this to open the new one.
     *
     * The rate MUST be a fixed-scale-8 string, never a JS number — a rate is a
     * NUMBER(19,8) and must not round-trip through a double.
     *
     * @param {Object} params
     * @param {string} params.currencyCode - ISO 4217 non-base code.
     * @param {string} params.rate - Fixed-scale-8 rate string, e.g. "56.25000000".
     * @param {Date} params.effectiveFrom - When the rate takes effect.
     * @param {Date} [params.effectiveTo=null] - Window end; null = still in force.
     * @param {string} params.source - 'MANUAL' or a provider identifier.
     * @param {string} params.setBy - The responsible admin/system principal.
     * @param {Date} [params.retrievedAt] - When the value was obtained.
     * @returns {Promise<{insertedId: number}>}
     * @throws {AppError} 400 on an unknown currency or a non-string rate.
     */
    static async recordRate(params) {
        const { currencyCode, rate, effectiveFrom, effectiveTo = null, source, setBy, retrievedAt } = params;
        if (!isValidCurrency(currencyCode)) {
            throw new AppError(`Unknown currency ${currencyCode} for FX rate.`, 400, {
                type: "ValidationError",
            });
        }
        if (typeof rate !== "string" || !/^\d+(\.\d+)?$/.test(rate)) {
            throw new AppError("FX rate must be a fixed-scale numeric string and never a JS number.", 400, {
                type: "ValidationError",
            });
        }
        const record = {
            CURRENCY_CODE: currencyCode,
            RATE: rate,
            EFFECTIVE_FROM: effectiveFrom instanceof Date ? effectiveFrom : new Date(effectiveFrom),
            EFFECTIVE_TO: effectiveTo == null ? null : effectiveTo instanceof Date ? effectiveTo : new Date(effectiveTo),
            SOURCE: source,
            SET_BY: setBy,
            RETRIEVED_AT: retrievedAt == null ? new Date() : retrievedAt instanceof Date ? retrievedAt : new Date(retrievedAt),
        };

        if (isDemoMode()) {
            const { insertedId } = demo.fxRateInsert(record);
            return { insertedId };
        }

        const table = fxTableName();
        if (!table) {
            throw new AppError("MONEY_FX_TABLE is not configured; FX rate service is inert.", 503, {
                type: "ConfigurationError",
            });
        }
        // Live path: append via the wrapper. Lazily required so the driver is not
        // pulled in under DEMO_MODE (matches the model lazy-require pattern).
        const { createDb, OracleCollection } = require("../utils/oracle-mongo-wrapper");
        const col = new OracleCollection(table, createDb("appDb"));
        const res = await col.insertOne(record);
        return { insertedId: res.insertedId };
    }

    /** @returns {number} The rate storage scale (NUMBER(19,8)). */
    static get rateScale() {
        return RATE_SCALE;
    }

    /**
     * Loads all rate rows for a currency from demo fixtures or the live table.
     * @param {string} currencyCode
     * @returns {Promise<object[]>}
     * @private
     */
    static async _loadRates(currencyCode) {
        if (isDemoMode()) {
            return demo.fxRates().filter((r) => r.CURRENCY_CODE === currencyCode);
        }
        const table = fxTableName();
        if (!table) {
            throw new AppError("MONEY_FX_TABLE is not configured; FX rate service is inert.", 503, {
                type: "ConfigurationError",
            });
        }
        const { createDb, OracleCollection } = require("../utils/oracle-mongo-wrapper");
        const col = new OracleCollection(table, createDb("appDb"));
        return col.find({ CURRENCY_CODE: currencyCode }).toArray();
    }
}

module.exports = { FxRateService, RATE_SCALE };
