"use strict";

const { createDb, OracleCollection } = require("../utils/oracle-mongo-wrapper");
const { registry, CacheKeyBuilder } = require("../middleware/cache");

const _db            = createDb("Meal");
const _empAdmin      = new OracleCollection("T_EMP_MGMT_ADMIN",  _db);
const _empMasterList = new OracleCollection("T_EMP_MASTER_LIST", _db);

/**
 * Surgically removes the cached /auth/me permission flags for one EMP_ID.
 *
 * Every T_EMP_MGMT_ADMIN write in the application flows through the four
 * write methods of this model (insertAdmin / updateAdmin / updatePermissions /
 * deleteAdmin), so invalidating here — at the single chokepoint — guarantees
 * no service-layer call site can be missed. The authProfile TTL (30s) is the
 * self-healing backstop if the store is unregistered (unit-test bootstrap).
 *
 * @param {string|number} empId
 */
function _invalidateProfileFlags(empId) {
    try {
        registry
            .resolve("authProfile")
            .del(CacheKeyBuilder.build("authProfile", { empId }));
    } catch (_) {
        // Store not registered (tests without app.js) — TTL handles staleness.
    }
}

/**
 * Columns projected on every "full" admin fetch (includes permission flags
 * and audit columns added in migration v3.0).
 *
 * IMPORTANT: This projection drives SYSSIGNATURE re-computation — any change
 * here must be mirrored in the signed-field set used by CryptoVault.signRecord
 * throughout AdminManagementService and auth.service.
 */
const FULL_PROJECTION = {
    EMP_ID:              1,
    EMP_PW:              1,
    EMP_ROLE:            1,
    CAN_APPROVE_RESET:   1,
    CAN_REJECT_RESET:    1,
    CAN_APPROVE_BILLING: 1,
    CAN_REJECT_BILLING:  1,
    CAN_RECEIVE_BILLING: 1,
    CAN_EXPORT_BILLING:  1,
    IS_ACTIVE:           1,
    UPDATED_BY:          1,
    UPDATED_AT:          1,
    SYSSIGNATURE:        1,
};

/**
 * Returns the canonical signed-field object for a T_EMP_MGMT_ADMIN row.
 * All SYSSIGNATURE calls MUST pass these exact fields — adding/removing any
 * field here is a BREAKING CHANGE that requires a full-table re-sign migration.
 *
 * @param {object} row - A T_EMP_MGMT_ADMIN row (or partial with all required fields)
 * @returns {object} Fields to pass to CryptoVault.signRecord / verifyRecord
 */
function buildSignedFields(row) {
    return {
        EMP_ID:              row.EMP_ID,
        EMP_PW:              row.EMP_PW,
        EMP_ROLE:            row.EMP_ROLE,
        CAN_APPROVE_RESET:   row.CAN_APPROVE_RESET   ?? "Y",
        CAN_REJECT_RESET:    row.CAN_REJECT_RESET     ?? "Y",
        CAN_APPROVE_BILLING: row.CAN_APPROVE_BILLING  ?? "Y",
        CAN_REJECT_BILLING:  row.CAN_REJECT_BILLING   ?? "Y",
        CAN_RECEIVE_BILLING: row.CAN_RECEIVE_BILLING  ?? "N",
        CAN_EXPORT_BILLING:  row.CAN_EXPORT_BILLING   ?? "Y",
        IS_ACTIVE:           row.IS_ACTIVE             ?? "Y",
    };
}

class MealAdmModel {
    // ─── Reads ───────────────────────────────────────────────────────────────

    /**
     * Finds a single admin record by EMP_ID, including all permission flags.
     * Returns null when the row does not exist.
     *
     * @param {string|number} empId
     * @returns {Promise<object|null>}
     */
    static async findByEmpId(empId) {
        return _empAdmin
            .find({ EMP_ID: empId })
            .project(FULL_PROJECTION)
            .next();
    }

    /**
     * Returns all rows in T_EMP_MGMT_ADMIN ordered by EMP_ID, including all
     * permission flags.
     *
     * @returns {Promise<Array<object>>}
     */
    static async findAll() {
        return _empAdmin
            .find({})
            .project(FULL_PROJECTION)
            .sort({ EMP_ID: 1 })
            .toArray();
    }

    /**
     * Returns a minimal list of admins for the re-download request recipient
     * selector.  Joins T_EMP_MGMT_ADMIN (EMP_ID, EMP_ROLE, CAN_RECEIVE_BILLING,
     * IS_ACTIVE) with T_EMP_MASTER_LIST (NAME) so the frontend can display
     * "Full Name (EMP_ID)" instead of raw IDs.
     *
     * EMP_PW is deliberately excluded — never expose hashed passwords in list APIs.
     *
     * @returns {Promise<Array<{ empId: number, role: string, name: string|null, canReceiveBilling: string, isActive: string }>>}
     */
    static async listForSelector() {
        const admins = await _empAdmin
            .find({})
            .project({
                EMP_ID:              1,
                EMP_ROLE:            1,
                CAN_RECEIVE_BILLING: 1,
                IS_ACTIVE:           1,
            })
            .sort({ EMP_ID: 1 })
            .toArray();

        // Resolve names from T_EMP_MASTER_LIST in ONE $in batch — best-effort only.
        // Missing name → name will be null; caller should display EMP_ID instead.
        const nameMap = await MealAdmModel._getEmpNamesByIds(
            admins.map((a) => a.EMP_ID),
        );
        return admins.map((a) => ({
            empId:              Number(a.EMP_ID),
            role:               String(a.EMP_ROLE ?? ""),
            name:               nameMap.get(Number(a.EMP_ID)) ?? null,
            canReceiveBilling:  String(a.CAN_RECEIVE_BILLING ?? "N"),
            isActive:           String(a.IS_ACTIVE ?? "Y"),
        }));
    }

    /**
     * Returns all ACTIVE admins who have opted in to receive automatic billing
     * emails (IS_ACTIVE='Y' AND CAN_RECEIVE_BILLING='Y').
     *
     * @returns {Promise<Array<{ empId: number, role: string, name: string|null }>>}
     */
    static async findBillingRecipients() {
        const admins = await _empAdmin
            .find({ IS_ACTIVE: "Y", CAN_RECEIVE_BILLING: "Y" })
            .project({ EMP_ID: 1, EMP_ROLE: 1 })
            .sort({ EMP_ID: 1 })
            .toArray();

        const nameMap = await MealAdmModel._getEmpNamesByIds(
            admins.map((a) => a.EMP_ID),
        );
        return admins.map((a) => ({
            empId: Number(a.EMP_ID),
            role:  String(a.EMP_ROLE ?? ""),
            name:  nameMap.get(Number(a.EMP_ID)) ?? null,
        }));
    }

    /**
     * Resolves EMP_NAME for a batch of EMP_IDs in a single $in query.
     * Best-effort: on lookup failure an empty Map is returned so callers
     * degrade to name = null instead of failing the request.
     *
     * O(1) Oracle round-trips regardless of batch size (replaces the previous
     * one-query-per-admin pattern); O(n) space for the returned Map.
     *
     * @param {Array<string|number>} empIds
     * @returns {Promise<Map<number, string>>} EMP_ID → EMP_NAME
     * @private
     */
    static async _getEmpNamesByIds(empIds) {
        const ids = [...new Set((empIds ?? []).map(Number))].filter(
            Number.isFinite,
        );
        if (ids.length === 0) return new Map();
        try {
            const rows = await _empMasterList
                .find({ EMP_ID: { $in: ids } })
                .project({ EMP_ID: 1, EMP_NAME: 1 })
                .toArray();
            return new Map(
                (rows ?? []).map((r) => [Number(r.EMP_ID), r.EMP_NAME ?? null]),
            );
        } catch (_) {
            return new Map();
        }
    }

    /**
     * Returns the subset of the given EMP_IDs that already have an admin row,
     * resolved in a single $in query.
     *
     * Replaces per-row existsByEmpId() fan-out (one COUNT query per candidate)
     * in AdminManagementService.searchEmployees — O(1) Oracle round-trips.
     *
     * @param {Array<string|number>} empIds
     * @returns {Promise<Set<number>>} EMP_IDs that exist in T_EMP_MGMT_ADMIN
     */
    static async findExistingEmpIds(empIds) {
        const ids = [...new Set((empIds ?? []).map(Number))].filter(
            Number.isFinite,
        );
        if (ids.length === 0) return new Set();
        const rows = await _empAdmin
            .find({ EMP_ID: { $in: ids } })
            .project({ EMP_ID: 1 })
            .toArray();
        return new Set((rows ?? []).map((r) => Number(r.EMP_ID)));
    }

    /**
     * Counts active admins (IS_ACTIVE='Y') that have the given flag set to 'Y',
     * excluding the admin identified by `excludeEmpId`.
     *
     * Used by the zero-approver guard before any permission flag update or
     * deactivation to ensure at least one OTHER admin retains the capability.
     *
     * @param {string} flagColumn  - Column name, e.g. 'CAN_APPROVE_RESET'
     * @param {string|number} excludeEmpId - The admin being changed (excluded from count)
     * @returns {Promise<number>}
     */
    static async countActiveAdminsWithFlag(flagColumn, excludeEmpId) {
        // oracle-mongo-wrapper filter syntax — build a dynamic filter object.
        // The flag columns only hold 'Y' or 'N'; IS_ACTIVE likewise.
        const filter = {
            IS_ACTIVE:       "Y",
            [flagColumn]:    "Y",
            EMP_ID:          { $ne: excludeEmpId },
        };
        return _empAdmin.find(filter).count();
    }

    /**
     * Returns true when an admin record with the given EMP_ID already exists.
     *
     * @param {string|number} empId
     * @returns {Promise<boolean>}
     */
    static async existsByEmpId(empId) {
        const count = await _empAdmin.find({ EMP_ID: empId }).count();
        return count > 0;
    }

    // ─── Writes ──────────────────────────────────────────────────────────────

    /**
     * Inserts a new admin record.
     *
     * Permission flags default to: ADMIN/SUPER_ADMIN → approve/reject/export all 'Y',
     * CAN_RECEIVE_BILLING 'N', IS_ACTIVE 'Y'.  Callers may pass explicit values.
     *
     * T_EMP_MGMT_ADMIN has no "ID" column — returning EMP_ID prevents insertOne
     * from appending the default RETURNING "ID" clause.
     *
     * @param {string|number} empId
     * @param {string} empPwHash       - hashed password (bcrypt or argon2)
     * @param {string} empRole
     * @param {string} sysSignature    - from CryptoVault.signRecord()
     * @param {object} [flags]         - optional permission flags override
     * @param {string} [flags.canApproveReset='Y']
     * @param {string} [flags.canRejectReset='Y']
     * @param {string} [flags.canApproveBilling='Y']
     * @param {string} [flags.canRejectBilling='Y']
     * @param {string} [flags.canReceiveBilling='N']
     * @param {string} [flags.canExportBilling='Y']
     * @param {string} [flags.isActive='Y']
     * @returns {Promise<void>}
     */
    static async insertAdmin(empId, empPwHash, empRole, sysSignature, flags = {}) {
        await _empAdmin.insertOne(
            {
                EMP_ID:              empId,
                EMP_PW:              empPwHash,
                EMP_ROLE:            empRole,
                CAN_APPROVE_RESET:   flags.canApproveReset   ?? "Y",
                CAN_REJECT_RESET:    flags.canRejectReset     ?? "Y",
                CAN_APPROVE_BILLING: flags.canApproveBilling  ?? "Y",
                CAN_REJECT_BILLING:  flags.canRejectBilling   ?? "Y",
                CAN_RECEIVE_BILLING: flags.canReceiveBilling  ?? "N",
                CAN_EXPORT_BILLING:  flags.canExportBilling   ?? "Y",
                IS_ACTIVE:           flags.isActive           ?? "Y",
                SYSSIGNATURE:        sysSignature,
            },
            { returning: ["EMP_ID"] },
        );
        _invalidateProfileFlags(empId);
    }

    /**
     * Updates EMP_PW, EMP_ROLE, and renews SYSSIGNATURE atomically.
     * Only call after computing a fresh signature via CryptoVault.signRecord().
     *
     * @param {string|number} empId
     * @param {string} empPwHash
     * @param {string} empRole
     * @param {string} sysSignature
     * @returns {Promise<void>}
     */
    static async updateAdmin(empId, empPwHash, empRole, sysSignature) {
        await _empAdmin.updateOne(
            { EMP_ID: empId },
            {
                $set: {
                    EMP_PW:       empPwHash,
                    EMP_ROLE:     empRole,
                    SYSSIGNATURE: sysSignature,
                },
            },
        );
        _invalidateProfileFlags(empId);
    }

    /**
     * Updates one or more permission flags for an admin, renewing SYSSIGNATURE.
     * Call this after computing the new signature via CryptoVault.signRecord().
     *
     * Accepted flag keys (camelCase → DB column):
     *   canApproveReset   → CAN_APPROVE_RESET
     *   canRejectReset    → CAN_REJECT_RESET
     *   canApproveBilling → CAN_APPROVE_BILLING
     *   canRejectBilling  → CAN_REJECT_BILLING
     *   canReceiveBilling → CAN_RECEIVE_BILLING
     *   canExportBilling  → CAN_EXPORT_BILLING
     *   isActive          → IS_ACTIVE
     *
     * @param {string|number} empId
     * @param {object} flags       - Only the flags being changed
     * @param {string|number|null} updatedBy  - EMP_ID of the actor making the change
     * @param {string} sysSignature
     * @returns {Promise<void>}
     */
    static async updatePermissions(empId, flags, updatedBy, sysSignature) {
        const FLAG_MAP = {
            canApproveReset:   "CAN_APPROVE_RESET",
            canRejectReset:    "CAN_REJECT_RESET",
            canApproveBilling: "CAN_APPROVE_BILLING",
            canRejectBilling:  "CAN_REJECT_BILLING",
            canReceiveBilling: "CAN_RECEIVE_BILLING",
            canExportBilling:  "CAN_EXPORT_BILLING",
            isActive:          "IS_ACTIVE",
        };

        const $set = { SYSSIGNATURE: sysSignature };

        if (updatedBy != null) {
            $set.UPDATED_BY = Number(updatedBy);
            $set.UPDATED_AT = new Date();
        }

        for (const [camel, col] of Object.entries(FLAG_MAP)) {
            if (flags[camel] !== undefined) {
                $set[col] = String(flags[camel]).toUpperCase() === "Y" ? "Y" : "N";
            }
        }

        await _empAdmin.updateOne({ EMP_ID: empId }, { $set });
        _invalidateProfileFlags(empId);
    }

    /**
     * Deletes an admin record by EMP_ID.
     *
     * @param {string|number} empId
     * @returns {Promise<void>}
     */
    static async deleteAdmin(empId) {
        await _empAdmin.deleteOne({ EMP_ID: empId });
        _invalidateProfileFlags(empId);
    }

    // ─── HRIS helpers ────────────────────────────────────────────────────────

    /**
     * Resolves the permanent GID for an employee by their EMP_ID.
     *
     * GID is the permanent identifier — it never changes even when HR updates
     * EMP_ID across entity transfers. Returns null when the employee is not
     * yet registered in T_EMP_MASTER_LIST (e.g. new admin accounts).
     *
     * @param {string|number} empId - EMP_ID used as login credential
     * @returns {Promise<number|null>} GID, or null if not found
     */
    static async findGidByEmpId(empId) {
        const row = await _empMasterList
            .find({ EMP_ID: empId })
            .project({ GID: 1 })
            .next();
        return row ? Number(row.GID) : null;
    }

    /**
     * Resolves the email address for an employee by EMP_ID via T_EMP_MASTER_LIST.
     * Returns null when the employee is not found or has no email.
     * The email column in T_EMP_MASTER_LIST is EMP_EMAIL.
     *
     * @param {string|number} empId
     * @returns {Promise<string|null>}
     */
    static async findEmailByEmpId(empId) {
        const row = await _empMasterList
            .find({ EMP_ID: empId })
            .project({ EMP_EMAIL: 1 })
            .next()
            .catch(() => null);
        return row?.EMP_EMAIL ?? null;
    }
}

// Expose the helper so auth.service and AdminManagementService can compute
// the canonical signed payload without importing model internals.
MealAdmModel.buildSignedFields = buildSignedFields;

module.exports = MealAdmModel;
