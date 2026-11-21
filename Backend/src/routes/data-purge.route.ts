"use strict";

/**
 * @fileoverview Data Purge & Restore routes (SUPER_ADMIN only).
 *
 * All routes require:
 *   1. AuthMiddleware.authenticate  — valid JWT in HTTP-only cookie
 *   2. requireSuperAdmin            — caller must be SUPER_ADMIN
 *
 * Cache strategy
 * ──────────────
 * No cache store is registered for this feature. `GET /scopes` and
 * `POST /preview` are deliberately UNCACHED — an operator
 * making a destructive-purge decision must always see current data, never
 * a stale cache-aside snapshot. `POST /backup` streams a binary archive and
 * `POST /execute` is mutating; neither was ever a cache candidate.
 *
 * Rate limiting
 * ─────────────
 * A dedicated strict `RateLimiterMiddleware` instance (default `max: 5`
 * per 15-minute window, overridable via `PURGE_RATE_LIMIT_MAX`) guards
 * `POST /execute` AND `POST /restore` — both are destructive, low-frequency
 * operations that must never be reachable at the default global rate limit.
 * `POST /restore/preview` is read-only (like `POST /preview`)
 * and is NOT rate-limited beyond the router's default.
 *
 * Multer (`POST /restore/preview` and `POST /restore`)
 * ──────────────────────────────────────────────────────
 * In-memory storage, `.zip`-only MIME/extension filter, size-capped via
 * `BACKUP_UPLOAD_MAX_MB` (default 100) — the same multer shape as the
 * Excel upload routes, just with a different extension/cap. Runs
 * AFTER auth (never parse an untrusted file from an unauthenticated
 * request) and, on `/restore`, BEFORE `validateRequiredFields` (multer must
 * parse the multipart body before `adminPassword`/`confirmPhrase` exist on
 * `req.body`).
 *
 * Positional rationale: authentication + the SUPER_ADMIN access check run
 * first via `router.use()` (CWE-639 — never process a request without a
 * verified session). The rate limiter sits before multer/`validateRequiredFields`
 * on `/execute` and `/restore` so a flood of malformed requests is
 * throttled before any parsing or validation work runs.
 * `validateRequiredFields` sits immediately before the controller so
 * malformed input is rejected before any business logic.
 */

const express = require("express");
const router = express.Router();
const multer = require("multer");
const { MULTIPART_FIELD_LIMITS } = require("../constants/multipart");

const DataPurgeController = require("../controllers/DataPurgeController");
const AuthMiddleware = require("../middleware/authentication/AuthMiddleware");
const {
    RateLimiterMiddleware,
} = require("../middleware/security/RateLimiterMiddleware");
const { AppError, PURGE_ERRORS } = require("../constants/errors");
const { HTTP_STATUS } = require("../constants");
const {
    TraceabilityMiddleware,
} = require("../middleware/traceability/TraceabilityMiddleware");

// ── Access predicate ──────────────────────────────────────────────────────────

/** Only SUPER_ADMIN may purge or restore platform data. */
const requireSuperAdmin = AuthMiddleware.requireAccess(
    (user) => user.role === "SUPER_ADMIN",
    {
        message:
            "Only SUPER_ADMIN accounts may purge or restore platform data.",
    },
);

// ── Strict rate limiter for /execute and /restore ─────────────────
const executeRateLimiter = new RateLimiterMiddleware({
    /* c8 ignore next -- both the env-parsed value and the `|| 5` default are
       load-time config, evaluated exactly once when this module is first
       required; a test cannot exercise the other arm after load. */
    max: parseInt(process.env.PURGE_RATE_LIMIT_MAX, 10) || 5,
    windowMs: 900000, // 15 minutes
    label: "RateLimit:data-purge-execute",
});

// ── Multer — in-memory, size-capped via BACKUP_UPLOAD_MAX_MB, .zip only ─────────
const restoreUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        ...MULTIPART_FIELD_LIMITS,
        /* c8 ignore next 3 -- load-time config: the `|| 100` MB default vs the
           env-parsed value is resolved once at require time and is not
           togglable within a running test process. */
        fileSize:
            (parseInt(process.env.BACKUP_UPLOAD_MAX_MB, 10) || 100) *
            1024 *
            1024,
    },
    fileFilter(_req, file, cb) {
        const isZip =
            file.mimetype === "application/zip" ||
            file.mimetype === "application/x-zip-compressed" ||
            file.originalname?.toLowerCase().endsWith(".zip");

        if (!isZip) {
            return cb(
                new AppError(
                    PURGE_ERRORS.RESTORE_INVALID_FILE_TYPE,
                    HTTP_STATUS.BAD_REQUEST,
                    {
                        type: "ValidationError",
                        details: [
                            {
                                field: "file",
                                issue: "Only .zip files are accepted.",
                            },
                        ],
                    },
                ),
            );
        }
        cb(null, true);
    },
});

// ── Auth guard applied to the entire router ───────────────────────────────────
router.use(AuthMiddleware.authenticate, requireSuperAdmin);

// ── Scope catalogue ────────────────────────────────────────────────────────────
// GET /api/v1/data-purge/scopes
// Group catalogue + live row counts for every table registered in
// constants/purgeTables.js (protected tables are listed but never purgeable).
// Not cached.
router.get("/scopes", DataPurgeController.getScopes);

// ── Preview (read-only) ─────────────────────────────────────────────────────────
// POST /api/v1/data-purge/preview
// Body: { groups?: string[], tables?: string[] }
// "At least one of groups/tables" is validated inside DataPurgeService.
// ResolveScope (a plain validateRequiredFields check can't express an
// either/or requirement) — never writes anything regardless.
router.post("/preview", DataPurgeController.preview);

// ── Backup (streams the .zip, issues the backup token) ──────────────────────────
// POST /api/v1/data-purge/backup
// Body: { groups?: string[], tables?: string[] }
// Response: binary application/zip body; X-Backup-Token / X-Backup-Token-
// Expires-At / X-Confirm-Phrase response headers (see CorsMiddleware's
// exposedHeaders).
router.post("/backup", DataPurgeController.backup);

// ── Authorise (credential pre-check for the stepper's step 3) ───────────────────
// POST /api/v1/data-purge/authorise
// Verifies the caller's admin password so a wrong one is caught at the
// "Authorise" step instead of at /execute, after the operator has already typed
// the confirm phrase.
//
// Grants nothing: no token is issued and no state changes, so passing this is
// neither necessary nor sufficient for /execute (which re-verifies the password,
// the backup token and the confirm phrase independently). It is nonetheless a
// credential-checking endpoint, so it carries the SAME strict rate limiter as
// /execute — the surface is limited to an already-authenticated SUPER_ADMIN, but
// an unthrottled password check is a brute-force oracle regardless of who holds it.
router.post(
    "/authorise",
    executeRateLimiter.handle,
    AuthMiddleware.validateRequiredFields(["adminPassword"]),
    AuthMiddleware.validatePasswordFields({ verify: ["adminPassword"] }),
    DataPurgeController.authorise,
);

// ── Execute (the purge itself) ───────────────────────────────────────────────────
// POST /api/v1/data-purge/execute
// Body: { scope: { groups?, tables? }, backupToken, adminPassword, confirmPhrase, acknowledgeLockout? }
// acknowledgeLockout is intentionally NOT in the required-fields list — it
// is only required when the resolved scope includes T_ADMINS_DEV,
// which DataPurgeService.executePurge checks itself.
router.post(
    "/execute",
    executeRateLimiter.handle,
    AuthMiddleware.validateRequiredFields(
        ["scope", "backupToken", "adminPassword", "confirmPhrase"],
        {
            stringOnly: false,
        },
    ),
    AuthMiddleware.validatePasswordFields({ verify: ["adminPassword"] }),
    DataPurgeController.execute,
);

// ── Restore preview (read-only) ──────────────────────────────────────────────────
// POST /api/v1/data-purge/restore/preview
// Multipart form field "file" — a .zip backup archive. Verifies the
// signature + runs the full pre-flight. Never writes anything.
router.post(
    "/restore/preview",
    restoreUpload.single("file"),
    // Multer's busboy callbacks escape AsyncLocalStorage — restore the request
    // context (and with it the watchdog scope) for everything downstream.
    TraceabilityMiddleware.restoreContext,
    DataPurgeController.restorePreview,
);

// ── Restore (the restore itself) ─────────────────────────────────────────────────
// POST /api/v1/data-purge/restore
// Multipart form field "file" — a plain .zip backup archive (multer refuses
// anything else) — plus body fields { adminPassword, confirmPhrase }. Same
// strict rate limiter as /execute.
router.post(
    "/restore",
    executeRateLimiter.handle,
    restoreUpload.single("file"),
    TraceabilityMiddleware.restoreContext,
    AuthMiddleware.validateRequiredFields(["adminPassword", "confirmPhrase"], {
        stringOnly: true,
    }),
    AuthMiddleware.validatePasswordFields({ verify: ["adminPassword"] }),
    DataPurgeController.restore,
);

// ══════════════════════════════════════════════════════════════════════════════
// Backup tab routes
// All SUPER_ADMIN — inherits the router.use() auth guard above.
// ══════════════════════════════════════════════════════════════════════════════

// ── List all backup archives ─────────────────────────────────────────────────
// GET /api/v1/data-purge/backups
// Returns the on-disk index (chain health, disk usage, per-archive metadata).
router.get("/backups", DataPurgeController.listBackups);

// ── Manual backup ("Back Up Now") ────────────────────────────────────────────
// POST /api/v1/data-purge/backups/run
// Triggers a manual full-DB backup to disk. Same strict rate limiter as
// /execute — this is a heavy I/O operation that must never be spammed.
router.post(
    "/backups/run",
    executeRateLimiter.handle,
    DataPurgeController.runManualBackup,
);

// ── Download a materialised self-contained FULL zip ──────────────────────────
// GET /api/v1/data-purge/backups/:id/download
// Resolves the chain (if incremental) and streams a self-contained FULL zip.
router.get("/backups/:id/download", DataPurgeController.downloadBackup);

// ── Verify signature + chain integrity ───────────────────────────────────────
// POST /api/v1/data-purge/backups/:id/verify
// Read-only — re-verifies the archive's HMAC signature and checks that
// every chain member it depends on is present and signature-valid.
router.post("/backups/:id/verify", DataPurgeController.verifyBackup);

// ── Majority-vote delete ──────────────────
// POST /api/v1/data-purge/backups/:id/delete-request
// Initiates a delete request (casts the requester's own vote).
router.post(
    "/backups/:id/delete-request",
    executeRateLimiter.handle,
    DataPurgeController.requestDeleteBackup,
);

// POST /api/v1/data-purge/backups/:id/vote
// Casts an approval vote on an existing delete request.
router.post(
    "/backups/:id/vote",
    executeRateLimiter.handle,
    DataPurgeController.voteDeleteBackup,
);

// DELETE /api/v1/data-purge/backups/:id/delete-request
// Cancels a pending delete request (removes all votes).
router.delete(
    "/backups/:id/delete-request",
    executeRateLimiter.handle,
    DataPurgeController.cancelDeleteRequest,
);

module.exports = router;
