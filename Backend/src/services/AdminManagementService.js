"use strict";

/**
 * @fileoverview Admin Management business logic.
 *
 * Owns all operations on T_ADMINS_DEV (CRUD, password reset, signature reset).
 * Uses the standalone AdminModel (T_ADMINS_DEV) — no external dependencies.
 *
 * Security:
 *  - SYSSIGNATURE is verified before every write and delete operation.
 *  - Default password is enforced server-side — never accepted as a new password.
 *  - Roles are validated against the canonical set before any DB write.
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
const AdminModel = require("../models/admin.model");

/** Canonical set of valid ROLE values for T_ADMINS_DEV. */
const VALID_ROLES = ["ADMIN", "SUPER_ADMIN", "USER"];

class AdminManagementService {
    // ─── Admin list ──────────────────────────────────────────────────────────

    /**
     * Returns all admin records with a `signatureValid` boolean on each row.
     *
     * @returns {Promise<Array<object>>}
     */
    static async listAdmins() {
        const admins = await AdminModel.findAll();

        const enriched = await Promise.all(
            admins.map(async (admin) => {
                const sigValid = await CryptoVault.verifyRecord(
                    AdminModel.SIGN_CONTEXT,
                    AdminModel.buildSignedFields(admin),
                    admin.SYSSIGNATURE,
                );

                if (!sigValid) {
                    logger.warning(
                        adminMessages.ADMIN_SIGNATURE_INVALID(admin.USERNAME),
                    );
                }

                // Map to the shape the frontend expects (empId / empRole / etc.)
                return {
                    empId: admin.USERNAME,
                    empRole: admin.ROLE,
                    firstName: null,
                    lastName: null,
                    isActive: String(admin.IS_ACTIVE ?? "Y"),
                    signatureValid: sigValid,
                    createdAt: admin.CREATED_AT ?? null,
                    updatedAt: admin.UPDATED_AT ?? null,
                };
            }),
        );

        logger.info(adminMessages.ADMIN_LIST_FETCHED());
        return enriched;
    }

    // ─── Create admin ────────────────────────────────────────────────────────

    /**
     * Registers a new admin in T_ADMINS_DEV.
     */
    static async addAdmin({
        username,
        role,
        retainPassword,
        newPassword,
        isActive,
    }) {
        AdminManagementService._validateRole(role);

        if (await AdminModel.existsByUsername(username)) {
            logger.warning(adminMessages.ADMIN_ALREADY_EXISTS(username));
            throw new AppError(
                ADMIN_ERRORS.ADMIN_ALREADY_EXISTS,
                HTTP_STATUS.CONFLICT,
                {
                    type: "ConflictError",
                    details: [
                        {
                            field: "username",
                            issue: "This username is already an admin.",
                        },
                    ],
                },
            );
        }

        const password = retainPassword
            ? process.env.ADMIN_DEFAULT_PASSWORD
            : newPassword;
        if (!retainPassword)
            AdminManagementService._rejectDefaultPassword(password);
        if (!password) {
            throw new AppError(
                VALIDATION_ERRORS.MISSING_FIELDS,
                HTTP_STATUS.BAD_REQUEST,
                {
                    type: "ValidationError",
                    details: [
                        {
                            field: "newPassword",
                            issue: "A password is required when retainPassword is false.",
                        },
                    ],
                },
            );
        }

        const pwHash = await CryptoVault.hashPassword(password);
        const sysSignature = await CryptoVault.signRecord(
            AdminModel.SIGN_CONTEXT,
            AdminModel.buildSignedFields({
                USERNAME: username,
                PASSWORD: pwHash,
                ROLE: role,
                IS_ACTIVE: isActive ?? "Y",
            }),
        );

        await AdminModel.insertAdmin({
            username,
            password: pwHash,
            role,
            sysSignature,
            isActive: isActive ?? "Y",
        });
        logger.info(adminMessages.ADMIN_CREATED(username, role));
        return { username, role };
    }

    // ─── Update admin ────────────────────────────────────────────────────────

    static async updateAdmin({ username, role, changePassword, newPassword }) {
        AdminManagementService._validateRole(role);
        const existing = await AdminManagementService._fetchAndVerify(username);

        let pwHash = existing.PASSWORD;
        if (changePassword) {
            if (!newPassword) {
                throw new AppError(
                    VALIDATION_ERRORS.MISSING_FIELDS,
                    HTTP_STATUS.BAD_REQUEST,
                    {
                        type: "ValidationError",
                        details: [
                            {
                                field: "newPassword",
                                issue: "A new password is required when changePassword is true.",
                            },
                        ],
                    },
                );
            }
            AdminManagementService._rejectDefaultPassword(newPassword);
            pwHash = await CryptoVault.hashPassword(newPassword);
        }

        const sysSignature = await CryptoVault.signRecord(
            AdminModel.SIGN_CONTEXT,
            AdminModel.buildSignedFields({
                ...existing,
                PASSWORD: pwHash,
                ROLE: role,
            }),
        );

        if (changePassword)
            await AdminModel.updateCredentials(username, pwHash, sysSignature);
        await AdminModel.updateRole(username, role, sysSignature);
        logger.info(adminMessages.ADMIN_UPDATED(username));
        return { username, role };
    }

    // ─── Reset password ──────────────────────────────────────────────────────

    static async resetPassword(username) {
        const existing = await AdminManagementService._fetchAndVerify(username);
        const defaultPw = process.env.ADMIN_DEFAULT_PASSWORD;
        if (!defaultPw) {
            throw new AppError(
                "ADMIN_DEFAULT_PASSWORD environment variable is not configured.",
                HTTP_STATUS.INTERNAL_SERVER_ERROR,
                { type: "ConfigurationError" },
            );
        }

        const pwHash = await CryptoVault.hashPassword(defaultPw);
        const sysSignature = await CryptoVault.signRecord(
            AdminModel.SIGN_CONTEXT,
            AdminModel.buildSignedFields({ ...existing, PASSWORD: pwHash }),
        );

        await AdminModel.updateCredentials(username, pwHash, sysSignature);
        logger.info(adminMessages.ADMIN_PASSWORD_RESET(username));
        return { username };
    }

    // ─── Reset signature ─────────────────────────────────────────────────────

    static async resetSignature(username) {
        const existing = await AdminModel.findByUsername(username);
        if (!existing) {
            logger.warning(adminMessages.ADMIN_NOT_FOUND(username));
            throw new AppError(
                ADMIN_ERRORS.ADMIN_NOT_FOUND,
                HTTP_STATUS.NOT_FOUND,
                { type: "NotFoundError" },
            );
        }

        const sysSignature = await CryptoVault.signRecord(
            AdminModel.SIGN_CONTEXT,
            AdminModel.buildSignedFields(existing),
        );

        await AdminModel.updateCredentials(
            existing.USERNAME,
            existing.PASSWORD,
            sysSignature,
        );
        logger.info(adminMessages.ADMIN_SIGNATURE_RESET(username));
        return { username };
    }

    // ─── Delete admin ────────────────────────────────────────────────────────

    static async deleteAdmin(username) {
        const existing = await AdminManagementService._fetchAndVerify(username);

        // Last-super-admin guard
        if (existing.ROLE === "SUPER_ADMIN") {
            const others = await AdminModel.countActiveByRole(
                "SUPER_ADMIN",
                username,
            );
            if (others === 0) {
                throw new AppError(
                    ADMIN_ERRORS.LAST_SUPER_ADMIN ??
                        "Cannot delete the last SUPER_ADMIN.",
                    HTTP_STATUS.CONFLICT,
                    { type: "BusinessRuleError" },
                );
            }
        }

        await AdminModel.deleteAdmin(username);
        logger.info(adminMessages.ADMIN_DELETED(username));
        return { username };
    }

    // ─── Set active / inactive ───────────────────────────────────────────────

    static async setActive({ username, isActive }) {
        const existing = await AdminManagementService._fetchAndVerify(username);

        if (isActive === "N" && existing.ROLE === "SUPER_ADMIN") {
            const others = await AdminModel.countActiveByRole(
                "SUPER_ADMIN",
                username,
            );
            if (others === 0) {
                throw new AppError(
                    ADMIN_ERRORS.LAST_SUPER_ADMIN ??
                        "Cannot deactivate the last SUPER_ADMIN.",
                    HTTP_STATUS.CONFLICT,
                    { type: "BusinessRuleError" },
                );
            }
        }

        const sysSignature = await CryptoVault.signRecord(
            AdminModel.SIGN_CONTEXT,
            AdminModel.buildSignedFields({ ...existing, IS_ACTIVE: isActive }),
        );

        await AdminModel.setActive(username, isActive, sysSignature);
        logger.info(adminMessages.ADMIN_UPDATED(username));
        return { username, isActive };
    }

    // ─── Private helpers ─────────────────────────────────────────────────────

    static async _fetchAndVerify(username) {
        const existing = await AdminModel.findByUsername(username);
        if (!existing) {
            logger.warning(adminMessages.ADMIN_NOT_FOUND(username));
            throw new AppError(
                ADMIN_ERRORS.ADMIN_NOT_FOUND,
                HTTP_STATUS.NOT_FOUND,
                { type: "NotFoundError" },
            );
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

    // ─── Role validation (I1) ────────────────────────────────────────────────

    /**
     * Validates that the given role is in the canonical VALID_ROLES set.
     * Throws 400 if the role is unknown — prevents invalid data from reaching
     * the database.
     *
     * @param {string} role
     * @throws {AppError} 400 if role is not in VALID_ROLES
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
                            issue: `Invalid role "${role}". Allowed: ${VALID_ROLES.join(", ")}.`,
                        },
                    ],
                },
            );
        }
    }

    // ─── Default password guard (I1) ──────────────────────────────────────────

    /**
     * Rejects a password that matches the system default password.
     * Prevents admins from setting (or keeping) the default password as their
     * actual password — a CWE-1393 (use of default credentials) mitigation.
     *
     * @param {string} password
     * @throws {AppError} 400 if password equals ADMIN_DEFAULT_PASSWORD
     */
    static _rejectDefaultPassword(password) {
        const defaultPw = process.env.ADMIN_DEFAULT_PASSWORD;
        if (defaultPw && password === defaultPw) {
            throw new AppError(
                ADMIN_ERRORS.DEFAULT_PASSWORD_FORBIDDEN,
                HTTP_STATUS.BAD_REQUEST,
                {
                    type: "ValidationError",
                    details: [
                        {
                            field: "password",
                            issue: "The new password cannot be the same as the system default password.",
                        },
                    ],
                },
            );
        }
    }

    /** @deprecated — kept for backward compatibility; template has no flags. */
    static _validateFlags(flags) {
        const ALLOWED_FLAG_KEYS = [
            "canApproveReset",
            "canRejectReset",
            "canApproveBilling",
            "canRejectBilling",
            "canReceiveBilling",
            "canExportBilling",
            "isActive",
        ];
        const invalidKeys = Object.keys(flags).filter(
            (k) => !ALLOWED_FLAG_KEYS.includes(k),
        );
        if (invalidKeys.length > 0) {
            throw new AppError(
                VALIDATION_ERRORS.INVALID_INPUT,
                HTTP_STATUS.BAD_REQUEST,
                {
                    type: "ValidationError",
                    details: invalidKeys.map((k) => ({
                        field: k,
                        issue: `Unknown permission flag: "${k}".`,
                    })),
                },
            );
        }
        const invalidValues = Object.entries(flags).filter(
            ([, v]) => v !== "Y" && v !== "N",
        );
        if (invalidValues.length > 0) {
            throw new AppError(
                VALIDATION_ERRORS.INVALID_INPUT,
                HTTP_STATUS.BAD_REQUEST,
                {
                    type: "ValidationError",
                    details: invalidValues.map(([k]) => ({
                        field: k,
                        issue: `Flag "${k}" must be 'Y' or 'N'.`,
                    })),
                },
            );
        }
    }
}

module.exports = AdminManagementService;
