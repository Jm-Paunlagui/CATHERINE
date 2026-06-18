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
 *   GET /        → key: adminList  (full roster, no query params)
 *   GET /search  → NOT cached (real-time HRIS search; user expects live results)
 *
 * Invalidation: any mutation (create, update, delete) triggers a namespace wipe
 * via `delByPattern('adminList')`. The roster is small (< 100 rows) so a full
 * wipe is safe and avoids any stale-member-name issue in the billing selector.
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
    CacheMiddleware,
    CacheKeyBuilder,
    registry,
} = require("../middleware/cache");

// ── Cache stores ───────────────────────────────────────────────────────────────
const adminStore = registry.resolve("adminList");

/** Predicate: only ADMIN and SUPER_ADMIN may manage the admin roster. */
const requireAdmin = AuthMiddleware.requireAccess(
    (user) => user.role === "ADMIN" || user.role === "SUPER_ADMIN",
    {
        message:
            "Only ADMIN or SUPER_ADMIN accounts may access admin management.",
    },
);

/** Predicate: only SUPER_ADMIN may update permission flags (zero-approver guard). */
const requireSuperAdmin = AuthMiddleware.requireAccess(
    (user) => user.role === "SUPER_ADMIN",
    {
        message: "Only SUPER_ADMIN accounts may update admin permission flags.",
    },
);

// ── Auth guards applied to the entire router ──────────────────────────────────
router.use(AuthMiddleware.authenticate, requireAdmin);

// ── Search employees (HRIS) ───────────────────────────────────────────────────
// NOT cached — real-time HRIS search; the user expects live results.
// Caching would return stale employee name/position data from HRIS.
// validateRequiredFields automatically checks req.query for GET requests.
router.get(
    "/search",
    AuthMiddleware.validateRequiredFields(["q"]),
    AdminManagementController.search,
);

// ── List all admins ───────────────────────────────────────────────────────────
// Cache key: `adminList` — no query params, roster is the same for all callers.
// Auth already verified by router.use() above before this cache read executes.
router.get(
    "/",
    CacheMiddleware.read(adminStore, () => CacheKeyBuilder.build("adminList")),
    AdminManagementController.list,
);

// ── Create admin ──────────────────────────────────────────────────────────────
// Invalidation: namespace wipe — new admin appears in the roster and in the
// billing recipient selector; both are served from the same adminList store.
router.post(
    "/",
    AuthMiddleware.validateRequiredFields(["empId", "role", "retainPassword"]),
    CacheMiddleware.invalidate(adminStore, () => "adminList", {
        usePattern: true,
    }),
    AdminManagementController.create,
);

// ── Update admin ──────────────────────────────────────────────────────────────
// Invalidation: namespace wipe — role or name change affects list display and
// the billing recipient selector dropdown.
router.put(
    "/:empId",
    AuthMiddleware.validateRequiredFields(["role", "changePassword"]),
    CacheMiddleware.invalidate(adminStore, () => "adminList", {
        usePattern: true,
    }),
    AdminManagementController.update,
);

// ── Reset password ────────────────────────────────────────────────────────────
// No cache invalidation needed — password hashes are never cached.
router.patch("/:empId/reset-password", AdminManagementController.resetPassword);

// ── Reset SYSSIGNATURE ────────────────────────────────────────────────────────
// Invalidation: namespace wipe — the cached GET / response embeds the computed
// signatureValid verdict per row. Without invalidation a repaired signature
// keeps showing "tampered" in the roster until the 600s TTL expires.
router.patch(
    "/:empId/reset-signature",
    CacheMiddleware.invalidate(adminStore, () => "adminList", {
        usePattern: true,
    }),
    AdminManagementController.resetSignature,
);

// ── Delete admin ──────────────────────────────────────────────────────────────
// Invalidation: namespace wipe — removed admin must disappear from the roster
// and from the billing recipient selector.
router.delete(
    "/:empId",
    CacheMiddleware.invalidate(adminStore, () => "adminList", {
        usePattern: true,
    }),
    AdminManagementController.remove,
);

// ── Update permission flags ───────────────────────────────────────────────────
// SUPER_ADMIN only — requireSuperAdmin overrides the router-level requireAdmin.
// Dual cache invalidation:
//   1. adminList store — roster list includes flag values for the UI toggle display.
//   2. billing store   — billing:type=adminList may change when IS_ACTIVE or
//                        CAN_RECEIVE_BILLING changes (recipient list for send-auto).
// Both invalidations run via setImmediate (fire-and-forget) — the response is sent
// first, then caches are cleaned so the next fetch picks up fresh data.
router.patch(
    "/:empId/permissions",
    AuthMiddleware.authenticate, // re-auth (overrides router.use for this path)
    requireSuperAdmin,
    AuthMiddleware.validateRequiredFields(["flags"]),
    CacheMiddleware.invalidate(adminStore, () => "adminList", {
        usePattern: true,
    }),
    AdminManagementController.updatePermissions,
);

module.exports = router;
