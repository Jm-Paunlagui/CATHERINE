"use strict";

/**
 * System-map routes — Support → Architecture and Support → Runtime.
 *
 *   GET /api/v1/architecture          the whole-system map (nodes, edges, flows, layout)
 *   GET /api/v1/architecture/runtime  the server-runtime map (scheduling, backup, shutdown …)
 *
 * ACCESS — SUPER_ADMIN ONLY, AND THIS ROUTER IS WHERE THAT IS TRUE
 * ───────────────────────────────────────────────────────────────
 * The maps list every endpoint, table, signing step, permission predicate and
 * failure threshold in the system. Narrower than Dev Docs (which also admits ADMIN) by
 * design. The hidden nav item and the client route guard are conveniences;
 * `requireSuperAdmin` below is the control. Do not swap in
 * `requireAdminAccess` from elsewhere.
 *
 * No cache middleware: the service already holds the built map in memory,
 * and a shared cache entry is the easiest way to leak a role-gated body.
 * No rate limiter beyond the global one: the response is an in-memory object.
 */

const express = require("express");

const AuthMiddleware = require("../middleware/authentication/AuthMiddleware");
const ArchitectureController = require("../controllers/ArchitectureController");

const router = express.Router();

const requireSuperAdmin = AuthMiddleware.requireAccess((user) => user.role === "SUPER_ADMIN", {
    message: "Access denied: SUPER_ADMIN role required.",
});

// Applied with `use` so a route added later cannot skip the guards.
router.use(AuthMiddleware.authenticate);
router.use(requireSuperAdmin);

router.get("/", ArchitectureController.getMap);
router.get("/runtime", ArchitectureController.getRuntimeMap);

module.exports = router;
