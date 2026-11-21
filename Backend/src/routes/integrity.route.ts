"use strict";

/**
 * @fileoverview Integrity Center routes (SUPER_ADMIN only).
 *
 * All routes require:
 *   1. AuthMiddleware.authenticate — valid JWT (HTTP-only cookie or Bearer)
 *   2. requireSuperAdmin           — caller role must be SUPER_ADMIN
 *
 * This feature exposes raw HMAC integrity data across every registered signed
 * table. SUPER_ADMIN-only is the least-privilege boundary for integrity
 * controls. The SSE stream relies on the same cookie auth EventSource sends
 * with withCredentials (CWE-287).
 *
 * Cache strategy
 * ──────────────
 * Store: `integrity` (TTL 180s).
 *   GET /tables         — NOT cached (static in-memory catalog; already O(1)).
 *   GET /:table/tamper  — NOT cached at HTTP; the SERVICE caches the sweep RESULT
 *                         (a tampered verdict must never be served stale as a 2xx
 *                         page beyond the sweep TTL; the Re-scan button busts it).
 *   GET /:table/browse  — NOT cached (live per-row verdicts).
 *   POST /:table/rescan — mutation (cache-busting); CSRF token required.
 *
 * Route order: static single-segment paths (/tables, /stream) are declared
 * before the two-segment /:table/* routes so Express v5 never matches
 * "tables" as a :table value.
 */

const express = require("express");

const router = express.Router();
const IntegrityController = require("../controllers/IntegrityController");
const IntegrityStreamController = require("../controllers/IntegrityStreamController");
const AuthMiddleware = require("../middleware/authentication/AuthMiddleware");

// ── Access predicate: SUPER_ADMIN only ────────────────────────────────────────
const requireSuperAdmin = AuthMiddleware.requireAccess(
    (user) => user.role === "SUPER_ADMIN",
    { message: "Only SUPER_ADMIN accounts may access integrity controls." },
);

// ── Auth guard for the entire router (CWE-639) ────────────────────────────────
router.use(AuthMiddleware.authenticate, requireSuperAdmin);

// ── Static routes (before /:table param routes) ───────────────────────────────

// GET /api/v1/integrity/tables — table catalog (no SQL surface).
router.get("/tables", IntegrityController.getTables);

// GET /api/v1/integrity/stream?table=<key> — SSE live-tail (tables registered `live: true`).
// NOT catchAsync — manages its own SSE lifecycle.
router.get("/stream", IntegrityStreamController.stream);

// ── Param routes ──────────────────────────────────────────────────────────────

// GET /api/v1/integrity/:table/tamper — headline tampered-only feed.
router.get("/:table/tamper", IntegrityController.getTamper);

// GET /api/v1/integrity/:table/filter-options — distinct enum dropdown options.
router.get("/:table/filter-options", IntegrityController.getFilterOptions);

// GET /api/v1/integrity/:table/browse — browse-all with per-row verdict.
router.get("/:table/browse", IntegrityController.browse);

// GET /api/v1/integrity/:table/export — whole scoped set for the Excel/CSV
// export (?mode=tamper|all). NOT cached: an export is always a fresh snapshot,
// never a cache-aside copy. Inherits the router-level SUPER_ADMIN guard.
router.get("/:table/export", IntegrityController.exportRows);

// POST /api/v1/integrity/:table/rescan — invalidate + re-sweep (CSRF required).
router.post("/:table/rescan", IntegrityController.rescan);

module.exports = router;
