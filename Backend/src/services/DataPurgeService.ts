"use strict";

/**
 * @fileoverview Data Purge & Restore — business logic (SUPER_ADMIN only).
 *
 * WHAT THIS FILE DOES
 * --------------------
 * Owns scope resolution (which tables a group/table selection actually
 * touches, including FK-dependency auto-inclusion), the read-only preview
 * used by the FE's "Scope Review" step, the scope catalogue for `GET
 * /scopes`, and the purge execution sequence itself (`executePurge`).
 * Never issues SQL directly — all DB access is delegated to
 * `DataPurgeModel`. Table names are NEVER taken from the request; every
 * method resolves them exclusively through `purgeTables.js`'s registry
 * (CWE-89).
 *
 * HOW IT WORKS
 * ------------
 * `resolveScope({ groups, tables })` is the single authority for "what does
 * this selection actually resolve to" — every other method (`getPreview`,
 * `executePurge`, and `BackupArchiveService.buildBackup`) calls it rather
 * than re-deriving a table list. It applies two closure rules in order:
 *   1. Group-level widening — selecting a WHOLE group (e.g.
 *      `T_`) also selects every table in that group's `GROUP_CLOSURE_HINTS`
 *      dependents, even FK-less ones.
 *   2. Pure FK-edge transitive closure over every registered table — catches any
 *      remaining table-level dependency, including for a lone sub-table
 *      selection that isn't a whole-group pick (sub-table
 *      selection follows the same closure over the edge list).
 *
 * `executePurge` implements steps 1-9 in order (preceded by a
 * Step 0: the pre-scheduled-backup lockout window,
 * `BackupScheduleService.getLockoutStatus` — refuses a
 * purge outright with 409 when a scheduled backup is imminent or running,
 * BEFORE any of the steps below run): re-verify the caller, verify the
 * admin password via `CryptoVault.verifyAdminPassword` (never
 * `verifyPassword` — see the file-level warning below), verify the backup
 * token (`BackupTokenService`), verify the confirm phrase, gate on the
 * `T_ADMINS_DEV` lockout acknowledgement (an UNRELATED "lockout" —
 * that one gates on the SCOPE containing the admin table, this new Step 0
 * gates on WHEN in time the request lands), re-count for drift, run one
 * atomic `DataPurgeModel.purgeTables` transaction, then — OUTSIDE that
 * transaction, so it survives even a `T_AUDIT_LOGS` purge — write the audit
 * row, fire the ops alert email, and flush every cache namespace.
 *
 * EXAMPLE
 * -------
 *   const scope = DataPurgeService.resolveScope({ groups: ["T_"], tables: [] });
 *   // scope.tables includes every T_ table plus any group its closure hints name
 *
 *   const preview = await DataPurgeService.getPreview({ groups: ["SERVER_"] });
 *   // preview.confirmPhrase === "DELETE SERVER_ 4213 ROWS" (example)
 */

const crypto = require("crypto");

const { AppError, PURGE_ERRORS } = require("../constants/errors");
const { HTTP_STATUS } = require("../constants");
const { logger } = require("../utils/logger");
const {
    dataPurgeMessages,
    backupEmailMessages,
    dataBackupMessages,
} = require("../constants/messages");
const {
    NEVER_PURGE,
    IMMUTABLE_TIMESTAMP_COLUMNS,
    PURGE_GROUP_KEYS,
    GROUP_CLOSURE_HINTS,
    PURGE_TABLES,
    getEntry,
    getTablesByGroup,
    getAllTableNames,
} = require("../constants/purgeTables");
const DataPurgeModel = require("../models/data-purge.model");
const AdminModel = require("../models/admin.model");
const AuditLogModel = require("../models/audit.log.model");
const { CryptoVault } = require("../utils/encryption/CryptoVault");
const BackupTokenService = require("./BackupTokenService");
const { registry } = require("../middleware/cache");

/**
 * Safety valve for step 6 (row counts must still match the
 * token's counts within a tolerance). No numeric tolerance is specified,
 * and this is a destructive-DELETE gate — the safe default is
 * an EXACT match: any live/token drift means data that was never backed up
 * would be destroyed (if live > token) or the backup is simply stale (if
 * live < token). Either way the correct operator action is the same
 * ("download a fresh backup"), which is cheap. Kept as a local constant
 * (not an env var) on purpose — revisit only if operators find an exact match impractical
 * against a genuinely still-live table.
 */
const RECOUNT_TOLERANCE = 0;

// ─── Internal pure helpers (no state, no side effects) ────────────────────

/**
 * Normalises a request-supplied value into a deduplicated array of
 * non-empty trimmed strings. Anything that isn't an array of strings
 * collapses to an empty array rather than throwing — callers validate
 * "at least one selected" separately, with a clearer error message.
 *
 * @param {*} value
 * @returns {string[]}
 * @private
 */
function _normalizeStringArray(value) {
    if (!Array.isArray(value)) return [];
    const cleaned = value
        .filter((v) => typeof v === "string" && v.trim() !== "")
        .map((v) => v.trim());
    return [...new Set(cleaned)];
}

/**
 * Pure FK-edge transitive closure: starting from `baseTables`, repeatedly
 * adds any registered table whose `fkEdges` points at a table ALREADY in
 * the set (a child must always be purged alongside/before the parent it
 * references — the reason `ORA-02292` is otherwise possible). Runs to a
 * fixpoint — O(tables² ) worst case, trivially fast for a registry this size.
 *
 * @param {Iterable<string>} baseTables
 * @returns {Set<string>}
 * @private
 */
function _computeChildClosure(baseTables) {
    const result = new Set(baseTables);
    let changed = true;
    while (changed) {
        changed = false;
        for (const entry of PURGE_TABLES) {
            if (result.has(entry.table)) continue;
            if (entry.fkEdges.some((edge) => result.has(edge.refTable))) {
                result.add(entry.table);
                changed = true;
            }
        }
    }
    return result;
}

/**
 * Stable, non-secret fingerprint of a resolved table set — sorted so call
 * order never matters. NOT itself a security boundary (the outer backup
 * token's HMAC signature is); this is purely an integrity/audit label used
 * to log and cross-reference "which exact scope was this".
 *
 * @param {string[]} sortedTables - Already sorted, already deduplicated.
 * @returns {string} 64-char hex SHA-256 digest.
 * @private
 */
function _computeScopeHash(sortedTables) {
    return crypto
        .createHash("sha256")
        .update(sortedTables.join(","))
        .digest("hex");
}

/**
 * Defense-in-depth guard: re-asserts, independently of everything upstream, that every table in
 * `tables` is (a) not on the `NEVER_PURGE` deny-list and (b) a registered
 * `PURGE_POOL` entry. `getEntry()` already throws internally for any
 * other pool, so this mostly exists to give a clean `AppError` for the
 * NEVER_PURGE case and to fail loudly (not silently skip) on an unknown
 * name that somehow reached this point.
 *
 * @param {string[]} tables
 * @throws {AppError} 403 when a NEVER_PURGE name is present.
 * @throws {Error} When a name is not a registered `PURGE_POOL` table (a registry/programming bug, not a user error — intentionally NOT an AppError).
 * @private
 */
function _assertSafeScope(tables) {
    const forbidden = tables.filter((t) => NEVER_PURGE.includes(t));
    if (forbidden.length > 0) {
        throw new AppError(
            PURGE_ERRORS.PROTECTED_TABLE,
            HTTP_STATUS.FORBIDDEN,
            {
                type: "AuthorizationError",
                details: forbidden.map((t) => ({
                    field: "tables",
                    issue: `"${t}" is protected and can never be purged.`,
                })),
            },
        );
    }
    for (const table of tables) {
        const entry = getEntry(table); // throws if a registered entry's pool !== PURGE_POOL
        if (!entry) {
            throw new Error(
                `DataPurgeService: "${table}" reached _assertSafeScope without a registry entry — this indicates a bug upstream, not a user error.`,
            );
        }
    }
}

class DataPurgeService {
    // ─── Scope resolution ───────────────────────────────────────────────────

    /**
     * Resolves a raw `{ groups, tables }` selection into the authoritative,
     * FK-closure-complete list of tables a purge or restore of this
     * selection would actually touch. NEVER trusts the caller's table
     * names blindly — every name is validated against the registry
     * allow-list and the `NEVER_PURGE` deny-list before it can appear in
     * the result (CWE-89).
     *
     * @param {object} selection
     * @param {string[]} [selection.groups] - Group keys (see `PURGE_GROUP_KEYS`), e.g. `["T_", "SERVER_"]`.
     * @param {string[]} [selection.tables] - Individual table names, e.g. `["T_AUDIT_LOGS_DEV"]`.
     * @returns {{
     *   requestedGroups: string[],
     *   requestedTables: string[],
     *   autoIncludedGroups: string[],
     *   tables: string[],
     *   scopeHash: string,
     * }}
     * @throws {AppError} 400 when neither `groups` nor `tables` yields anything, or an unknown group/table name is supplied.
     * @throws {AppError} 403 when a `NEVER_PURGE` name is supplied directly.
     *
     * @example
     * const scope = DataPurgeService.resolveScope({ groups: ["T_"] });
     * // scope.autoIncludedGroups → groups pulled in by closure hints
     */
    static resolveScope(selection = {}) {
        const requestedGroups = _normalizeStringArray(selection?.groups);
        const requestedTables = _normalizeStringArray(selection?.tables);

        if (requestedGroups.length === 0 && requestedTables.length === 0) {
            throw new AppError(
                PURGE_ERRORS.INVALID_SCOPE,
                HTTP_STATUS.BAD_REQUEST,
                {
                    type: "ValidationError",
                    details: [
                        {
                            field: "groups/tables",
                            issue: "Select at least one group or table.",
                        },
                    ],
                },
            );
        }

        const validGroups = Object.values(PURGE_GROUP_KEYS);
        const unknownGroups = requestedGroups.filter(
            (g) => !validGroups.includes(g),
        );
        const unknownTables = requestedTables.filter((t) => !getEntry(t));
        if (unknownGroups.length > 0 || unknownTables.length > 0) {
            throw new AppError(
                PURGE_ERRORS.UNKNOWN_TABLE,
                HTTP_STATUS.BAD_REQUEST,
                {
                    type: "ValidationError",
                    details: [
                        ...unknownGroups.map((g) => ({
                            field: "groups",
                            issue: `Unknown group "${g}".`,
                        })),
                        ...unknownTables.map((t) => ({
                            field: "tables",
                            issue: `Unknown or unregistered table "${t}".`,
                        })),
                    ],
                },
            );
        }

        // Defense-in-depth, independent of registry membership: a name could theoretically be both "not registered"
        // AND on NEVER_PURGE (it always will be, per purgeTables.js's own
        // module-load self-check) — checked explicitly anyway so this fails
        // with a clear AuthorizationError rather than a generic "unknown
        // table" ValidationError if the deny-list ever diverges from the
        // registry in the future.
        const forbidden = [...requestedGroups, ...requestedTables].filter((n) =>
            NEVER_PURGE.includes(n),
        );
        if (forbidden.length > 0) {
            throw new AppError(
                PURGE_ERRORS.PROTECTED_TABLE,
                HTTP_STATUS.FORBIDDEN,
                {
                    type: "AuthorizationError",
                    details: forbidden.map((n) => ({
                        field: "tables",
                        issue: `"${n}" is protected and can never be purged.`,
                    })),
                },
            );
        }

        // 1. Expand explicitly requested groups into their table sets, union
        //    with explicitly requested individual tables.
        const explicitTables = new Set(requestedTables);
        for (const group of requestedGroups) {
            for (const entry of getTablesByGroup(group))
                explicitTables.add(entry.table);
        }

        // 2. Group-level auto-include — ONLY applies when a
        //    WHOLE group was requested; widens by GROUP (every table in the
        //    dependent group, even FK-less ones), not just by FK edge.
        for (const group of requestedGroups) {
            for (const dependentGroup of GROUP_CLOSURE_HINTS[group] ?? []) {
                for (const entry of getTablesByGroup(dependentGroup))
                    explicitTables.add(entry.table);
            }
        }

        // 3. Pure FK-edge transitive closure over ALL registered tables — the
        //    authority for sub-table selections and for anything the
        //    group-level widening in step 2 didn't already cover.
        const resolved = _computeChildClosure(explicitTables);

        // A group counts as "auto-included" (the FE's "pulled in by
        // dependency" badge) only when NONE of its tables were explicitly
        // named — either as a whole-group pick or as an individual table.
        const explicitlyTouchedGroups = new Set([
            ...requestedGroups,
            ...requestedTables.map((t) => getEntry(t).group),
        ]);
        const autoIncludedGroups = new Set();
        for (const table of resolved) {
            const group = getEntry(table).group;
            if (!explicitlyTouchedGroups.has(group))
                autoIncludedGroups.add(group);
        }

        const tables = [...resolved].sort();
        _assertSafeScope(tables); // belt-and-braces — see function doc

        const scopeHash = _computeScopeHash(tables);

        logger.info(
            dataPurgeMessages.SCOPE_RESOLVED(requestedGroups, tables, [
                ...autoIncludedGroups,
            ]),
        );

        return {
            requestedGroups,
            requestedTables,
            autoIncludedGroups: [...autoIncludedGroups].sort(),
            tables,
            scopeHash,
        };
    }

    /**
     * Builds the exact confirm phrase an operator must retype to unlock the
     * purge: `DELETE <GROUP_LIST> <rowCount> ROWS`.
     * `rowCount` MUST be the same number embedded in the backup token
     * (`payload.rowCounts`), never a freshly re-counted live figure — the
     * live count can legitimately drift between backup and execute (that
     * drift is what step 6's separate re-count check exists to catch), and
     * using a live count here would make the phrase the FE displayed at
     * backup time silently stop matching what the server expects at
     * execute time through no fault of the operator.
     *
     * @param {string[]} groups - Group keys present in the resolved scope (any order — sorted internally).
     * @param {number} totalRows - Total row count across the resolved scope, from the SAME snapshot as `groups`.
     * @returns {string}
     *
     * @example
     * DataPurgeService.buildConfirmPhrase(["SERVER_"], 4213); // "DELETE SERVER_ 4213 ROWS"
     * DataPurgeService.buildConfirmPhrase(["SERVER_", "T_"], 128031); // "DELETE SERVER_, T_ 128031 ROWS"
     */
    static buildConfirmPhrase(groups, totalRows) {
        const groupList = [...new Set(groups)].sort().join(", ");
        return `DELETE ${groupList} ${totalRows} ROWS`;
    }

    /**
     * Builds the fidelity disclosure strings (immutable
     * timestamps, virtual columns) for a resolved table list. Shared
     * by `getPreview()` (FE "Scope Review" step) and
     * `BackupArchiveService` (`manifest.json`'s `fidelityNotes[]`) so the
     * two never drift — an operator sees the exact same disclosures at
     * preview time and in the archive they download.
     *
     * @param {string[]} tables - Resolved table names (e.g. `resolveScope(...).tables`).
     * @returns {string[]}
     *
     * @example
     * DataPurgeService.buildFidelityNotes(["T_EXAMPLE"]);
     * // → [
     * //     "T_EXAMPLE: virtual column(s) TOTAL are computed by Oracle — never part of any restore, and gone once this data is purged.",
     * //     "T_EXAMPLE: CREATED_DATE, CREATED_BY will be permanently lost — these columns cannot be recovered once this data is purged.",
     * //   ]
     */
    static buildFidelityNotes(tables) {
        const notes = [];
        for (const table of tables) {
            const entry = getEntry(table);
            if (!entry) continue;
            if (entry.virtualColumns.length > 0) {
                notes.push(
                    `${table}: virtual column(s) ${entry.virtualColumns.join(", ")} are computed by Oracle — never part of any restore, and gone once this data is purged.`,
                );
            }
            const immutableCols = IMMUTABLE_TIMESTAMP_COLUMNS[table];
            if (immutableCols) {
                notes.push(
                    `${table}: ${immutableCols.join(", ")} will be permanently lost — these columns cannot be recovered once this data is purged.`,
                );
            }
        }
        return notes;
    }

    // ─── Read-only endpoints ─────────────────────────────────────────────────

    /**
     * `GET /scopes` — the full group catalogue with LIVE row counts for
     * every registered table. Deliberately uncached: an
     * operator making a purge decision must always see the current state,
     * never a stale cache-aside snapshot.
     *
     * @returns {Promise<{
     *   groups: Array<{ group: string, tables: Array<{ table: string, rowCount: number }>, totalRows: number, autoIncludes: string[] }>,
     *   generatedAt: string,
     * }>}
     */
    static async getScopeCatalogue() {
        const allTables = getAllTableNames();
        const counts = await DataPurgeModel.countRows(allTables);

        const groups = Object.values(PURGE_GROUP_KEYS).map((group) => {
            const tables = getTablesByGroup(group).map((entry) => ({
                table: entry.table,
                rowCount: counts[entry.table] ?? 0,
            }));
            return {
                group,
                tables,
                totalRows: tables.reduce((sum, t) => sum + t.rowCount, 0),
                autoIncludes: [...(GROUP_CLOSURE_HINTS[group] ?? [])],
            };
        });

        return { groups, generatedAt: new Date().toISOString() };
    }

    /**
     * `POST /preview` — read-only. Resolves the selection, fetches live
     * per-table row counts, and surfaces the fidelity disclosures (immutable
     * timestamps, virtual columns) an operator must see
     * before confirming. Never writes anything.
     *
     * @param {object} selection - Same shape as `resolveScope`'s parameter.
     * @returns {Promise<{
     *   requestedGroups: string[],
     *   requestedTables: string[],
     *   autoIncludedGroups: string[],
     *   scopeHash: string,
     *   totalRows: number,
     *   tables: Array<{ table: string, group: string, rowCount: number, autoIncluded: boolean }>,
     *   fidelityNotes: string[],
     *   confirmPhrase: string,
     * }>}
     * @throws {AppError} Propagated from `resolveScope`.
     */
    static async getPreview(selection) {
        const scope = DataPurgeService.resolveScope(selection);
        _assertSafeScope(scope.tables);

        const explicitlyTouchedGroups = new Set([
            ...scope.requestedGroups,
            ...scope.requestedTables.map((t) => getEntry(t).group),
        ]);

        const counts = await DataPurgeModel.countRows(scope.tables);
        const totalRows = Object.values(counts).reduce((sum, n) => sum + n, 0);

        const tables = scope.tables.map((table) => {
            const entry = getEntry(table);
            return {
                table,
                group: entry.group,
                rowCount: counts[table] ?? 0,
                autoIncluded: !explicitlyTouchedGroups.has(entry.group),
            };
        });

        const fidelityNotes = DataPurgeService.buildFidelityNotes(scope.tables);

        const groupsInScope = [
            ...new Set(scope.tables.map((t) => getEntry(t).group)),
        ];
        const confirmPhrase = DataPurgeService.buildConfirmPhrase(
            groupsInScope,
            totalRows,
        );

        logger.info(
            dataPurgeMessages.PREVIEW_GENERATED(scope.tables.length, totalRows),
        );

        return {
            requestedGroups: scope.requestedGroups,
            requestedTables: scope.requestedTables,
            autoIncludedGroups: scope.autoIncludedGroups,
            scopeHash: scope.scopeHash,
            totalRows,
            tables,
            fidelityNotes,
            confirmPhrase,
        };
    }

    // ─── Credential verification ────────────────────────────────────────────

    /**
     * The T_ADMINS_DEV row of the acting admin, by its numeric id (the JWT
     * `id` claim the purge/restore controllers pass), or null.
     *
     * @param {number|string} adminId
     * @returns {Promise<object|null>}
     */
    static async findAdminById(adminId) {
        return AdminModel.findById(adminId);
    }

    /**
     * Verifies a SUPER_ADMIN's admin password, throwing on any failure.
     *
     * Extracted so `executePurge` and the standalone `POST /authorise`
     * pre-check share ONE verification path — a second hand-rolled copy is
     * exactly how a "step 3 accepted it but /execute rejected it" divergence
     * gets introduced.
     *
     * `CryptoVault.verifyAdminPassword`, NOT `verifyPassword`: `verifyPassword`
     * routes by the GLOBAL `PASSWORD_HASH_MODE`, so a non-argon2 global mode
     * would reject a correct admin password outright.
     *
     * @param {number|string} adminId    - Authenticated caller's numeric admin id.
     * @param {string}        adminPassword - Plaintext password to verify.
     * @param {object|null}   [adminRecord] - Pre-fetched row; re-fetched when omitted.
     * @returns {Promise<{ adminId: number|string }>}
     * @throws {AppError} 400 when the password is absent.
     * @throws {AppError} 401 when the admin no longer exists, or the password is wrong.
     * @private
     */
    static async _assertAdminPassword(
        adminId,
        adminPassword,
        adminRecord = null,
    ) {
        const record =
            adminRecord ?? (await DataPurgeService.findAdminById(adminId));
        if (!record) {
            throw new AppError(
                PURGE_ERRORS.ADMIN_NOT_FOUND,
                HTTP_STATUS.UNAUTHORIZED,
                {
                    type: "AuthenticationError",
                },
            );
        }

        if (!adminPassword) {
            throw new AppError(
                PURGE_ERRORS.ADMIN_PASSWORD_REQUIRED,
                HTTP_STATUS.BAD_REQUEST,
                {
                    type: "ValidationError",
                    details: [{ field: "adminPassword", issue: "Required." }],
                },
            );
        }

        const { matched } = await CryptoVault.verifyAdminPassword(
            adminPassword,
            record.PASSWORD,
        );
        if (!matched) {
            logger.warning(
                dataPurgeMessages.EXECUTE_PASSWORD_REJECTED(adminId),
            );
            throw new AppError(
                PURGE_ERRORS.INVALID_ADMIN_PASSWORD,
                HTTP_STATUS.UNAUTHORIZED,
                {
                    type: "AuthenticationError",
                },
            );
        }

        return { adminId };
    }

    /**
     * Standalone credential pre-check for the purge stepper's step 3
     * ("Authorise"), so a wrong password is caught THERE rather than at
     * `/execute` — i.e. before the operator has typed the confirm phrase and
     * committed to the action.
     *
     * This is purely a UX gate. It grants nothing and returns nothing: it
     * issues no token and mutates no state, so passing it is neither necessary
     * nor sufficient for `/execute`, which independently re-verifies the
     * password, the backup token and the confirm phrase on every call. It is
     * SUPER_ADMIN-authenticated and behind the strict rate limiter for the
     * same reason any credential-checking endpoint must be.
     *
     * @param {object} params
     * @param {number|string} params.adminId
     * @param {string}        params.adminPassword
     * @returns {Promise<{ verified: true }>}
     * @throws {AppError} 400/401 — see `_assertAdminPassword`.
     */
    static async authorise({ adminId, adminPassword }) {
        await DataPurgeService._assertAdminPassword(adminId, adminPassword);
        return { verified: true };
    }

    // ─── Backup ────────────

    /**
     * `POST /data-purge/backup` — builds the purge-gating backup archive
     * (delegates to `BackupArchiveService.buildBackup`, UNCHANGED — this
     * method adds nothing to how the archive itself is built) and then,
     * fire-and-forget: (1) persists a server-side PURGE copy via
     * `BackupStoreService.runBackup`, and (2) sends a NOTIFICATION-ONLY email
     * (no attachment, no archive content) to the opted-in SUPER_ADMIN
     * distribution list plus the acting operator
     * (`BackupEmailService.sendPurgeNotification` — the purge-gating backup is
     * the ONLY backup flow that emails; scheduled/manual backups write to disk
     * silently and never call this).
     *
     * The archive build + backup-token issuance is NEVER blocked or delayed
     * by the email send: `BackupEmailService.sendPurgeNotification()` itself never
     * throws (mirrors `ServerNotificationService`'s contract), and this
     * method additionally never `await`s it into the return value — a
     * `.catch()` at the call site is belt-and-braces so even an unexpected
     * synchronous throw cannot escape here. An SMTP failure must never turn
     * a successful backup into an error response that strands the purge
     * stepper (established convention: "Email send failed in
     * fire-and-forget `.catch()` → `warning`").
     *
     * `BackupArchiveService` and `BackupEmailService` are required lazily —
     * `BackupArchiveService` itself requires `DataPurgeService` at module
     * load (an eager top-level require here would be circular), and
     * `BackupEmailService` is optional at module load for the same
     * "no hard dependency for callers who never hit this path" reasoning
     * already used by {@link DataPurgeService._sendPostCommitAlert}'s lazy
     * `AlertNotifierService` require.
     *
     * @param {object} params
     * @param {object} params.selection - `{ groups, tables }` — same shape as `resolveScope`.
     * @param {number|string} params.adminId - Acting admin's numeric id — the token issuer, and always an email recipient.
     * @param {string|null} [params.requestId]
     * @returns {Promise<{
     *   zipBuffer: Buffer,
     *   filename: string,
     *   token: string,
     *   expiresAt: number,
     *   confirmPhrase: string,
     *   totalRows: number,
     *   tableCount: number,
     *   rowCounts: Record<string, number>,
     * }>}
     * @throws {AppError} Propagated from `resolveScope` (via `BackupArchiveService.buildBackup`).
     *
     * @example
     * const result = await DataPurgeService.backup({
     *     selection: { groups: ["SERVER_"] },
     *     adminId: 10234,
     *     requestId: req.id,
     * });
     */
    static async backup({ selection, adminId, requestId = null }) {
        const BackupArchiveService = require("./BackupArchiveService");
        const BackupEmailService = require("./BackupEmailService");

        const result = await BackupArchiveService.buildBackup({
            selection,
            adminId,
            requestId,
        });

        // Resolved from the SAME resolveScope() the archive was built from.
        const scope = DataPurgeService.resolveScope(selection);
        const scopeLabel =
            scope.requestedGroups.length > 0
                ? scope.requestedGroups.join(", ")
                : `custom (${scope.tables.length} table${scope.tables.length === 1 ? "" : "s"})`;

        // ── Fire-and-forget: persist purge backup to db-backup/ ──────────
        // A server-side copy of the pre-purge state, visible in the Backup
        // tab's "Purge Backups" section.
        try {
            const BackupStoreService = require("./BackupStoreService");
            BackupStoreService.runBackup({
                trigger: "PURGE",
                tables: getAllTableNames(),
                createdBy: adminId,
                requestId,
            }).catch((err) => {
                logger.warning(
                    dataBackupMessages.ARCHIVE_WRITE_FAILED("purge", err),
                );
            });
        } catch (err) {
            logger.warning(
                dataBackupMessages.ARCHIVE_WRITE_FAILED("purge", err),
            );
        }

        // ── Fire-and-forget: notification email (no attachment) ──────────
        // Tells opted-in SUPER_ADMINs a purge happened and where to find
        // the archive (Backup tab). Never blocks the backup response.
        try {
            BackupEmailService.sendPurgeNotification({
                scopeLabel,
                totalRows: result.totalRows,
                tableCount: result.tableCount,
                adminId,
                requestId,
            }).catch((err) => {
                logger.warning(
                    backupEmailMessages.DISPATCH_REJECTED(adminId, err),
                );
            });
        } catch (err) {
            logger.warning(
                backupEmailMessages.DISPATCH_REJECTED(adminId, err),
            );
        }

        return result;
    }

    // ─── Purge execution ────────────────────────────────────────

    /**
     * Executes a purge end-to-end: check the pre-scheduled-backup lockout
     * window (Step 0, ergonomics only, never the
     * correctness guarantee), authorise, verify password, verify backup
     * token, verify confirm phrase, gate on the admin-lockout
     * acknowledgement, re-count for drift, run one atomic transaction, then
     * — outside that transaction — write the audit trail and flush caches.
     *
     * @param {object} params
     * @param {object} params.selection        - `{ groups, tables }` — re-resolved here, never trusted from a prior response.
     * @param {string} params.backupToken       - Token issued by `POST /backup` (`BackupTokenService`).
     * @param {number|string} params.adminId - `req.user.userId` of the authenticated SUPER_ADMIN caller.
     * @param {string} params.adminPassword     - Plaintext password, verified via `CryptoVault.verifyAdminPassword`.
     * @param {string} params.confirmPhrase     - Operator-typed phrase, compared against `buildConfirmPhrase`.
     * @param {boolean} [params.acknowledgeLockout] - Required `true` when the scope includes `T_ADMINS_DEV`.
     * @param {string|null} [params.clientIp]
     * @param {string|null} [params.requestId]
     * @returns {Promise<{
     *   scopeHash: string,
     *   tables: string[],
     *   totalDeleted: number,
     *   perTable: Array<{ table: string, deletedCount: number }>,
     *   durationMs: number,
     * }>}
     * @throws {AppError} 400/401/403/409/422 — see the individual step comments below.
     *
     * @example
     * const report = await DataPurgeService.executePurge({
     *     selection: { groups: ["SERVER_"] },
     *     backupToken: req.body.backupToken,
     *     adminId: req.user.userId,
     *     adminPassword: req.body.adminPassword,
     *     confirmPhrase: req.body.confirmPhrase,
     *     clientIp: req.ip,
     *     requestId: req.id,
     * });
     */
    static async executePurge(params) {
        const {
            selection,
            backupToken,
            adminId,
            adminPassword,
            confirmPhrase,
            acknowledgeLockout,
            clientIp = null,
            requestId = null,
        } = params ?? {};

        const startedAt = Date.now();

        // ── Step 0 — pre-scheduled-backup lockout window
        // (about a minute before). Refuses to even START a purge when a
        // scheduled backup is imminent or currently running — checked
        // BEFORE any admin lookup, password verification, or backup-token
        // consumption below, so a rejected purge never burns the
        // one-time-use token or does needless credential work for a
        // request that is going to be refused regardless of who is asking.
        //
        // This is an OPERATOR ERGONOMICS guard, NOT the correctness
        // guarantee — a purge's single atomic DELETE transaction (Step 8
        // below) can run for minutes across every table in scope, so a purge
        // that STARTS 61 seconds after this check passes can still be in
        // flight when a scheduled backup fires. Overlap safety in that
        // case is entirely `BackupStoreService`'s existing FIFO chain-race
        // mutex (`_withRunBackupLock`), which `DataPurgeService.backup()`'s
        // own PURGE-triggered `BackupStoreService.runBackup({ trigger:
        // "PURGE" })` call still queues behind exactly as before — that
        // call is NEVER rejected by this window (see
        // `BackupStoreService.runBackup`'s MANUAL-only gate), only this
        // purge-EXECUTE entry point is. See
        // `BackupScheduleService.getLockoutStatus`'s doc comment for the
        // full rationale.
        //
        // Lazy require — mirrors every other cross-service require in this
        // method (BackupArchiveService, BackupEmailService, AlertNotifierService
        // below) to avoid a hard dependency at module load for callers who
        // never reach this path.
        const BackupScheduleService = require("./BackupScheduleService");
        const lockoutStatus = await BackupScheduleService.getLockoutStatus();
        if (lockoutStatus.active) {
            logger.warning(
                dataBackupMessages.PURGE_BLOCKED_SCHEDULE_WINDOW(
                    adminId,
                    lockoutStatus.reason,
                    lockoutStatus.msRemaining,
                ),
            );
            throw new AppError(
                PURGE_ERRORS.PURGE_SCHEDULE_WINDOW,
                HTTP_STATUS.CONFLICT,
                {
                    type: "ConflictError",
                    hint: BackupScheduleService.describeLockout(lockoutStatus),
                },
            );
        }

        // ── Step 1 — re-verify the caller still exists in T_ADMINS_DEV.
        // Role SUPER_ADMIN is already enforced by the route guard; this
        // catches "admin was deleted/revoked between login and this click".
        const adminRecord = await DataPurgeService.findAdminById(adminId);
        if (!adminRecord) {
            throw new AppError(
                PURGE_ERRORS.ADMIN_NOT_FOUND,
                HTTP_STATUS.UNAUTHORIZED,
                {
                    type: "AuthenticationError",
                },
            );
        }

        // ── Step 2 — verify the admin password.
        // Delegates to _assertAdminPassword so this check and the standalone
        // POST /authorise pre-check (which the FE stepper uses to gate step 3
        // → step 4) can never drift onto two different verification paths.
        await DataPurgeService._assertAdminPassword(
            adminId,
            adminPassword,
            adminRecord,
        );

        // ── Step 3 — verify AND CONSUME the backup token (server-side
        // backup-before-delete enforcement, CWE-602) and re-resolve the
        // scope fresh — `selection` is NEVER trusted to already equal what a
        // prior /preview or /backup call computed.
        //
        // `consume()` (not `verify()`) is deliberate: this token is burned
        // the instant it is confirmed valid, BEFORE the wrong-admin,
        // scope-mismatch, confirm-phrase, and row-count-drift checks below
        // even run. If any of those later checks — or the purge itself —
        // rejects the request, the token is still spent; the operator must
        // download a fresh backup and obtain a new token before trying
        // again. This is a deliberate conservative choice:
        // replay protection beats retry convenience for an irreversible
        // DELETE. See `BackupTokenService.consume`'s doc comment for the
        // full rationale and the atomicity guarantee that makes two
        // concurrent /execute calls with the SAME token unable to both win.
        const scope = DataPurgeService.resolveScope(selection);
        _assertSafeScope(scope.tables);

        if (!backupToken) {
            throw new AppError(
                PURGE_ERRORS.BACKUP_TOKEN_REQUIRED,
                HTTP_STATUS.UNAUTHORIZED,
                {
                    type: "AuthenticationError",
                },
            );
        }
        const tokenResult = await BackupTokenService.consume(backupToken);
        if (!tokenResult.valid) {
            logger.warning(
                dataPurgeMessages.EXECUTE_TOKEN_REJECTED(
                    adminId,
                    tokenResult.reason,
                ),
            );
            const errMap = {
                expired: PURGE_ERRORS.BACKUP_TOKEN_EXPIRED,
                tampered: PURGE_ERRORS.BACKUP_TOKEN_INVALID,
                malformed: PURGE_ERRORS.BACKUP_TOKEN_INVALID,
                replayed: PURGE_ERRORS.BACKUP_TOKEN_REPLAYED,
            };
            throw new AppError(
                errMap[tokenResult.reason] ?? PURGE_ERRORS.BACKUP_TOKEN_INVALID,
                HTTP_STATUS.UNAUTHORIZED,
                {
                    type: "AuthenticationError",
                },
            );
        }
        const tokenPayload = tokenResult.payload;

        if (String(tokenPayload.adminId) !== String(adminId)) {
            logger.warning(
                dataPurgeMessages.EXECUTE_TOKEN_REJECTED(
                    adminId,
                    "wrong admin",
                ),
            );
            throw new AppError(
                PURGE_ERRORS.BACKUP_TOKEN_WRONG_ADMIN,
                HTTP_STATUS.UNAUTHORIZED,
                {
                    type: "AuthenticationError",
                },
            );
        }

        // Token cannot be replayed against a WIDER scope than it actually
        // covered — the current resolved scope must be a SUBSET of the
        // table set the token's rowCounts snapshot names. An equal-or-
        // narrower execute scope is fine (over-covered by the backup).
        const backedUpTables = new Set(
            Object.keys(tokenPayload.rowCounts ?? {}),
        );
        const uncoveredTables = scope.tables.filter(
            (t) => !backedUpTables.has(t),
        );
        if (uncoveredTables.length > 0) {
            logger.warning(
                dataPurgeMessages.EXECUTE_TOKEN_REJECTED(
                    adminId,
                    `scope wider than backup (${uncoveredTables.join(", ")})`,
                ),
            );
            throw new AppError(
                PURGE_ERRORS.BACKUP_TOKEN_SCOPE_MISMATCH,
                HTTP_STATUS.UNAUTHORIZED,
                {
                    type: "AuthenticationError",
                    details: uncoveredTables.map((t) => ({
                        field: "scope",
                        issue: `"${t}" was not covered by the backup token.`,
                    })),
                },
            );
        }

        logger.info(
            dataPurgeMessages.EXECUTE_STARTED(adminId, scope.scopeHash),
        );

        // ── Step 4 — verify the confirm phrase, derived from the TOKEN's
        // frozen row counts (never a live re-count — see buildConfirmPhrase's
        // doc for why).
        if (!confirmPhrase) {
            throw new AppError(
                PURGE_ERRORS.CONFIRM_PHRASE_REQUIRED,
                HTTP_STATUS.BAD_REQUEST,
                {
                    type: "ValidationError",
                    details: [{ field: "confirmPhrase", issue: "Required." }],
                },
            );
        }
        const groupsInScope = [
            ...new Set(scope.tables.map((t) => getEntry(t).group)),
        ];
        const tokenTotalRows = Object.values(
            tokenPayload.rowCounts ?? {},
        ).reduce((sum, n) => sum + n, 0);
        const expectedPhrase = DataPurgeService.buildConfirmPhrase(
            groupsInScope,
            tokenTotalRows,
        );
        if (String(confirmPhrase).trim() !== expectedPhrase) {
            logger.warning(
                dataPurgeMessages.EXECUTE_CONFIRM_MISMATCH(adminId),
            );
            throw new AppError(
                PURGE_ERRORS.CONFIRM_PHRASE_MISMATCH,
                HTTP_STATUS.UNPROCESSABLE,
                {
                    type: "ValidationError",
                    hint: "Type the confirmation phrase exactly as shown, including capitalisation and punctuation.",
                },
            );
        }

        // ── Step 5 — lockout guard: purging T_ADMINS_DEV removes every admin
        // account; the only recovery is re-seeding a super admin, so the
        // operator must explicitly acknowledge that before this proceeds.
        if (scope.tables.includes("T_ADMINS_DEV")) {
            if (acknowledgeLockout !== true) {
                throw new AppError(
                    PURGE_ERRORS.LOCKOUT_ACK_REQUIRED,
                    HTTP_STATUS.BAD_REQUEST,
                    {
                        type: "ValidationError",
                        details: [
                            {
                                field: "acknowledgeLockout",
                                issue: "Must be true when the scope includes T_ADMINS_DEV.",
                            },
                        ],
                    },
                );
            }
            logger.alert(dataPurgeMessages.EXECUTE_LOCKOUT_ACK(adminId));
        }

        // ── Step 6 — re-count for drift. The backup is stale (someone
        // wrote/deleted rows since it was taken) if ANY table's live count
        // no longer matches the token's snapshot.
        //
        // Append-only log tables (T_AUDIT_LOGS, SERVER_ALERT_LOG) grow on
        // every request/alert — including the backup request itself — so a
        // whole-table count can never match. For those, the signed token
        // carries the highest backed-up PK; both this re-count and the DELETE
        // below are bounded to `pk <= highWater`, so post-backup rows are
        // neither drift nor deleted. Only in-scope append-only entries pass.
        const highWater = DataPurgeService._scopedHighWater(scope.tables, tokenPayload.highWater);
        const liveCounts = await DataPurgeModel.countRows(scope.tables, highWater);
        const mismatches = scope.tables
            .map((table) => ({
                table,
                tokenCount: tokenPayload.rowCounts?.[table] ?? 0,
                liveCount: liveCounts[table] ?? 0,
            }))
            .filter(
                (m) => Math.abs(m.liveCount - m.tokenCount) > RECOUNT_TOLERANCE,
            );

        if (mismatches.length > 0) {
            for (const m of mismatches) {
                logger.warning(
                    dataPurgeMessages.EXECUTE_COUNT_MISMATCH(
                        m.table,
                        m.tokenCount,
                        m.liveCount,
                    ),
                );
            }
            throw new AppError(
                PURGE_ERRORS.ROW_COUNT_CHANGED,
                HTTP_STATUS.CONFLICT,
                {
                    type: "ConflictError",
                    details: mismatches.map((m) => ({
                        field: m.table,
                        issue: `Backup had ${m.tokenCount} row(s); live is now ${m.liveCount}.`,
                    })),
                    hint: "Download a fresh backup and try again.",
                },
            );
        }

        // ── Step 7 + 8 — single atomic Transaction, delete in leaves-to-roots order,
        // commit. A mid-purge failure leaves every table untouched (the
        // whole transaction rolls back — see DataPurgeModel.purgeTables).
        const { totalDeleted, perTable } = await DataPurgeModel.purgeTables(
            scope.tables,
            (table, rowCount) => {
                logger.notice(
                    dataPurgeMessages.EXECUTE_TABLE_STEP(table, rowCount),
                );
            },
            highWater,
        );

        const durationMs = Date.now() - startedAt;
        logger.alert(
            dataPurgeMessages.EXECUTE_COMMIT(
                adminId,
                scope.scopeHash,
                totalDeleted,
                durationMs,
            ),
        );

        // ── Step 9 — post-commit, OUTSIDE the transaction so it survives a
        // T_AUDIT_LOGS purge (the table exists again — empty — right after
        // its own DELETE commits; a fresh INSERT here works regardless of
        // whether T_AUDIT_LOGS was in scope). Best-effort: neither failure
        // here undoes the already-committed purge.
        DataPurgeService._writePostCommitAudit({
            adminId,
            scope,
            perTable,
            totalDeleted,
            durationMs,
            clientIp,
            requestId,
        }).catch((err) => {
            logger.error(dataPurgeMessages.POST_COMMIT_AUDIT_FAILED(err));
        });

        DataPurgeService._sendPostCommitAlert({
            adminId,
            scope,
            totalDeleted,
        }).catch((err) => {
            logger.warning(dataPurgeMessages.POST_COMMIT_EMAIL_FAILED(err));
        });

        registry.flushAll();
        logger.info(dataPurgeMessages.CACHE_FLUSHED());

        return {
            scopeHash: scope.scopeHash,
            tables: scope.tables,
            totalDeleted,
            perTable,
            durationMs,
        };
    }

    /**
     * Filters a token's high-water map down to in-scope `appendOnlyLog`
     * tables with a well-formed exact-digit PK. Anything else is dropped, so
     * a real-data table always falls back to the exact whole-table check.
     *
     * @param {string[]} tables
     * @param {Record<string, string>|undefined} tokenHighWater
     * @returns {Record<string, string>}
     * @private
     */
    static _scopedHighWater(tables, tokenHighWater) {
        const out = {};
        if (!tokenHighWater || typeof tokenHighWater !== "object") return out;
        for (const table of tables) {
            const hw = tokenHighWater[table];
            if (getEntry(table)?.appendOnlyLog && typeof hw === "string" && /^\d{1,38}$/.test(hw)) {
                out[table] = hw;
            }
        }
        return out;
    }

    // ─── Private post-commit helpers ────────────────────────────────────────

    /**
     * Writes the post-commit T_AUDIT_LOGS row. Runs
     * fire-and-forget from `executePurge` — never allowed to undo or delay
     * the already-committed purge response.
     *
     * @param {object} opts
     * @returns {Promise<void>}
     * @private
     */
    static async _writePostCommitAudit({
        adminId,
        scope,
        perTable,
        totalDeleted,
        durationMs,
        clientIp,
        requestId,
    }) {
        await AuditLogModel.insert({
            REQUEST_ID: requestId ?? `purge-${Date.now()}`,
            USER_ID: Number.isFinite(Number(adminId))
                ? Number(adminId)
                : null,
            USERNAME: String(adminId ?? ""),
            METHOD: "DELETE",
            ENDPOINT: "/api/v1/data-purge/execute",
            PARAMS: JSON.stringify({
                scopeHash: scope.scopeHash,
                tables: scope.tables,
                totalDeleted,
                perTable,
            }).slice(0, 2000),
            STATUS_CODE: HTTP_STATUS.OK,
            STATUS_CATEGORY: "2xx",
            RESPONSE_TIME_MS: durationMs,
            CLIENT_IP: clientIp ?? null,
            SERVER_IP: null,
        });
    }

    /**
     * Fires the ops alert email for a completed purge — "a full purge is
     * exactly the class of event that channel exists for" (step 9). Uses `AlertNotifierService.notifyCriticalNow`, the same
     * best-effort immediate-send path `server.js` uses for process-crash
     * notifications — bypasses the normal digest-window buffering since
     * this is a rare, high-value, already-happened event.
     *
     * @param {object} opts
     * @returns {Promise<void>}
     * @private
     */
    static async _sendPostCommitAlert({ adminId, scope, totalDeleted }) {
        // Required lazily to avoid a hard dependency at module load for a
        // service most of this feature's paths never touch, and to sidestep
        // any startup-order coupling with AlertNotifierService.start().
        const AlertNotifierService = require("./AlertNotifierService");
        await AlertNotifierService.notifyCriticalNow({
            level: "EMERGENCY",
            message: `Data purge executed by admin ${adminId} - ${totalDeleted} row(s) deleted across ${scope.tables.length} table(s).`,
            meta: {
                adminId,
                scopeHash: scope.scopeHash,
                tables: scope.tables,
                totalDeleted,
            },
        });
    }
}

module.exports = DataPurgeService;
