"use strict";

/**
 * @fileoverview Data Purge & Restore table registry.
 *
 * Single source of truth for every table that may be purged or restored: its
 * group, pool, primary key (and whether it is an IDENTITY column), virtual
 * columns that must never appear in an INSERT list, FK edges to other
 * registered tables, DELETE / RESTORE ordering tiers, ROW_HASH domain, and the
 * NUMBER columns that are identifiers and must be serialised as exact digit
 * STRINGS on backup.
 *
 * `DataPurgeService`, `data-purge.model.js` and `BackupArchiveService` read
 * table names, ordering and FK edges from here ONLY — the scope of a purge or
 * restore is never taken from the HTTP request (CWE-89).
 *
 * The registry below ships the template's own platform tables as the example.
 * A project registers its own tables in PURGE_TABLES (and their groups in
 * PURGE_GROUP_KEYS); the module-load self-check validates every entry.
 */

/** Pool every purge/restore transaction and backup stream runs on (the bulk bulkhead). */
const PURGE_POOL = "appDbBulk";

/**
 * Tables that must NEVER enter a purge or restore plan, checked independently
 * of {@link PURGE_TABLES}. Projects list externally-owned tables here.
 *
 * @type {ReadonlyArray<string>}
 */
const NEVER_PURGE = Object.freeze([]);

/**
 * Trigger-stamped, update-immutable timestamp columns per table. A purge loses
 * their original values and a restore re-stamps them; surfaced as a fidelity
 * disclosure in the purge preview and the backup manifest. Projects register
 * their own tables here.
 *
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
const IMMUTABLE_TIMESTAMP_COLUMNS = Object.freeze({});

/**
 * Purge groups, keyed by a short identifier. Values are the literal group
 * labels used in API responses and FE badges.
 *
 * @type {Readonly<Record<string, string>>}
 */
const PURGE_GROUP_KEYS = Object.freeze({
    T: "T_",
    SERVER: "SERVER_",
});

/**
 * Closure rule: selecting a group auto-includes the dependents listed. The
 * transitive FK-edge closure in DataPurgeService is the authority; this map
 * only lets the FE explain why a group was pulled in. Leaf groups map to [].
 *
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
const GROUP_CLOSURE_HINTS = Object.freeze({
    [PURGE_GROUP_KEYS.T]: Object.freeze([]),
    [PURGE_GROUP_KEYS.SERVER]: Object.freeze([]),
});

/**
 * @typedef {object} FkEdge
 * @property {string} column    - The child table's FK column.
 * @property {string} refTable  - The parent table name.
 * @property {string} refColumn - The parent table's referenced column.
 */

/**
 * @typedef {object} PurgeTableEntry
 * @property {string} table             - Physical Oracle table name (unquoted — resolves in the pool's schema).
 * @property {string} group             - One of {@link PURGE_GROUP_KEYS}'s values.
 * @property {string} pool              - ALWAYS {@link PURGE_POOL}. Asserted by {@link getEntry} and at module load.
 * @property {string} pk                - Primary key column name.
 * @property {boolean} isIdentity       - true when pk is an IDENTITY column (restore must regenerate + remap).
 * @property {string[]} virtualColumns  - `GENERATED ALWAYS AS <expr> VIRTUAL` columns — excluded from INSERT lists (ORA-54013).
 * @property {FkEdge[]} fkEdges         - Child→parent FK edges to OTHER tables in this registry.
 * @property {number} deleteOrderTier   - Leaves→roots ordering. Lower runs first.
 * @property {number} restoreOrderTier  - Roots→leaves ordering. Lower runs first.
 * @property {string|null} rowHashDomain - CryptoVault.signRecord/verifyRecord domain key for the ROW_HASH column, or null.
 * @property {string[]} canonicalTimestampColumns - Signed TIMESTAMP columns exported as the canonical FF6 string. Usually empty.
 * @property {boolean} [appendOnlyLog]  - true for identity-PK log tables the app appends to continuously; purge only deletes `pk <= highWater` of the backup.
 * @property {string[]} identifierColumns - NUMBER identifier columns serialised as exact digit STRINGS on backup, never `Number()`.
 */

/**
 * The registry. Array order is irrelevant — the order tiers are the authority.
 *
 * @type {ReadonlyArray<Readonly<PurgeTableEntry>>}
 */
const PURGE_TABLES = Object.freeze(
    [
        {
            // Registered so the Access Control revoke-backup can archive an admin's row;
            // purging it needs `acknowledgeLockout` (DataPurgeService step 5).
            table: "T_ADMINS_DEV",
            group: PURGE_GROUP_KEYS.T,
            pool: PURGE_POOL,
            pk: "ID",
            isIdentity: true,
            virtualColumns: [],
            fkEdges: [],
            deleteOrderTier: 1,
            restoreOrderTier: 1,
            rowHashDomain: null,
            identifierColumns: ["ID"],
        },
        {
            table: "T_AUDIT_LOGS_DEV",
            group: PURGE_GROUP_KEYS.T,
            pool: PURGE_POOL,
            pk: "ID",
            isIdentity: true,
            appendOnlyLog: true,
            virtualColumns: [],
            fkEdges: [],
            deleteOrderTier: 1,
            restoreOrderTier: 1,
            rowHashDomain: null,
            identifierColumns: ["ID", "USER_ID"],
        },
        {
            table: "T_SERVER_ALERT_LOG_DEV",
            group: PURGE_GROUP_KEYS.SERVER,
            pool: PURGE_POOL,
            pk: "ID",
            isIdentity: true,
            appendOnlyLog: true,
            virtualColumns: [],
            fkEdges: [],
            deleteOrderTier: 1,
            restoreOrderTier: 1,
            rowHashDomain: null,
            identifierColumns: ["ID"],
        },
        {
            table: "T_SERVER_ALERT_ACK_DEV",
            group: PURGE_GROUP_KEYS.SERVER,
            pool: PURGE_POOL,
            pk: "ALERT_KEY", // natural VARCHAR2 PK
            isIdentity: false,
            virtualColumns: [],
            fkEdges: [],
            deleteOrderTier: 1,
            restoreOrderTier: 1,
            rowHashDomain: null,
            identifierColumns: ["ACKED_BY"],
        },
    ].map((entry) =>
        Object.freeze({
            ...entry,
            fkEdges: Object.freeze(entry.fkEdges.map((e) => Object.freeze({ ...e }))),
            virtualColumns: Object.freeze([...entry.virtualColumns]),
            identifierColumns: Object.freeze([...entry.identifierColumns]),
            canonicalTimestampColumns: Object.freeze([...(entry.canonicalTimestampColumns ?? [])]),
        }),
    ),
);

/** @type {Map<string, Readonly<PurgeTableEntry>>} */
const _byName = new Map(PURGE_TABLES.map((e) => [e.table, e]));

/**
 * Returns the registry entry for a table name, or null when unregistered.
 * Fails closed when a matched entry names any pool other than {@link PURGE_POOL}.
 *
 * @param {string} tableName
 * @returns {Readonly<PurgeTableEntry>|null}
 * @throws {Error} On registry corruption (wrong pool).
 */
function getEntry(tableName) {
    const entry = _byName.get(tableName);
    if (!entry) return null;
    if (entry.pool !== PURGE_POOL) {
        throw new Error(
            `purgeTables registry corruption: "${tableName}" has pool "${entry.pool}", expected "${PURGE_POOL}". Refusing to return this entry.`,
        );
    }
    return entry;
}

/**
 * @param {string} group - One of {@link PURGE_GROUP_KEYS}'s values.
 * @returns {ReadonlyArray<Readonly<PurgeTableEntry>>}
 */
function getTablesByGroup(group) {
    return PURGE_TABLES.filter((e) => e.group === group);
}

/** @returns {string[]} Every registered table name. */
function getAllTableNames() {
    return PURGE_TABLES.map((e) => e.table);
}

/**
 * Tables in DELETE order (leaves→roots). Tables sharing a tier keep registry
 * order; no two tables with an FK edge between them may share a tier.
 *
 * @param {ReadonlyArray<string>} [tableNames] - Optional subset; defaults to all.
 * @returns {Readonly<PurgeTableEntry>[]}
 */
function getDeleteOrder(tableNames) {
    const names = tableNames ? new Set(tableNames) : null;
    return PURGE_TABLES.filter((e) => !names || names.has(e.table))
        .slice()
        .sort((a, b) => a.deleteOrderTier - b.deleteOrderTier);
}

/**
 * Tables in RESTORE order (roots→leaves).
 *
 * @param {ReadonlyArray<string>} [tableNames] - Optional subset; defaults to all.
 * @returns {Readonly<PurgeTableEntry>[]}
 */
function getRestoreOrder(tableNames) {
    const names = tableNames ? new Set(tableNames) : null;
    return PURGE_TABLES.filter((e) => !names || names.has(e.table))
        .slice()
        .sort((a, b) => a.restoreOrderTier - b.restoreOrderTier);
}

// Module-load self-check: a registry mistake fails at require() time, in production too.
(function assertRegistryIntegrity() {
    const seen = new Set();
    for (const entry of PURGE_TABLES) {
        if (seen.has(entry.table)) {
            throw new Error(`purgeTables registry integrity check failed: duplicate table entry "${entry.table}".`);
        }
        seen.add(entry.table);

        if (entry.pool !== PURGE_POOL) {
            throw new Error(
                `purgeTables registry integrity check failed: "${entry.table}" has pool "${entry.pool}", expected "${PURGE_POOL}".`,
            );
        }

        if (NEVER_PURGE.includes(entry.table)) {
            throw new Error(
                `purgeTables registry integrity check failed: "${entry.table}" is on NEVER_PURGE and must not appear in the registry.`,
            );
        }

        if (!Object.values(PURGE_GROUP_KEYS).includes(entry.group)) {
            throw new Error(
                `purgeTables registry integrity check failed: "${entry.table}" has unknown group "${entry.group}".`,
            );
        }
    }

    // Separate pass: a parent may be declared after its child.
    for (const entry of PURGE_TABLES) {
        for (const edge of entry.fkEdges) {
            if (!seen.has(edge.refTable)) {
                throw new Error(
                    `purgeTables registry integrity check failed: "${entry.table}".fkEdges references unregistered table "${edge.refTable}".`,
                );
            }
        }
    }
})();

module.exports = {
    PURGE_POOL,
    NEVER_PURGE,
    IMMUTABLE_TIMESTAMP_COLUMNS,
    PURGE_GROUP_KEYS,
    GROUP_CLOSURE_HINTS,
    PURGE_TABLES,
    getEntry,
    getTablesByGroup,
    getAllTableNames,
    getDeleteOrder,
    getRestoreOrder,
};
