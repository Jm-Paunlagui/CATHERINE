"use strict";

/**
 * @fileoverview Admin Management (Access Control) business logic.
 *
 * Owns all operations on T_ADMINS_DEV via the standalone AdminModel. Names and
 * the address directory come from T_USERS_DEV (UserModel) for the same
 * USERNAME when the account also exists there.
 *
 * Security:
 *  - SYSSIGNATURE is verified before every write and delete operation.
 *  - Add and Reset Password issue a server-generated TEMPORARY password
 *    (set-a-new-password only) and email it — the operator never sees or
 *    chooses it. The recipient is decided BEFORE any write, so a refused
 *    recipient never leaves behind an account nobody can claim.
 *  - ROLE POLICY (_assertCanManage): a SUPER_ADMIN manages every role; an
 *    ADMIN may only ADD a USER account and send Reset Password to a USER —
 *    never change a role, never act on an ADMIN / SUPER_ADMIN row, never
 *    Reset Signature. The route layer gates on "ADMIN or SUPER_ADMIN"; the
 *    per-action, per-target decision is made HERE.
 *  - Edit never sets a password: passwords are only issued by Add / Reset
 *    Password, emailed, and changed by the account holder.
 *  - Revoke and Delete require a revoke-backup token bound to the target AND
 *    the caller (backup-before-destroy, CWE-602).
 *  - Every action that removes access or changes the role ends the account's
 *    sessions first (fail closed).
 *
 * Wire contract: response objects use `username` (= USERNAME) and `role`
 * (= ROLE); validation details name the field `username`. Search results use
 * `username` / `firstName` / `lastName`.
 */

const {
    AppError,
    ADMIN_ERRORS,
    VALIDATION_ERRORS,
} = require("../constants/errors");
const { HTTP_STATUS } = require("../constants");
const { logger } = require("../utils/logger");
const { adminMessages } = require("../constants/messages");
const { CryptoVault } = require("../utils/encryption/CryptoVault");
const RefreshTokenService = require("./RefreshTokenService");
const { REFRESH_REVOKE_REASONS, SESSION_END_CAUSES } = require("../constants/authTokens");
const AdminModel = require("../models/admin.model");
const UserModel = require("../models/user.model");
const { registry, CacheKeyBuilder } = require("../middleware/cache");
const BackupArchiveService = require("./BackupArchiveService");
const BackupTokenService = require("./BackupTokenService");
const AdminAccessEmailService = require("./AdminAccessEmailService");
const { maskAddress, credentialAddressOf } = require("../utils/emailAddress");
const {
    TEMP_PASSWORD_TTL_MS,
    generateTemporaryPassword,
    wrapTemporaryHash,
    temporaryExpiryIso,
} = require("../utils/encryption/adminTempPassword");

/** Canonical ROLE values (schema CK_T_ADMINS_DEV_ROLE). */
const VALID_ROLES = ["SUPER_ADMIN", "ADMIN", "USER"];

/** USERNAME is VARCHAR2(100): one token, no whitespace or control characters. */
const USERNAME_PATTERN = /^[^\s\p{Cc}]{1,100}$/u;

/** Search results returned per query. */
const SEARCH_LIMIT = 20;

/**
 * Permission flag (API name) → server-notification channel. The channel maps
 * to its CAN_RECEIVE_SRV_* column through AdminModel.SERVER_NOTIFY_FLAG_COLUMNS.
 * A project adds its own capability flags here and to the admin model.
 */
const NOTIFY_FLAG_CHANNELS = Object.freeze({
    canReceiveSrvCrit: "server-critical-notification",
    canReceiveSrvDeps: "server-dependencies-notification",
    canReceiveSrvRed: "server-red-metrics-notification",
    canReceiveSrvSys: "server-system-notification",
});

/** Every flag key the permissions endpoint accepts. */
const ALLOWED_FLAG_KEYS = Object.freeze([...Object.keys(NOTIFY_FLAG_CHANNELS), "isActive"]);

/** The audited entity a revoke-backup is scoped to (fed into the token's scope hash). */
const _revokeEntity = (username) => ({
    table: "T_ADMINS_DEV",
    keyColumn: "USERNAME",
    keyValue: String(username),
});

class AdminManagementService {
    static VALID_ROLES = VALID_ROLES;
    static ALLOWED_FLAG_KEYS = ALLOWED_FLAG_KEYS;

    // ─── Account search ──────────────────────────────────────────────────────

    /**
     * Searches T_USERS_DEV for accounts to grant access to (USERNAME, FIRST_NAME
     * or LAST_NAME contains the query, case-insensitive). Each result carries
     * `isAdmin` and the masked address the temporary password would go to.
     * Results are shaped `{ username, firstName, lastName, isAdmin, emailOnFile,
     * emailHint }`.
     *
     * @param {string} query
     * @returns {Promise<Array<object>>} at most {@link SEARCH_LIMIT} rows
     * @throws {AppError} 400 when query is empty
     */
    static async searchAccounts(query) {
        if (!query || typeof query !== "string" || !query.trim()) {
            throw new AppError(
                VALIDATION_ERRORS.INVALID_INPUT,
                HTTP_STATUS.BAD_REQUEST,
                {
                    type: "ValidationError",
                    details: [
                        {
                            field: "q",
                            issue: "Search query must be a non-empty string.",
                        },
                    ],
                },
            );
        }

        const needle = query.trim().slice(0, 100).toLowerCase();
        logger.info(adminMessages.ADMIN_SEARCH(needle));

        // Admin rows come from a bounded, indexed-predicate search instead of a
        // full T_ADMINS_DEV load. A user matched only by FIRST/LAST_NAME has an
        // admin USERNAME that need not contain the needle, so those few (at
        // most SEARCH_LIMIT) are resolved in ONE batched `$in` query.
        const [users, adminHits] = await Promise.all([
            UserModel.findAll(),
            AdminModel.search(needle, AdminModel.SEARCH_MAX_LIMIT),
        ]);
        const matched = users
            .filter((u) =>
                [u.USERNAME, u.FIRST_NAME, u.LAST_NAME].some((v) =>
                    String(v ?? "").toLowerCase().includes(needle),
                ),
            )
            .slice(0, SEARCH_LIMIT);

        const adminsByName = new Map(adminHits.map((a) => [a.USERNAME, a]));
        const unresolved = matched
            .filter((u) => !adminsByName.has(u.USERNAME))
            .map((u) => u.USERNAME);
        for (const admin of await AdminModel.findByUsernames(unresolved)) {
            adminsByName.set(admin.USERNAME, admin);
        }

        return matched
            .map((u) => {
                const address =
                    credentialAddressOf(adminsByName.get(u.USERNAME)) ?? credentialAddressOf(u);
                return {
                    username: u.USERNAME,
                    firstName: u.FIRST_NAME ?? null,
                    lastName: u.LAST_NAME ?? null,
                    isAdmin: adminsByName.has(u.USERNAME),
                    ...AdminManagementService._emailFields(address),
                };
            });
    }

    /**
     * `{ emailOnFile, emailHint }` for one account — the same answer
     * AdminAccessEmailService.resolveRecipient will give. The hint is masked:
     * the admin list is not an address book.
     *
     * @param {string|null} address
     * @returns {{ emailOnFile: boolean, emailHint: string|null }}
     * @private
     */
    static _emailFields(address) {
        return {
            emailOnFile: address != null,
            emailHint: maskAddress(address),
        };
    }

    // ─── Role policy ─────────────────────────────────────────────────────────

    /**
     * Who may do what in Access Control. The route layer only knows "ADMIN or
     * SUPER_ADMIN"; without this check a plain ADMIN could promote ITSELF or
     * reset a SUPER_ADMIN's password (CWE-269 / CWE-285).
     *
     * | action          | SUPER_ADMIN | ADMIN                                  |
     * |-----------------|-------------|----------------------------------------|
     * | create          | any role    | USER only                              |
     * | changeRole      | any row     | never (its own row included)           |
     * | resetPassword   | any row     | a USER row that is not its own         |
     * | resetSignature  | any row     | never                                  |
     *
     * `caller.role` is the signed JWT role, re-derived from the database at
     * every refresh. A missing or unknown caller is refused (fail closed).
     *
     * @param {{ username: string, role: string }|null|undefined} caller
     * @param {'create'|'changeRole'|'resetPassword'|'resetSignature'} action
     * @param {{ target?: string|null, targetRole?: string|null, newRole?: string|null }} [ctx]
     * @throws {AppError} 403 AuthorizationError
     * @private
     */
    static _assertCanManage(caller, action, { target = null, targetRole = null, newRole = null } = {}) {
        const callerRole = caller?.role ?? null;
        if (callerRole === "SUPER_ADMIN") return;

        let allowed = false;
        let message = ADMIN_ERRORS.ROLE_ACTION_FORBIDDEN;
        if (callerRole === "ADMIN") {
            if (action === "create") {
                allowed = newRole === "USER";
                message = ADMIN_ERRORS.ADMIN_CREATE_USER_ONLY;
            } else if (action === "resetPassword") {
                allowed = targetRole === "USER" && String(target) !== String(caller.username);
                message = ADMIN_ERRORS.ADMIN_RESET_USER_ONLY;
            } else if (action === "changeRole") {
                message = ADMIN_ERRORS.ROLE_CHANGE_SUPER_ADMIN_ONLY;
            } else if (action === "resetSignature") {
                message = ADMIN_ERRORS.RESET_SIGNATURE_SUPER_ADMIN_ONLY;
            }
        }
        if (allowed) return;

        logger.warning(adminMessages.ROLE_POLICY_DENIED(caller?.username ?? "unknown", callerRole, action, target));
        logger.security("ADMIN_ROLE_POLICY_DENIED", { action, callerRole, targetRole, newRole });
        throw new AppError(message, HTTP_STATUS.FORBIDDEN, {
            type: "AuthorizationError",
            hint: "Ask a Super Admin to make this change.",
        });
    }

    // ─── Admin list ──────────────────────────────────────────────────────────

    /**
     * Returns every admin with a `signatureValid` verdict, the masked address a
     * Reset would use, any outstanding temporary-password expiry, and the
     * permission flags the Access Control toggles render.
     *
     * @returns {Promise<Array<object>>}
     */
    static async listAdmins() {
        const [admins, users] = await Promise.all([AdminModel.findAll(), UserModel.findAll()]);
        const usersByName = new Map(users.map((u) => [u.USERNAME, u]));

        const enriched = await Promise.all(
            admins.map(async (admin) => {
                const sigValid = await CryptoVault.verifyRecord(
                    AdminModel.SIGN_CONTEXT,
                    AdminModel.buildSignedFields(admin),
                    admin.SYSSIGNATURE,
                );
                if (!sigValid) {
                    logger.warning(adminMessages.ADMIN_SIGNATURE_INVALID(admin.USERNAME));
                }
                const profile = usersByName.get(admin.USERNAME) ?? null;
                const address = credentialAddressOf(admin) ?? credentialAddressOf(profile);

                return {
                    username: admin.USERNAME,
                    role: admin.ROLE,
                    firstName: profile?.FIRST_NAME ?? null,
                    lastName: profile?.LAST_NAME ?? null,
                    signatureValid: sigValid,
                    ...AdminManagementService._emailFields(address),
                    // Display-only — the UI compares it to its own clock, because
                    // this response is cached.
                    tempPasswordExpiresAt: temporaryExpiryIso(admin.PASSWORD),
                    ...AdminManagementService._flagsOf(admin),
                    createdAt: admin.CREATED_AT ?? null,
                    updatedAt: admin.UPDATED_AT ?? null,
                };
            }),
        );

        logger.info(adminMessages.ADMIN_LIST_FETCHED());
        return enriched;
    }

    /**
     * API-shaped permission flags of one T_ADMINS_DEV row.
     *
     * @param {object} admin
     * @returns {Record<string, 'Y'|'N'>}
     * @private
     */
    static _flagsOf(admin) {
        const flags = {};
        for (const [key, channel] of Object.entries(NOTIFY_FLAG_CHANNELS)) {
            const column = AdminModel.SERVER_NOTIFY_FLAG_COLUMNS[channel];
            flags[key] = String(admin[column] ?? "N");
        }
        flags.isActive = String(admin.IS_ACTIVE ?? "Y");
        return flags;
    }

    /**
     * Validates a flags object: only the accepted keys, only 'Y' | 'N'.
     *
     * @param {object} flags
     * @throws {AppError} 400 on unknown keys or invalid values
     * @private
     */
    static _validateFlags(flags) {
        if (flags == null || typeof flags !== "object" || Array.isArray(flags)) {
            throw new AppError(VALIDATION_ERRORS.INVALID_INPUT, HTTP_STATUS.BAD_REQUEST, {
                type: "ValidationError",
                details: [{ field: "flags", issue: "Must be an object of flag names to 'Y' or 'N'." }],
            });
        }
        const invalidKeys = Object.keys(flags).filter((k) => !ALLOWED_FLAG_KEYS.includes(k));
        if (invalidKeys.length > 0) {
            throw new AppError(VALIDATION_ERRORS.INVALID_INPUT, HTTP_STATUS.BAD_REQUEST, {
                type: "ValidationError",
                details: invalidKeys.map((k) => ({
                    field: k,
                    issue: `Unknown permission flag: "${k}".`,
                })),
            });
        }
        const invalidValues = Object.entries(flags).filter(([, v]) => v !== "Y" && v !== "N");
        if (invalidValues.length > 0) {
            throw new AppError(VALIDATION_ERRORS.INVALID_INPUT, HTTP_STATUS.BAD_REQUEST, {
                type: "ValidationError",
                details: invalidValues.map(([k]) => ({
                    field: k,
                    issue: `Flag "${k}" must be 'Y' or 'N'.`,
                })),
            });
        }
    }

    /**
     * Channel-keyed notification flags for AdminModel.setNotifyFlags.
     *
     * @param {object} flags - validated API flags
     * @returns {Record<string, 'Y'|'N'>}
     * @private
     */
    static _notifyChannelFlags(flags) {
        const channelFlags = {};
        for (const [key, channel] of Object.entries(NOTIFY_FLAG_CHANNELS)) {
            if (flags[key] !== undefined) channelFlags[channel] = flags[key];
        }
        return channelFlags;
    }

    // ─── Create admin ────────────────────────────────────────────────────────

    /**
     * Registers a new admin and emails the account holder a temporary password.
     *
     * Order is load-bearing:
     *   1. validate role / username / flags; refuse legacy password fields (400)
     *   2. role policy (403); 409 if the account exists
     *   3. resolve the recipient — refuses (400/422/503) BEFORE any write
     *   4. generate → hash → wrap with the expiry → sign → insert
     *   5. send — never throws; a failed send is reported, not rolled back
     *
     * Notification flags default to 'N' (deny-by-default, CWE-862); IS_ACTIVE
     * defaults to 'Y'. The resolved address is stored as the admin's EMAIL.
     *
     * @param {object} params
     * @param {string} params.username
     * @param {string} params.role
     * @param {{ username: string, role: string }} params.caller
     * @param {string} [params.overrideEmail] - only when no address is on file
     * @param {*} [params.retainPassword]     - legacy; any value → 400
     * @param {*} [params.newPassword]        - legacy; any value → 400
     * @param {object} [params.flags]
     * @returns {Promise<object>} `{ username, role, emailDelivered, recipientSource, recipientHint, tempPasswordExpiresAt }`
     * @throws {AppError} 400 | 403 | 409 | 422 | 503
     */
    static async addAdmin({ username, role, caller, overrideEmail, retainPassword, newPassword, flags }) {
        AdminManagementService._validateRole(role);

        if (retainPassword !== undefined || newPassword !== undefined) {
            logger.warning(adminMessages.TEMP_PASSWORD_LEGACY_FIELDS_REFUSED(username));
            throw new AppError(
                ADMIN_ERRORS.PASSWORD_FIELDS_NOT_ACCEPTED,
                HTTP_STATUS.BAD_REQUEST,
                {
                    type: "ValidationError",
                    details: [
                        ...(retainPassword !== undefined ? [{ field: "retainPassword", issue: "Not accepted." }] : []),
                        ...(newPassword !== undefined ? [{ field: "newPassword", issue: "Not accepted." }] : []),
                    ],
                },
            );
        }

        if (typeof username !== "string" || !USERNAME_PATTERN.test(username)) {
            throw new AppError(VALIDATION_ERRORS.INVALID_INPUT, HTTP_STATUS.BAD_REQUEST, {
                type: "ValidationError",
                details: [{ field: "username", issue: "Must be a username of 1 to 100 characters with no spaces." }],
            });
        }

        AdminManagementService._assertCanManage(caller, "create", { newRole: role });

        if (flags != null) AdminManagementService._validateFlags(flags);

        if (await AdminModel.existsByUsername(username)) {
            logger.warning(adminMessages.ADMIN_ALREADY_EXISTS(username));
            throw new AppError(ADMIN_ERRORS.ADMIN_ALREADY_EXISTS, HTTP_STATUS.CONFLICT, {
                type: "ConflictError",
                details: [{ field: "username", issue: "This account is already an admin." }],
            });
        }

        const recipient = await AdminAccessEmailService.resolveRecipient(username, overrideEmail);
        const issued = await AdminManagementService._issueTemporaryPassword();
        const isActive = flags?.isActive ?? "Y";

        const sysSignature = await CryptoVault.signRecord(
            AdminModel.SIGN_CONTEXT,
            AdminModel.buildSignedFields({
                USERNAME: username,
                PASSWORD: issued.storedValue,
                ROLE: role,
                IS_ACTIVE: isActive,
            }),
        );

        // A re-added username must not inherit a session issued to the
        // previous holder. Fail closed: no revoke, no insert.
        await RefreshTokenService.revokeAllForUser(username, REFRESH_REVOKE_REASONS.ADMIN_READD);

        await AdminModel.insertAdmin({
            username,
            password: issued.storedValue,
            role,
            sysSignature,
            isActive,
            email: recipient.address,
        });
        const channelFlags = AdminManagementService._notifyChannelFlags(flags ?? {});
        if (Object.values(channelFlags).includes("Y")) {
            await AdminModel.setNotifyFlags(username, channelFlags);
            AdminManagementService._invalidateRecipientCache();
        }
        logger.info(adminMessages.ADMIN_CREATED(username, role));

        const delivery = await AdminManagementService._deliverTemporaryPassword({
            username,
            role,
            recipient,
            issued,
            kind: AdminAccessEmailService.EMAIL_KIND.GRANTED,
        });
        return { username, role, ...delivery };
    }

    // ─── Temporary passwords ─────────────────────────────────────────────────

    /**
     * Generates a temporary password and the PASSWORD value that stores it
     * (admin hash mode, wrapped with its expiry marker).
     *
     * @returns {Promise<{ tempPassword: string, storedValue: string, expiresAt: number }>}
     * @throws {AppError} 500 when the wrapped hash cannot be stored
     * @private
     */
    static async _issueTemporaryPassword() {
        const tempPassword = generateTemporaryPassword();
        // Whole seconds — the marker's resolution — so the email, the response
        // and the stored value all name the SAME instant.
        const expiresAt = Math.floor((Date.now() + TEMP_PASSWORD_TTL_MS) / 1000) * 1000;
        const hash = await CryptoVault.hashAdminPassword(tempPassword);
        try {
            return { tempPassword, storedValue: wrapTemporaryHash(hash, expiresAt), expiresAt };
        } catch (err) {
            if (err instanceof RangeError) {
                throw new AppError(
                    ADMIN_ERRORS.TEMP_PASSWORD_STORAGE_MISCONFIGURED,
                    HTTP_STATUS.INTERNAL_SERVER_ERROR,
                    { type: "ConfigurationError" },
                );
            }
            throw err;
        }
    }

    /**
     * Emails an already-persisted temporary password and shapes the response.
     * Never throws — the row is written by now; a failed send is reported
     * (`emailDelivered: false`) so the operator can use Reset Password.
     *
     * @private
     */
    static async _deliverTemporaryPassword({ username, role, recipient, issued, kind }) {
        const { delivered } = await AdminAccessEmailService.sendTemporaryPassword({
            to: recipient.address,
            source: recipient.source,
            username,
            role,
            tempPassword: issued.tempPassword,
            expiresAt: issued.expiresAt,
            kind,
        });
        return {
            emailDelivered: delivered,
            recipientSource: recipient.source,
            recipientHint: recipient.hint,
            tempPasswordExpiresAt: new Date(issued.expiresAt).toISOString(),
        };
    }

    // ─── Update admin ────────────────────────────────────────────────────────

    /**
     * Changes an admin's ROLE (SUPER_ADMIN only). Edit never touches the
     * password: `changePassword: true` or any `newPassword` is REFUSED (400).
     * Demoting the last active SUPER_ADMIN is refused (409). The role is a
     * signed claim in every token of the account, so its sessions end first.
     *
     * @param {object} params
     * @param {string} params.username
     * @param {string} params.role
     * @param {{ username: string, role: string }} params.caller
     * @param {boolean} [params.changePassword] - legacy; true → 400
     * @param {*} [params.newPassword]          - legacy; any value → 400
     * @returns {Promise<{ username: string, role: string }>}
     * @throws {AppError} 400 | 403 | 404 | 409 | 422
     */
    static async updateAdmin({ username, role, caller, changePassword, newPassword }) {
        AdminManagementService._validateRole(role);

        if (changePassword === true || newPassword !== undefined) {
            throw new AppError(
                ADMIN_ERRORS.EDIT_PASSWORD_NOT_ACCEPTED,
                HTTP_STATUS.BAD_REQUEST,
                {
                    type: "ValidationError",
                    details: [
                        ...(changePassword === true ? [{ field: "changePassword", issue: "Not accepted." }] : []),
                        ...(newPassword !== undefined ? [{ field: "newPassword", issue: "Not accepted." }] : []),
                    ],
                },
            );
        }

        AdminManagementService._assertCanManage(caller, "changeRole", { target: username, newRole: role });

        const existing = await AdminManagementService._fetchAndVerify(username);

        const sysSignature = await CryptoVault.signRecord(
            AdminModel.SIGN_CONTEXT,
            AdminModel.buildSignedFields({ ...existing, ROLE: role }),
        );

        const apply = async (session) => {
            if (existing.ROLE !== role) {
                await AdminManagementService._endSessions(username, SESSION_END_CAUSES.ROLE_CHANGED);
            }
            await AdminModel.updateRole(username, role, sysSignature, session);
        };

        if (existing.ROLE === "SUPER_ADMIN" && role !== "SUPER_ADMIN") {
            await AdminManagementService._withSuperAdminGuard(existing, apply);
        } else {
            await apply(null);
        }
        AdminManagementService._invalidateProfileFlags(username);
        logger.info(adminMessages.ADMIN_UPDATED(username));

        return { username, role };
    }

    // ─── Reset password ──────────────────────────────────────────────────────

    /**
     * Replaces an admin's password with a new temporary one and emails it. The
     * previous password — including an unclaimed temporary one — stops working
     * the moment the update commits, and every session of the account ends.
     * This is also how an EXPIRED temporary password is reissued.
     *
     * @param {string} username
     * @param {object} [opts]
     * @param {string} [opts.overrideEmail] - only when no address is on file
     * @param {{ username: string, role: string }} [opts.caller]
     * @returns {Promise<object>}
     * @throws {AppError} 400 | 403 | 404 | 422 | 503
     */
    static async resetPassword(username, { overrideEmail, caller } = {}) {
        const existing = await AdminManagementService._fetchAndVerify(username);

        AdminManagementService._assertCanManage(caller, "resetPassword", {
            target: username,
            targetRole: existing.ROLE,
        });

        const recipient = await AdminAccessEmailService.resolveRecipient(username, overrideEmail);
        const issued = await AdminManagementService._issueTemporaryPassword();

        const sysSignature = await CryptoVault.signRecord(
            AdminModel.SIGN_CONTEXT,
            AdminModel.buildSignedFields({ ...existing, PASSWORD: issued.storedValue }),
        );

        // A reset ends every session of the account (CWE-613). Fail closed: if
        // the revoke cannot be recorded the password is NOT replaced.
        await RefreshTokenService.revokeAllForUser(username, REFRESH_REVOKE_REASONS.PASSWORD_RESET);

        await AdminModel.updateCredentials(username, issued.storedValue, sysSignature);
        // The operator typed an address because none was on file: keep it, so
        // the next reset (and server notifications) reach the same inbox.
        if (recipient.source === AdminAccessEmailService.RECIPIENT_SOURCE.OVERRIDE) {
            await AdminModel.setEmail(username, recipient.address);
        }
        logger.info(adminMessages.ADMIN_PASSWORD_RESET(username));

        const delivery = await AdminManagementService._deliverTemporaryPassword({
            username,
            role: existing.ROLE,
            recipient,
            issued,
            kind: AdminAccessEmailService.EMAIL_KIND.RESET,
        });
        return { username, ...delivery };
    }

    // ─── Reset signature ─────────────────────────────────────────────────────

    /**
     * Recomputes SYSSIGNATURE from the current signed fields without changing
     * any data. Repairs rows broken by a manual DB correction or a signing-key
     * rotation. Does NOT verify the old signature — repairing it is the point.
     * Re-signing erases tamper evidence, so SUPER_ADMIN only.
     *
     * @param {string} username
     * @param {object} [opts]
     * @param {{ username: string, role: string }} [opts.caller]
     * @returns {Promise<{ username: string }>}
     * @throws {AppError} 403 | 404
     */
    static async resetSignature(username, { caller } = {}) {
        AdminManagementService._assertCanManage(caller, "resetSignature", { target: username });

        const existing = await AdminModel.findByUsername(username);
        if (!existing) {
            logger.warning(adminMessages.ADMIN_NOT_FOUND(username));
            throw new AppError(ADMIN_ERRORS.ADMIN_NOT_FOUND, HTTP_STATUS.NOT_FOUND, {
                type: "NotFoundError",
            });
        }

        const sysSignature = await CryptoVault.signRecord(
            AdminModel.SIGN_CONTEXT,
            AdminModel.buildSignedFields(existing),
        );
        await AdminModel.updateCredentials(existing.USERNAME, existing.PASSWORD, sysSignature);

        logger.info(adminMessages.ADMIN_SIGNATURE_RESET(username));
        return { username };
    }

    // ─── Delete admin ────────────────────────────────────────────────────────

    /**
     * Permanently removes an admin. Permitted only when the caller is not
     * deleting itself, the last active SUPER_ADMIN would remain, and a valid
     * revoke-backup token bound to THIS admin and the caller is supplied.
     * SYSSIGNATURE is verified first (no tamper-blind deletion).
     *
     * @param {object} params
     * @param {string} params.username
     * @param {string} params.backupToken - issued by `POST /:username/revoke-backup`
     * @param {string} params.callerUsername
     * @param {number|string} params.callerId - numeric id the backup token is bound to
     * @returns {Promise<{ username: string }>}
     * @throws {AppError} 403 | 404 | 409 | 422 | 428
     */
    static async deleteAdmin({ username, backupToken, callerUsername, callerId }) {
        if (String(username) === String(callerUsername)) {
            logger.warning(adminMessages.ADMIN_DELETE_SELF_BLOCKED(username));
            throw new AppError(ADMIN_ERRORS.CANNOT_DELETE_SELF, HTTP_STATUS.FORBIDDEN, {
                type: "AuthorizationError",
            });
        }

        const existing = await AdminManagementService._fetchAndVerify(username);
        // Guard first: a refused delete must not burn the backup token.
        await AdminManagementService._withSuperAdminGuard(existing, async (session) => {
            await AdminManagementService._verifyRevokeBackupToken(backupToken, username, callerId);
            await AdminManagementService._endSessions(username, SESSION_END_CAUSES.ADMIN_DELETED);
            await AdminModel.deleteAdmin(username, session);
        });
        AdminManagementService._invalidateProfileFlags(username);
        AdminManagementService._invalidateRecipientCache();

        logger.alert(adminMessages.ADMIN_DELETED(username));
        return { username };
    }

    // ─── Access Control revoke ───────────────────────────────────────────────

    /**
     * Streams an ENTITY-kind backup archive scoped to ONE admin — their
     * T_ADMINS_DEV row, their audit-log rows and their alert acknowledgements —
     * and returns the backup token that gates both `revokeAccess` and
     * `deleteAdmin`.
     *
     * ⚠ The archive contains the password hash and SYSSIGNATURE — credential
     * material. Never log or email the downloaded file.
     *
     * @param {object} params
     * @param {string} params.username - the admin being revoked/deleted
     * @param {number|string} params.actorId - numeric id of the acting SUPER_ADMIN; the token is bound to it
     * @param {string|null} [params.requestId]
     * @returns {Promise<{ zipBuffer: Buffer, filename: string, token: string, expiresAt: number, totalRows: number, tableCount: number, rowCounts: Record<string, number> }>}
     * @throws {AppError} 404 | 422
     */
    static async buildRevokeBackup({ username, actorId, requestId = null }) {
        const admin = await AdminManagementService._fetchAndVerify(username);

        const filterFor = {
            T_ADMINS_DEV: { columns: ["USERNAME"], value: String(username) },
            T_AUDIT_LOGS_DEV: { columns: ["USERNAME"], value: String(username) },
            T_SERVER_ALERT_ACK_DEV: { columns: ["ACKED_BY"], value: Number(admin.ID) },
        };
        // Derived from BackupArchiveService.ADMIN_REVOKE_BACKUP_TABLES so the
        // archive's table set — and its scope hash — can never drift from what
        // _verifyRevokeBackupToken recomputes.
        const tableFilters = BackupArchiveService.ADMIN_REVOKE_BACKUP_TABLES.map((table) => ({
            table,
            whereColumns: filterFor[table].columns,
            whereValue: filterFor[table].value,
        }));

        const result = await BackupArchiveService.buildEntityBackup({
            entity: _revokeEntity(username),
            tableFilters,
            adminId: actorId,
            requestId,
        });
        logger.info(adminMessages.ADMIN_REVOKE_BACKUP_ISSUED(username, actorId));
        return result;
    }

    /**
     * Revokes access — the DEFAULT, non-destructive way access is removed:
     * IS_ACTIVE='N' (re-signed) and every notification flag 'N'. Login and
     * refresh already refuse an inactive account.
     *
     * Guards: cannot revoke self; cannot revoke the last active SUPER_ADMIN;
     * requires a backup token bound to this admin AND the caller.
     *
     * @param {object} params
     * @param {string} params.username
     * @param {string} params.callerUsername
     * @param {number|string} params.callerId
     * @param {string} params.backupToken
     * @returns {Promise<{ username: string, isActive: string }>}
     * @throws {AppError} 403 | 404 | 409 | 422 | 428
     */
    static async revokeAccess({ username, callerUsername, callerId, backupToken }) {
        if (String(username) === String(callerUsername)) {
            logger.warning(adminMessages.ADMIN_REVOKE_SELF_BLOCKED(username));
            throw new AppError(ADMIN_ERRORS.CANNOT_REVOKE_SELF, HTTP_STATUS.FORBIDDEN, {
                type: "AuthorizationError",
            });
        }

        const existing = await AdminManagementService._fetchAndVerify(username);

        const sysSignature = await CryptoVault.signRecord(
            AdminModel.SIGN_CONTEXT,
            AdminModel.buildSignedFields({ ...existing, IS_ACTIVE: "N" }),
        );

        // Guard first: a refused revoke must not burn the backup token.
        await AdminManagementService._withSuperAdminGuard(existing, async (session) => {
            await AdminManagementService._verifyRevokeBackupToken(backupToken, username, callerId);

            // End every session BEFORE the flag flips (fail closed).
            await AdminManagementService._endSessions(username, SESSION_END_CAUSES.ACCESS_REVOKED);

            await AdminModel.setActive(username, "N", sysSignature, session);
            await AdminModel.setNotifyFlags(
                username,
                Object.fromEntries(Object.values(NOTIFY_FLAG_CHANNELS).map((channel) => [channel, "N"])),
                session,
            );
        });
        AdminManagementService._invalidateProfileFlags(username);
        AdminManagementService._invalidateRecipientCache();

        logger.alert(adminMessages.ADMIN_REVOKED(username, callerUsername));
        return { username, isActive: "N" };
    }

    // ─── Update permission flags ─────────────────────────────────────────────

    /**
     * Updates an admin's notification opt-ins and IS_ACTIVE (SUPER_ADMIN only,
     * enforced by the route). SYSSIGNATURE is verified first and re-computed
     * when IS_ACTIVE changes (the notification flags are outside the signed
     * field set). Deactivating ends the account's sessions and is refused for
     * the last active SUPER_ADMIN.
     *
     * @param {object} params
     * @param {string} params.username
     * @param {object} params.flags - keys from ALLOWED_FLAG_KEYS → 'Y'|'N'
     * @returns {Promise<{ username: string, flags: object }>}
     * @throws {AppError} 400 | 404 | 409 | 422
     */
    static async updatePermissions({ username, flags }) {
        AdminManagementService._validateFlags(flags);

        const existing = await AdminManagementService._fetchAndVerify(username);
        const wasActive = String(existing.IS_ACTIVE ?? "Y");
        const deactivating = flags.isActive === "N" && wasActive !== "N";

        const activeChanging = flags.isActive !== undefined && flags.isActive !== wasActive;
        const sysSignature = activeChanging
            ? await CryptoVault.signRecord(
                AdminModel.SIGN_CONTEXT,
                AdminModel.buildSignedFields({ ...existing, IS_ACTIVE: flags.isActive }),
            )
            : null;

        const applyActive = async (session) => {
            if (deactivating) {
                await AdminManagementService._endSessions(username, SESSION_END_CAUSES.DEACTIVATED);
            }
            if (activeChanging) {
                await AdminModel.setActive(username, flags.isActive, sysSignature, session);
            }
        };

        if (deactivating) {
            await AdminManagementService._withSuperAdminGuard(existing, applyActive);
        } else {
            await applyActive(null);
        }

        const channelFlags = AdminManagementService._notifyChannelFlags(flags);
        if (Object.keys(channelFlags).length > 0) {
            await AdminModel.setNotifyFlags(username, channelFlags);
        }

        logger.info(adminMessages.ADMIN_PERMISSIONS_UPDATED(username, flags));
        AdminManagementService._invalidateProfileFlags(username);
        // A notification opt-in must take effect on the very next alert.
        if (Object.keys(channelFlags).length > 0 || flags.isActive !== undefined) {
            AdminManagementService._invalidateRecipientCache();
        }

        return { username, flags };
    }

    // ─── Private helpers ─────────────────────────────────────────────────────

    /**
     * Ends every session of an account (refresh and access tokens, every
     * worker). Stored as REVOKE_REASON 'LOGOUT'; the specific cause is logged.
     * FAILS CLOSED: a database error propagates so the caller aborts its write.
     *
     * @param {string} username
     * @param {string} cause - SESSION_END_CAUSES value
     * @returns {Promise<void>}
     * @private
     */
    static async _endSessions(username, cause) {
        await RefreshTokenService.revokeAllForUser(username, REFRESH_REVOKE_REASONS.LOGOUT, { cause });
    }

    /**
     * Verifies AND CONSUMES a revoke-backup token: present, valid, unexpired,
     * bound to the CALLER and scoped to THIS target (scope hash recomputed from
     * the target username — a backup for admin A cannot unlock admin B). The
     * token is burned the instant it verifies, so a later refusal requires a
     * fresh backup: replay protection beats retry convenience here.
     *
     * Every failure collapses to the same client message; the reason is logged
     * server-side only (CWE-209).
     *
     * @param {string|undefined} backupToken
     * @param {string} targetUsername
     * @param {number|string} callerId
     * @returns {Promise<void>}
     * @throws {AppError} 428
     * @private
     */
    static async _verifyRevokeBackupToken(backupToken, targetUsername, callerId) {
        if (!backupToken) {
            throw new AppError(ADMIN_ERRORS.BACKUP_TOKEN_REQUIRED, HTTP_STATUS.PRECONDITION_REQUIRED, {
                type: "AuthenticationError",
            });
        }

        const tokenResult = await BackupTokenService.consume(backupToken);
        if (!tokenResult.valid) {
            logger.warning(adminMessages.ADMIN_REVOKE_TOKEN_REJECTED(targetUsername, tokenResult.reason));
            throw new AppError(ADMIN_ERRORS.BACKUP_TOKEN_INVALID, HTTP_STATUS.PRECONDITION_REQUIRED, {
                type: "AuthenticationError",
            });
        }

        if (String(tokenResult.payload.adminId) !== String(callerId)) {
            logger.warning(adminMessages.ADMIN_REVOKE_TOKEN_REJECTED(targetUsername, "wrong admin"));
            throw new AppError(ADMIN_ERRORS.BACKUP_TOKEN_INVALID, HTTP_STATUS.PRECONDITION_REQUIRED, {
                type: "AuthenticationError",
            });
        }

        const expectedScopeHash = BackupArchiveService.computeEntityScopeHash(
            _revokeEntity(targetUsername),
            BackupArchiveService.ADMIN_REVOKE_BACKUP_TABLES,
        );
        if (tokenResult.payload.scopeHash !== expectedScopeHash) {
            logger.warning(adminMessages.ADMIN_REVOKE_TOKEN_REJECTED(targetUsername, "scope mismatch (token issued for a different admin)"));
            throw new AppError(ADMIN_ERRORS.BACKUP_TOKEN_INVALID, HTTP_STATUS.PRECONDITION_REQUIRED, {
                type: "AuthenticationError",
            });
        }
    }

    /**
     * Self-lockout guard: runs `fn` inside AdminModel.withLastSuperAdminGuard
     * (one transaction, active SUPER_ADMIN rows locked FOR UPDATE, 409 when the
     * target is the last one) when `existing` is an active SUPER_ADMIN, else
     * runs `fn(null)` directly — such a target cannot reduce the count, so no
     * lock is taken. `fn` must pass the session to its T_ADMINS_DEV writes.
     *
     * @template T
     * @param {object} existing - the target's current T_ADMINS_DEV row
     * @param {(session: object|null) => Promise<T>} fn
     * @returns {Promise<T>}
     * @throws {AppError} 409 LAST_ACTIVE_SUPER_ADMIN
     * @private
     */
    static async _withSuperAdminGuard(existing, fn) {
        if (existing.ROLE !== "SUPER_ADMIN" || String(existing.IS_ACTIVE ?? "Y") !== "Y") {
            return fn(null);
        }
        return AdminModel.withLastSuperAdminGuard(existing.ID, fn);
    }

    /**
     * Drops the cached /auth/me flags for an account so a change shows on the
     * next page load. Best effort — the entry expires by TTL regardless.
     *
     * @param {string} username
     * @private
     */
    static _invalidateProfileFlags(username) {
        try {
            registry
                .resolve("authProfile")
                .del(CacheKeyBuilder.build("authProfile", { username }));
        } catch {
            /* store not registered (unit-test bootstrap) */
        }
    }

    /**
     * Makes a notification opt-in change take effect on the next alert instead
     * of after the recipient cache TTL. Lazy require keeps the email subsystem
     * out of every caller's load graph.
     *
     * @private
     */
    static _invalidateRecipientCache() {
        const ServerNotificationService = require("./email/ServerNotificationService");
        ServerNotificationService.invalidateRecipientCache();
    }

    /**
     * Fetches an admin row and throws when absent (404) or when its
     * SYSSIGNATURE does not verify (422).
     *
     * @param {string} username
     * @returns {Promise<object>} the T_ADMINS_DEV row
     * @throws {AppError} 404 | 422
     * @private
     */
    static async _fetchAndVerify(username) {
        const existing = await AdminModel.findByUsername(username);
        if (!existing) {
            logger.warning(adminMessages.ADMIN_NOT_FOUND(username));
            throw new AppError(ADMIN_ERRORS.ADMIN_NOT_FOUND, HTTP_STATUS.NOT_FOUND, {
                type: "NotFoundError",
            });
        }

        const sigValid = await CryptoVault.verifyRecord(
            AdminModel.SIGN_CONTEXT,
            AdminModel.buildSignedFields(existing),
            existing.SYSSIGNATURE,
        );
        if (!sigValid) {
            logger.warning(adminMessages.ADMIN_SIGNATURE_INVALID(username));
            throw new AppError(
                ADMIN_ERRORS.SIGNATURE_RESET_REQUIRED,
                HTTP_STATUS.UNPROCESSABLE,
                { type: "DataIntegrityError" },
            );
        }

        return existing;
    }

    /**
     * @param {string} role
     * @throws {AppError} 400 when role is not in VALID_ROLES
     * @private
     */
    static _validateRole(role) {
        if (!VALID_ROLES.includes(role)) {
            throw new AppError(
                VALIDATION_ERRORS.INVALID_INPUT,
                HTTP_STATUS.BAD_REQUEST,
                {
                    type: "ValidationError",
                    details: [
                        {
                            field: "role",
                            issue: `Invalid role. Accepted values: ${VALID_ROLES.join(", ")}.`,
                        },
                    ],
                },
            );
        }
    }
}

module.exports = AdminManagementService;
