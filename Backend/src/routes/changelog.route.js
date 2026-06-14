"use strict";

/**
 * Changelog routes
 *
 *   GET    /api/v1/changelog                  list (all authenticated roles)
 *   POST   /api/v1/changelog                  create (SUPER_ADMIN only)
 *   PUT    /api/v1/changelog/:id              update (SUPER_ADMIN only)
 *   DELETE /api/v1/changelog/:id              delete (SUPER_ADMIN only)
 *
 *   Release train (SUPER_ADMIN only):
 *   GET    /api/v1/changelog/release/current  derived state + form drafts
 *
 *   Transitions are NOT written here — the UI seeds the create form from the
 *   drafts and saves via POST /api/v1/changelog (single write path).
 */

const express = require("express");

const AuthMiddleware        = require("../middleware/authentication/AuthMiddleware");
const ChangelogController   = require("../controllers/ChangelogController");
const ReleaseController     = require("../controllers/ReleaseController");

const router = express.Router();

// SUPER_ADMIN guard reused across every mutating + release route.
const requireSuperAdmin = AuthMiddleware.requireAccess(
    (user) => user.role === "SUPER_ADMIN",
);

// ── Read — all authenticated roles ───────────────────────────────────────────
router.get(
    "/",
    AuthMiddleware.authenticate,
    ChangelogController.list,
);

// ── Release train (read-only) — SUPER_ADMIN only ──────────────────────────────
// Declared before the "/:id" routes so the literal "/release/*" path is never
// shadowed by the parameterised matcher.
router.get(
    "/release/current",
    AuthMiddleware.authenticate,
    requireSuperAdmin,
    ReleaseController.current,
);

// ── Mutate — SUPER_ADMIN only ─────────────────────────────────────────────────
router.post(
    "/",
    AuthMiddleware.authenticate,
    requireSuperAdmin,
    ChangelogController.create,
);

router.put(
    "/:id",
    AuthMiddleware.authenticate,
    requireSuperAdmin,
    ChangelogController.update,
);

router.delete(
    "/:id",
    AuthMiddleware.authenticate,
    requireSuperAdmin,
    ChangelogController.delete,
);

module.exports = router;
