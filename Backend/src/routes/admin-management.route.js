"use strict";

/**
 * @fileoverview Admin Management routes.
 *
 * All routes require:
 *   1. AuthMiddleware.authenticate   — valid JWT in HTTP-only cookie
 *   2. AuthMiddleware.requireAccess  — caller must be ADMIN or SUPER_ADMIN
 *
 * Cache strategy
 * ──────────────
 * Store: `adminList` (TTL 600s, maxKeys 50)
 *
 *   GET /        → key: adminList  (full admin list, no query params)
 *
 * Invalidation: any mutation triggers a namespace wipe via
 * `delByPattern('adminList')`. The admin list is small (< 100 rows) so a full
 * wipe is safe.
 *
 * Positional rationale: authentication and access check run first via router.use()
 * to satisfy CWE-639 (auth before cache read — never serve cached data without a
 * valid session). Cache read runs after auth, before the controller. Invalidation
 * installs its res.json patch before the controller so it intercepts the response
 * and fires cleanup via setImmediate without blocking the reply.
 * Validation middleware sits immediately before invalidation/controller so it
 * rejects bad input before any business logic executes.
 */

const express = require("express");
const router = express.Router();

const AdminManagementController = require("../controllers/AdminManagementController");
const AuthMiddleware = require("../middleware/authentication/AuthMiddleware");
const {
    credentialEmailRateLimiter,
} = require("../middleware/security/RateLimiterMiddleware");
const {
    CacheMiddleware,
    CacheKeyBuilder,
    registry,
} = require("../middleware/cache");

// ── Cache stores ───────────────────────────────────────────────────────────────
const adminStore = registry.resolve("adminList");

/** Predicate: only ADMIN and SUPER_ADMIN may manage admin accounts. */
const requireAdmin = AuthMiddleware.requireAccess(
    (user) => user.role === "ADMIN" || user.role === "SUPER_ADMIN",
    {
        message:
            "Only ADMIN or SUPER_ADMIN accounts may access admin management.",
    },
);

/**
 * Predicate: SUPER_ADMIN only — permission flags, role changes, reset-signature,
 * revoke, delete and unblock-ip. Create and Reset Password stay on the
 * router-level requireAdmin because an ADMIN may act on USER accounts; the
 * per-target decision for those is AdminManagementService._assertCanManage.
 */
const requireSuperAdmin = AuthMiddleware.requireAccess(
    (user) => user.role === "SUPER_ADMIN",
    {
        message: "Only a Super Admin can do this.",
    },
);

// ── Auth guards applied to the entire router ──────────────────────────────────
// Every route below already runs authenticate + requireAdmin; per-route
// requireSuperAdmin only narrows the role. Do NOT repeat authenticate per
// route — it would verify the JWT twice and cannot "override" router.use.
router.use(AuthMiddleware.authenticate, requireAdmin);

// ── Search accounts ─────────────────────────────────────────────────────────────────────
// NOT cached — the user expects live results while granting access.
// validateRequiredFields automatically checks req.query for GET requests.
router.get(
    "/search",
    AuthMiddleware.validateRequiredFields(["q"]),
    AdminManagementController.search,
);

// ── List all admins ───────────────────────────────────────────────────────────
// Cache key: `adminList` — no query params, the list is the same for all callers.
// Auth already verified by router.use() above before this cache read executes.
router.get(
    "/",
    CacheMiddleware.read(adminStore, () => CacheKeyBuilder.build("adminList")),
    AdminManagementController.list,
);

// ── Create admin ──────────────────────────────────────────────────────────────
// Invalidation: namespace wipe — the new admin appears in the list.
// The password is server-generated and emailed; `retainPassword` /
// `newPassword` are refused by the service.
router.post(
    "/",
    AuthMiddleware.validateRequiredFields(["username", "role"]),
    CacheMiddleware.invalidate(adminStore, () => "adminList", {
        usePattern: true,
    }),
    AdminManagementController.create,
);

// ── Update admin ──────────────────────────────────────────────────────────────
// Invalidation: namespace wipe — a role change affects the list display.
// A role change never involves the password: `changePassword` is OPTIONAL and
// the service refuses `true` (Edit never sets a password).
// Role changes are SUPER_ADMIN only — gated here AND in
// AdminManagementService._assertCanManage.
router.put(
    "/:username",
    requireSuperAdmin,
    AuthMiddleware.validateRequiredFields(["role"]),
    CacheMiddleware.invalidate(adminStore, () => "adminList", {
        usePattern: true,
    }),
    AdminManagementController.update,
);

// ── Reset password ────────────────────────────────────────────────────────────
// Emails a new temporary password — a credential — so it has its own strict
// limiter (5/min per signed-in caller; runs after router.use's authenticate).
// Invalidation: the list shows each row's outstanding temporary-password expiry.
router.patch(
    "/:username/reset-password",
    credentialEmailRateLimiter.handle,
    CacheMiddleware.invalidate(adminStore, () => "adminList", {
        usePattern: true,
    }),
    AdminManagementController.resetPassword,
);

// ── Reset SYSSIGNATURE ────────────────────────────────────────────────────────
// Invalidation: namespace wipe — the cached GET / response embeds the computed
// signatureValid verdict per row. Without invalidation a repaired signature
// keeps showing "tampered" in the list until the 600s TTL expires.
// Re-signing erases tamper evidence — SUPER_ADMIN only (route + service).
router.patch(
    "/:username/reset-signature",
    requireSuperAdmin,
    CacheMiddleware.invalidate(adminStore, () => "adminList", {
        usePattern: true,
    }),
    AdminManagementController.resetSignature,
);

// ── Delete admin ──────────────────────────────────────────────────────────────
// SUPER_ADMIN only — a hard delete is at least as sensitive as a
// permission-flag change. Body: { backupToken } — required, issued by
// /revoke-backup and verified the same way as the Data Purge backup token.
router.delete(
    "/:username",
    requireSuperAdmin,
    AuthMiddleware.validateRequiredFields(["backupToken"]),
    CacheMiddleware.invalidate(adminStore, () => "adminList", {
        usePattern: true,
    }),
    AdminManagementController.remove,
);

// ── Access Control revoke — backup (streams zip + backup token) ────────────────
// POST /api/v1/admin-management/:username/revoke-backup
// SUPER_ADMIN only. Streams an ENTITY-kind archive scoped to one admin — no
// cache read/invalidation, this is a read-only export.
router.post(
    "/:username/revoke-backup",
    requireSuperAdmin,
    AdminManagementController.revokeBackup,
);

// ── Access Control revoke — deactivate ──────────────────────────────────────────
// POST /api/v1/admin-management/:username/revoke
// SUPER_ADMIN only. Body: { backupToken } — required. The default,
// non-destructive way access is removed.
router.post(
    "/:username/revoke",
    requireSuperAdmin,
    AuthMiddleware.validateRequiredFields(["backupToken"]),
    CacheMiddleware.invalidate(adminStore, () => "adminList", {
        usePattern: true,
    }),
    AdminManagementController.revoke,
);

// ── Clear a SecurityFilter suspicious-IP block ────────────────────────────────
// POST /api/v1/admin-management/security/unblock-ip
// SUPER_ADMIN only. Body: { ip }.
//
// SecurityFilter blocks an IP in memory once it trips the suspicious
// threshold; this lifts the block without a restart. No cache invalidation —
// the block lives in middleware memory, not in any cache store or table.
router.post(
    "/security/unblock-ip",
    requireSuperAdmin,
    AuthMiddleware.validateRequiredFields(["ip"]),
    AdminManagementController.unblockIp,
);

// ── Update permission flags ───────────────────────────────────────────────────
// SUPER_ADMIN only — requireSuperAdmin narrows (runs after) the router-level
// authenticate + requireAdmin; it does not replace them.
// Invalidation: the list includes flag values for the UI toggle display.
router.patch(
    "/:username/permissions",
    requireSuperAdmin,
    // flags is a validated object (service allow-lists keys + restricts values to Y/N)
    AuthMiddleware.validateRequiredFields(["flags"], { stringOnly: false }),
    CacheMiddleware.invalidate(adminStore, () => "adminList", {
        usePattern: true,
    }),
    AdminManagementController.updatePermissions,
);

module.exports = router;
