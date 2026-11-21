"use strict";

/**
 * Dev-docs routes — the in-app developer documentation viewer.
 *
 *   GET /api/v1/dev-docs/tree          section index + per-document metadata
 *   GET /api/v1/dev-docs/doc/:id       one document's raw markdown
 *   GET /api/v1/dev-docs/search?q=     literal substring search
 *
 * ACCESS — ADMIN / SUPER_ADMIN ONLY, AND THIS ROUTER IS WHERE THAT IS TRUE
 * ───────────────────────────────────────────────────────────────────────
 * The corpus documents HMAC signing, integrity-gate failure conditions,
 * the backup/restore design and the auth predicates. It is an internal
 * architecture map of the system.
 *
 * `requireAdminAccess` below is the ONLY control. Hiding the tab in the UI and
 * guarding the client route are conveniences — both are client-side and
 * neither survives someone calling the endpoint directly. Any review that
 * accepts "the tab is hidden" as the access control has accepted nothing.
 *
 * The corollary lives in DevDocsService: the corpus is served from here and is
 * NEVER copied into the frontend bundle or a static directory, because a
 * static asset has no gate to pass.
 *
 * NO CACHE MIDDLEWARE ON THIS ROUTER, DELIBERATELY
 * ────────────────────────────────────────────────
 * The simplest mistake available here is a shared cache entry holding an
 * admin-only body. The manifest is already cached inside DevDocsService with
 * its own TTL, which is where the expensive work actually is (one stat per
 * document plus git spawns). The
 * responses themselves are sent `private, no-store` by the controller.
 *
 * Rate limiting: search only. It scans 1.3 MB per call, so an authenticated
 * admin looping it is a cheap self-inflicted DoS. The tree is served from a
 * cached manifest and a single document read is one file.
 */

const express = require("express");

const AuthMiddleware = require("../middleware/authentication/AuthMiddleware");
const DevDocsController = require("../controllers/DevDocsController");
const { RateLimiterMiddleware } = require("../middleware/security/RateLimiterMiddleware");

const router = express.Router();

/**
 * ADMIN + SUPER_ADMIN only — USER is excluded.
 */
const requireAdminAccess = AuthMiddleware.requireAccess(
    (user) => user.role === "ADMIN" || user.role === "SUPER_ADMIN",
    { message: "Access denied: ADMIN or SUPER_ADMIN role required." },
);

/**
 * Search is the only endpoint that scans the corpus per call. 30/min is far
 * above what a person typing into a debounced box produces and far below what
 * a loop would.
 */
const searchLimiter = new RateLimiterMiddleware({
    max: 30,
    windowMs: 60_000,
    label: "RateLimit:dev-docs-search",
});

// Authentication first, then the role predicate — applied to EVERY route on
// this router via `use`, so a route added later cannot be published
// unprotected by forgetting to repeat the guards.
router.use(AuthMiddleware.authenticate);
router.use(requireAdminAccess);

// ── Reads ────────────────────────────────────────────────────────────────────

// Literal paths before the param route, so "search" and "tree" can never be
// captured as a document id (Express v5 matches in declaration order).
router.get("/tree", DevDocsController.getTree);

router.get("/search", searchLimiter.handle, DevDocsController.search);

// Two segments, not one free-form `:id`. Express v5's path-to-regexp no longer
// accepts an inline pattern on a param, and a single `:id` would not match a
// value containing "/" anyway — so the id's own shape (section/name) becomes
// the route's shape, and the controller rejoins them.
//
// This is a cheap second gate, not the traversal defence. The defence is that
// the rejoined value is a MANIFEST KEY: an unknown key is a 404 before any
// filesystem call. See DevDocsService.
router.get("/doc/:section/:name", DevDocsController.getDoc);

module.exports = router;
