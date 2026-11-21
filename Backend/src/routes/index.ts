"use strict";

const express = require("express");
const router = express.Router();

// ─── Route modules ────────────────────────────────────────────────────────────

const healthRoutes = require("./health.route");
const csrfRoutes = require("./csrf.route");
const authRoutes = require("./auth.route");
const adminManagementRoutes = require("./admin-management.route");
const auditLogRoutes           = require("./audit-log.route");
const metricsRoutes            = require("./metrics.route");
const clientRoutes             = require("./client.route");
const changelogRoutes          = require("./changelog.route");
const devDocsRoutes            = require("./dev-docs.route");
const architectureRoutes       = require("./architecture.route");
const integrityRoutes          = require("./integrity.route");
const dataPurgeRoutes          = require("./data-purge.route");

// ─── Mount routes ─────────────────────────────────────────────────────────────

// Health check — mounted at /health so the paths are:
//   GET /api/v1/health         legacy combined check
//   GET /api/v1/health/live    liveness probe
//   GET /api/v1/health/ready   readiness probe
//   GET /api/v1/health/stream  readiness push (SSE), unauthenticated like /ready
router.use("/health", healthRoutes);

// CSRF routes
router.use("/csrf", csrfRoutes);

// Auth routes
router.use("/auth", authRoutes);

// Admin Management routes
router.use("/admin-management", adminManagementRoutes);

// Project feature routes mount here.

// Audit Log routes
router.use("/audit-logs", auditLogRoutes);

// Metrics routes (observability)
router.use("/metrics", metricsRoutes);

// Client-side error ingestion (ErrorBoundary reports)
router.use("/client", clientRoutes);

// Changelog / Version History
router.use("/changelog", changelogRoutes);

// Developer documentation viewer — ADMIN / SUPER_ADMIN only. The router applies
// authenticate + requireAdminAccess via `use`, so every route on it is gated;
// see dev-docs.route.js for why that gate is the only real control.
router.use("/dev-docs", devDocsRoutes);

// Architecture map — SUPER_ADMIN only. authenticate + requireSuperAdmin are
// applied via `use` inside the router; see architecture.route.js.
router.use("/architecture", architectureRoutes);

// Integrity Center (SUPER_ADMIN only — per-table tamper monitoring + live SSE)
router.use("/integrity", integrityRoutes);

// Data Purge & Restore (SUPER_ADMIN only — bulk group/table purge with mandatory pre-purge backup)
router.use("/data-purge", dataPurgeRoutes);

module.exports = router;
