

import express from "express";
const router = express.Router();

// ─── Route modules ────────────────────────────────────────────────────────────

import healthRoutes from "./health.route";
import csrfRoutes from "./csrf.route";
import authRoutes from "./auth.route";
import adminManagementRoutes from "./admin-management.route";
import auditLogRoutes from "./audit-log.route";
import metricsRoutes from "./metrics.route";
import clientRoutes from "./client.route";
import changelogRoutes from "./changelog.route";
import devDocsRoutes from "./dev-docs.route";
import architectureRoutes from "./architecture.route";
import integrityRoutes from "./integrity.route";
import dataPurgeRoutes from "./data-purge.route";

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

export default router;
