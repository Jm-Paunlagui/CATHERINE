"use strict";

/**
 * @fileoverview Signed key/value application configuration (`T_SYSTEM_CONFIG`).
 *
 * The store is generic (CONFIG_KEY / CONFIG_VALUE / VALUE_TYPE). Each key a
 * project uses is registered in {@link CONFIG_KEYS} with its allow-listed
 * values and the SAFE default — the template registers none.
 *
 * FAIL-SAFE RULE — every unhappy path resolves to the key's safe default:
 *   - no row for the key (not seeded / purged / not yet restored)
 *   - a read failure (pool down, timeout, any ORA-* error)
 *   - a missing or failed ROW_HASH verification (unsigned or tampered row)
 * `getRaw()` is the single choke point that enforces this.
 *
 * NO CACHING: one indexed PK lookup, and an in-process cache cannot be
 * invalidated across cluster workers — a stale value in one worker after a
 * change in another is exactly the failure this design must not have.
 *
 * Every write is ROW_HASH-signed (domain "T_SYSTEM_CONFIG") and every read
 * verified via TamperDetectionService before its value is trusted.
 */

const SystemConfigModel = require("../models/system.config.model");
const TamperDetectionService = require("./TamperDetectionService");
const { CryptoVault } = require("../utils/encryption/CryptoVault");
const { AppError, HTTP_STATUS, VALIDATION_ERRORS } = require("../constants");
const { integrityMessages } = require("../constants/messages");
const { logger } = require("../utils/logger");

/**
 * Registered config keys: `{ [key]: { values: string[], defaultValue: string } }`.
 * Values are upper-cased, allow-listed and never interpolated into a query.
 * Projects register their own keys here, e.g.
 * `FEATURE_MODE: { values: ["MANUAL", "AUTO"], defaultValue: "MANUAL" }`.
 */
const CONFIG_KEYS = Object.freeze({});

class SystemConfigService {
    static CONFIG_KEYS = CONFIG_KEYS;

    /**
     * Reads and verifies one T_SYSTEM_CONFIG row. NEVER throws — every
     * unhappy path is logged and collapsed to `null`; callers apply the safe
     * default on `null`.
     *
     * @param {string} key
     * @returns {Promise<object|null>} the raw row, or null on any unhappy path
     */
    static async getRaw(key) {
        let row;
        try {
            row = await SystemConfigModel.findByKey(key);
        } catch (err) {
            logger.warning(integrityMessages.CONFIG_MISSING(key), {
                cause: err?.message ?? String(err),
            });
            return null;
        }

        if (!row) {
            logger.warning(integrityMessages.CONFIG_MISSING(key));
            return null;
        }

        // A row seeded in plain SQL has no ROW_HASH (signing needs
        // DATA_SIGNING_SECRET). That is not tamper evidence, so it logs at
        // warning — a crit here would page ops on every read of a fresh install.
        if (row.ROW_HASH == null) {
            logger.warning(integrityMessages.CONFIG_UNSIGNED(key));
            return null;
        }

        const intact = await TamperDetectionService.verifySystemConfigRow(row);
        if (!intact) {
            // A signature was present and did NOT match — tamper evidence.
            logger.critical(integrityMessages.CONFIG_TAMPERED(key));
            return null;
        }

        return row;
    }

    /**
     * The verified value of a registered key, or its safe default.
     *
     * @param {string} key - a key of {@link CONFIG_KEYS}
     * @returns {Promise<string>}
     */
    static async get(key) {
        const def = SystemConfigService._definition(key);
        const row = await SystemConfigService.getRaw(key);
        const value = String(row?.CONFIG_VALUE ?? "").trim().toUpperCase();
        return def.values.includes(value) ? value : def.defaultValue;
    }

    /**
     * The value plus its audit metadata.
     *
     * @param {string} key
     * @returns {Promise<{ value: string, updatedBy: string|null, updatedAt: Date|null }>}
     */
    static async getStatus(key) {
        const def = SystemConfigService._definition(key);
        const row = await SystemConfigService.getRaw(key);
        if (!row) return { value: def.defaultValue, updatedBy: null, updatedAt: null };
        const value = String(row.CONFIG_VALUE ?? "").trim().toUpperCase();
        return {
            value: def.values.includes(value) ? value : def.defaultValue,
            updatedBy: row.UPDATED_BY ?? null,
            updatedAt: row.UPDATED_AT ?? null,
        };
    }

    /**
     * Writes a registered key (signed).
     *
     * @param {string} key
     * @param {string} value - case-insensitive; must be allow-listed for the key
     * @param {string|number} adminId
     * @returns {Promise<{ value: string, updatedBy: string, updatedAt: Date }>}
     * @throws {AppError} 400 when the key is unknown or the value not allowed
     */
    static async set(key, value, adminId) {
        const def = SystemConfigService._definition(key);
        const normalized = String(value ?? "").trim().toUpperCase();
        if (!def.values.includes(normalized)) {
            throw new AppError(VALIDATION_ERRORS.INVALID_INPUT, HTTP_STATUS.BAD_REQUEST, {
                type: "ValidationError",
                details: [{ field: "value", issue: `Must be one of: ${def.values.join(" | ")}.` }],
            });
        }

        // Log line only — itself fails safe to the default.
        const previous = await SystemConfigService.get(key);

        const updatedBy = String(adminId);
        const rowHash = await CryptoVault.signRecord("T_SYSTEM_CONFIG", {
            CONFIG_KEY: key,
            CONFIG_VALUE: normalized,
        });

        await SystemConfigModel.upsert({
            key,
            value: normalized,
            valueType: "STRING",
            updatedBy,
            rowHash,
        });

        logger.notice(integrityMessages.CONFIG_CHANGED(key, previous, normalized, updatedBy));
        return { value: normalized, updatedBy, updatedAt: new Date() };
    }

    /**
     * @param {string} key
     * @returns {{ values: string[], defaultValue: string }}
     * @throws {AppError} 400 for an unregistered key
     * @private
     */
    static _definition(key) {
        const def = Object.prototype.hasOwnProperty.call(CONFIG_KEYS, key) ? CONFIG_KEYS[key] : null;
        if (!def) {
            throw new AppError(VALIDATION_ERRORS.INVALID_INPUT, HTTP_STATUS.BAD_REQUEST, {
                type: "ValidationError",
                details: [{ field: "key", issue: "Unknown configuration key." }],
            });
        }
        return def;
    }
}

module.exports = SystemConfigService;
