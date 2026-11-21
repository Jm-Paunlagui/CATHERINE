"use strict";

/**
 * WHAT THIS FILE DOES
 * --------------------
 * Data-access layer for `T_SYSTEM_CONFIG_DEV` — a generic,
 * ROW_HASH-signed key/value application configuration store, reusable for
 * on/off or enum-valued toggles without a further migration.
 *
 * HOW IT WORKS
 * ------------
 * `createDb("appDb")` is bound ONCE at module top — never a bare `createDb()`
 * ("Pool safety" rule; a forgotten pool argument silently binds to
 * the wrapper's default pool instead). Every query goes through
 * oracle-mongo-wrapper's `OracleCollection`, which routes filters/updates
 * through `parseFilter`/`parseUpdate`'s per-call bind-variable counters — no
 * raw SQL string interpolation anywhere in this file.
 *
 *   - `findByKey(key)` — single-row PK read.
 *   - `upsert({ key, value, valueType, description, updatedBy, rowHash })` —
 *     insert-or-replace keyed on CONFIG_KEY, via `updateOne(..., { upsert:
 *     true })` (the same "UPDATE, and if zero rows matched then plain INSERT"
 *     idiom `serverAlertAck.model.js` uses — no MERGE statement, no separate
 *     read-then-branch). `description` is only written when explicitly
 *     supplied, so a routine mode flip never blanks out the seeded
 *     human-authored DESCRIPTION.
 *
 * EXAMPLE
 * -------
 *   const SystemConfigModel = require("./system.config.model");
 *   const row = await SystemConfigModel.findByKey("MAINTENANCE_MODE");
 *   await SystemConfigModel.upsert({
 *       key: "MAINTENANCE_MODE",
 *       value: "AUTO",
 *       valueType: "STRING",
 *       updatedBy: "40001",
 *       rowHash: "…64-char hex HMAC…",
 *   });
 *
 * BIND VARIABLE SAFETY
 * ---------------------
 * Every query uses oracle-mongo-wrapper's bind-variable pipeline. No raw
 * interpolation.
 */

const { createDb, OracleCollection } = require("../utils/oracle-mongo-wrapper");
const { isDemoMode } = require("../config/demoMode");
const demo = require("./demo/demoStore");

/**
 * Physical table (template `_DEV` convention; DDL in sql/01_schema.sql
 * section 9). NOT the same thing as the "T_SYSTEM_CONFIG" HMAC signing
 * context used by SystemConfigService — that string namespaces ROW_HASH and
 * must stay stable regardless of the table's physical name.
 */
const TABLE = "T_SYSTEM_CONFIG_DEV";

const _db = createDb("appDb");
const _config = new OracleCollection(TABLE, _db);

class SystemConfigModel {
    /**
     * Returns one T_SYSTEM_CONFIG row by its CONFIG_KEY primary key, or null
     * when no such key has been seeded/set.
     *
     * @param {string} key
     * @returns {Promise<{
     *   CONFIG_KEY: string,
     *   CONFIG_VALUE: string|null,
     *   VALUE_TYPE: string,
     *   DESCRIPTION: string|null,
     *   UPDATED_BY: string|null,
     *   UPDATED_AT: Date,
     *   ROW_HASH: string|null,
     * }|null>}
     */
    static async findByKey(key) {
        if (isDemoMode()) {
            const row = demo.systemConfig().get(String(key));
            return row ? { ...row } : null;
        }
        return _config.find({ CONFIG_KEY: String(key) }).next();
    }

    /**
     * Insert-or-replace one config row keyed on CONFIG_KEY.
     *
     * `description` is OPTIONAL and only included in the write when
     * explicitly supplied — a routine value change (e.g. flipping a
     * mode toggle) must not blank out the row's seeded, human-
     * authored DESCRIPTION every time an admin toggles the value.
     *
     * @param {object} params
     * @param {string} params.key
     * @param {string} params.value
     * @param {"STRING"|"BOOLEAN"|"NUMBER"} [params.valueType="STRING"]
     * @param {string} [params.description]
     * @param {string|number} params.updatedBy - numeric admin id (T_ADMINS_DEV.ID) of the acting admin
     * @param {string} params.rowHash - HMAC-SHA256 over the signed fields
     *   (CryptoVault.signRecord("T_SYSTEM_CONFIG", { CONFIG_KEY, CONFIG_VALUE }))
     * @returns {Promise<string>} the CONFIG_KEY written
     */
    static async upsert({
        key,
        value,
        valueType = "STRING",
        description,
        updatedBy,
        rowHash,
    }) {
        const setFields = {
            CONFIG_VALUE: value,
            VALUE_TYPE: valueType,
            UPDATED_BY: updatedBy != null ? String(updatedBy) : null,
            UPDATED_AT: new Date(),
            ROW_HASH: rowHash ?? null,
        };
        if (description !== undefined && description !== null) {
            setFields.DESCRIPTION = description;
        }

        if (isDemoMode()) {
            const store = demo.systemConfig();
            const k = String(key);
            const prev = store.get(k);
            store.set(k, {
                CONFIG_KEY: k,
                DESCRIPTION: prev?.DESCRIPTION ?? null,
                ...setFields,
            });
            return k;
        }

        await _config.updateOne(
            { CONFIG_KEY: String(key) },
            { $set: setFields },
            { upsert: true },
        );
        return String(key);
    }
}

module.exports = SystemConfigModel;
