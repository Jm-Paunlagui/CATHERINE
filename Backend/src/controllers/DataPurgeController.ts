"use strict";

/**
 * @fileoverview Data Purge, Backup & Restore HTTP controller (SUPER_ADMIN only).
 *
 * Thin HTTP layer — no business logic, no direct DB calls. All logic is
 * delegated to `DataPurgeService` / `DataRestoreService` /
 * `BackupStoreService`. Every method is `catchAsync`-wrapped.
 *
 * Endpoints:
 *   GET  /api/v1/data-purge/scopes              — getScopes
 *   POST /api/v1/data-purge/preview             — preview
 *   POST /api/v1/data-purge/backup              — backup (binary .zip response)
 *   POST /api/v1/data-purge/authorise           — authorise
 *   POST /api/v1/data-purge/execute             — execute
 *   POST /api/v1/data-purge/restore/preview     — restorePreview (multipart .zip, no writes)
 *   POST /api/v1/data-purge/restore             — restore (multipart .zip, performs the restore)
 *   GET  /api/v1/data-purge/backups             — listBackups
 *   POST /api/v1/data-purge/backups/run         — runManualBackup
 *   GET  /api/v1/data-purge/backups/:id/download — downloadBackup
 *   POST /api/v1/data-purge/backups/:id/verify  — verifyBackup
 *   POST /api/v1/data-purge/backups/:id/delete-request   — requestDeleteBackup
 *   POST /api/v1/data-purge/backups/:id/vote             — voteDeleteBackup
 *   DELETE /api/v1/data-purge/backups/:id/delete-request — cancelDeleteRequest
 */

const { HTTP_STATUS } = require("../constants");
const { AppError, PURGE_ERRORS } = require("../constants/errors");
const { sendSuccess, RESPONSE_MESSAGES } = require("../constants/responses");
const { logger } = require("../utils/logger");
const { dataBackupMessages } = require("../constants/messages");
const { catchAsync } = require("../utils/catchAsync");
const DataPurgeService = require("../services/DataPurgeService");
const DataRestoreService = require("../services/DataRestoreService");

/**
 * Numeric id of the authenticated admin (JWT `id` claim) — what backup
 * tokens, votes and audit rows record as the actor.
 *
 * @param {import('express').Request} req
 * @returns {number|string|undefined}
 * @private
 */
function _callerAdminId(req) {
    return req.user?.id ?? req.user?.userId;
}

class DataPurgeController {
    /**
     * GET /api/v1/data-purge/scopes
     * Group catalogue + live row counts for every registered table. Not cached.
     *
     * @param {import('express').Request}  req
     * @param {import('express').Response} res
     */
    static getScopes = catchAsync(async (req, res) => {
        const data = await DataPurgeService.getScopeCatalogue();
        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.PURGE_SCOPES_FETCHED, data),
        );
    });

    /**
     * POST /api/v1/data-purge/preview
     * Body: `{ groups?: string[], tables?: string[] }`
     * Read-only — resolves the FK closure, live per-table counts, fidelity
     * disclosures, and the exact confirm phrase the operator will need at
     * the Final Confirm step.
     *
     * @param {import('express').Request}  req
     * @param {import('express').Response} res
     */
    static preview = catchAsync(async (req, res) => {
        const { groups, tables } = req.body ?? {};
        const data = await DataPurgeService.getPreview({ groups, tables });
        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.PURGE_PREVIEW_FETCHED, data),
        );
    });

    /**
     * POST /api/v1/data-purge/authorise
     * Body: `{ adminPassword: string }`
     *
     * Credential pre-check for the stepper's "Authorise" step, so a wrong
     * password surfaces there rather than at `/execute` after the operator has
     * already typed the confirm phrase.
     *
     * Grants nothing — issues no token and mutates no state. `/execute` still
     * re-verifies the password, the backup token and the confirm phrase
     * independently, so this endpoint is neither necessary nor sufficient for
     * a purge.
     */
    static authorise = catchAsync(async (req, res) => {
        const { adminPassword } = req.body ?? {};
        const data = await DataPurgeService.authorise({
            adminId: _callerAdminId(req),
            adminPassword,
        });
        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.PURGE_AUTHORISED, data),
        );
    });

    /**
     * POST /api/v1/data-purge/backup
     * Body: `{ groups?: string[], tables?: string[] }`
     * Streams the `.zip` archive as the response body and returns the
     * backup token / TTL / confirm phrase as response headers (there is no
     * JSON body on a binary response — see `CorsMiddleware`'s
     * `exposedHeaders` for why the FE can read these across CORS).
     *
     * Delegates to `DataPurgeService.backup` (not `BackupArchiveService.buildBackup`
     * directly) — this is the purge-gating backup, and `DataPurgeService.backup`
     * additionally persists a server-side PURGE copy and fires a
     * notification-only email (no attachment) fire-and-forget after the
     * archive is built.
     *
     * @param {import('express').Request}  req
     * @param {import('express').Response} res
     */
    static backup = catchAsync(async (req, res) => {
        const { groups, tables } = req.body ?? {};
        const adminId = _callerAdminId(req);

        const result = await DataPurgeService.backup({
            selection: { groups, tables },
            adminId,
            requestId: req.id ?? null,
        });

        res.status(HTTP_STATUS.OK)
            .set({
                "Content-Type": "application/zip",
                "Content-Disposition": `attachment; filename="${result.filename}"`,
                "X-Backup-Token": result.token,
                "X-Backup-Token-Expires-At": String(result.expiresAt),
                "X-Confirm-Phrase": encodeURIComponent(result.confirmPhrase),
            })
            .send(result.zipBuffer);
    });

    /**
     * POST /api/v1/data-purge/execute
     * Body: `{ scope: { groups?, tables? }, backupToken, adminPassword, confirmPhrase, acknowledgeLockout? }`
     * Performs the purge. See `DataPurgeService.executePurge` for the full
     * 9-step sequence.
     *
     * @param {import('express').Request}  req
     * @param {import('express').Response} res
     */
    static execute = catchAsync(async (req, res) => {
        const {
            scope,
            backupToken,
            adminPassword,
            confirmPhrase,
            acknowledgeLockout,
        } = req.body ?? {};
        const adminId = _callerAdminId(req);

        const report = await DataPurgeService.executePurge({
            selection: scope,
            backupToken,
            adminId,
            adminPassword,
            confirmPhrase,
            acknowledgeLockout,
            clientIp: req.ip ?? null,
            requestId: req.id ?? null,
        });

        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.PURGE_EXECUTED, report),
        );
    });

    /**
     * POST /api/v1/data-purge/restore/preview
     * Multipart form field `file` — a plain `.zip` backup archive (the route's
     * multer filter refuses anything else). Verifies the archive's signature and runs the full pre-flight (kind rule, fidelity
     * report). NEVER writes to the database.
     *
     * @param {import('express').Request}  req
     * @param {import('express').Response} res
     */
    static restorePreview = catchAsync(async (req, res) => {
        if (!req.file) {
            throw new AppError(
                PURGE_ERRORS.RESTORE_NO_FILE,
                HTTP_STATUS.BAD_REQUEST,
                {
                    type: "ValidationError",
                    details: [
                        {
                            field: "file",
                            issue: "No archive file was uploaded.",
                        },
                    ],
                },
            );
        }

        const data = await DataRestoreService.preview({
            zipBuffer: req.file.buffer,
        });
        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.RESTORE_PREVIEW_FETCHED, data),
        );
    });

    /**
     * POST /api/v1/data-purge/restore
     * Multipart form field `file` — a plain `.zip` backup archive — plus body
     * fields `{ adminPassword, confirmPhrase }`. Performs the restore. See
     * `DataRestoreService.restore` for the full sequence.
     *
     * @param {import('express').Request}  req
     * @param {import('express').Response} res
     */
    static restore = catchAsync(async (req, res) => {
        if (!req.file) {
            throw new AppError(
                PURGE_ERRORS.RESTORE_NO_FILE,
                HTTP_STATUS.BAD_REQUEST,
                {
                    type: "ValidationError",
                    details: [
                        {
                            field: "file",
                            issue: "No archive file was uploaded.",
                        },
                    ],
                },
            );
        }

        const { adminPassword, confirmPhrase } = req.body ?? {};
        const adminId = _callerAdminId(req);

        const report = await DataRestoreService.restore({
            zipBuffer: req.file.buffer,
            adminId,
            adminPassword,
            confirmPhrase,
            clientIp: req.ip ?? null,
            requestId: req.id ?? null,
        });

        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.RESTORE_EXECUTED, report),
        );
    });

    // ══════════════════════════════════════════════════════════════════════════
    // Backup tab handlers
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * GET /api/v1/data-purge/backups
     * Returns the on-disk backup archive index — chain health, disk usage,
     * per-archive metadata. Not cached (operator must see current state).
     *
     * @param {import('express').Request}  req
     * @param {import('express').Response} res
     */
    static listBackups = catchAsync(async (_req, res) => {
        const BackupStoreService = require("../services/BackupStoreService");
        const archives = await BackupStoreService.listArchives();

        // Derive aggregate disk usage from the index entries.
        const totalSizeBytes = archives.reduce(
            (sum, a) => sum + (a.sizeBytes ?? 0),
            0,
        );

        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.BACKUP_LIST_FETCHED, {
                archives,
                totalSizeBytes,
                count: archives.length,
            }),
        );
    });

    /**
     * POST /api/v1/data-purge/backups/run
     * Triggers a manual full-DB backup to disk. Rate-limited (same limiter
     * as /execute). Delegates to `BackupStoreService.runBackup` with
     * `trigger: "MANUAL"`.
     *
     * @param {import('express').Request}  req
     * @param {import('express').Response} res
     */
    static runManualBackup = catchAsync(async (req, res) => {
        const BackupStoreService = require("../services/BackupStoreService");
        const { getAllTableNames } = require("../constants/purgeTables");
        const adminId = _callerAdminId(req);

        logger.info(dataBackupMessages.MANUAL_BACKUP_REQUESTED(adminId));

        const result = await BackupStoreService.runBackup({
            trigger: "MANUAL",
            tables: getAllTableNames(),
            createdBy: adminId,
            requestId: req.id ?? null,
        });

        logger.notice(
            dataBackupMessages.MANUAL_BACKUP_COMPLETE(
                result.archiveId,
                adminId,
            ),
        );

        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.BACKUP_MANUAL_STARTED, {
                archiveId: result.archiveId,
                filename: result.filename,
                sizeBytes: result.sizeBytes,
                mode: result.mode,
                chain: result.chain,
                totalRows: result.totalRows,
                tableCount: result.tableCount,
                includedCount: result.includedCount,
                unchangedCount: result.unchangedCount,
                forcedFullReason: result.forcedFullReason,
            }),
        );
    });

    /**
     * GET /api/v1/data-purge/backups/:id/download
     * Materialises the archive into a self-contained FULL zip (resolving
     * the chain if incremental) and streams it as a binary response. The
     * operator always receives a complete archive regardless of how it is
     * stored on disk.
     *
     * @param {import('express').Request}  req
     * @param {import('express').Response} res
     */
    static downloadBackup = catchAsync(async (req, res) => {
        const BackupStoreService = require("../services/BackupStoreService");
        const adminId = _callerAdminId(req);
        const archiveId = req.params.id;

        logger.info(
            dataBackupMessages.DOWNLOAD_REQUESTED(archiveId, adminId),
        );

        const { zipBuffer, filename } =
            await BackupStoreService.materialise(archiveId);

        res.status(HTTP_STATUS.OK)
            .set({
                "Content-Type": "application/zip",
                "Content-Disposition": `attachment; filename="${filename}"`,
                "Content-Length": String(zipBuffer.length),
            })
            .send(zipBuffer);
    });

    /**
     * POST /api/v1/data-purge/backups/:id/verify
     * Re-verifies the archive's HMAC signature and checks that every chain
     * member it depends on is present and signature-valid. Read-only.
     *
     * @param {import('express').Request}  req
     * @param {import('express').Response} res
     */
    static verifyBackup = catchAsync(async (req, res) => {
        const BackupStoreService = require("../services/BackupStoreService");
        const adminId = _callerAdminId(req);
        const archiveId = req.params.id;

        // Delegates entirely to BackupStoreService.verifyArchive — the
        // service owns the signature re-verification AND the chain-health
        // walk. Throws BACKUP_VERIFY_FAILED (422) on failure.
        const result = await BackupStoreService.verifyArchive(archiveId);

        logger.info(
            dataBackupMessages.VERIFY_REQUESTED(archiveId, true, adminId),
        );

        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.BACKUP_VERIFIED, result),
        );
    });

    // ══════════════════════════════════════════════════════════════════════════
    // Majority-vote delete
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * POST /api/v1/data-purge/backups/:id/delete-request
     * Initiates a delete request — casts the requester's own vote as the
     * first approval. Returns the current vote status including how many
     * more votes are needed.
     *
     * @param {import('express').Request}  req
     * @param {import('express').Response} res
     */
    static requestDeleteBackup = catchAsync(async (req, res) => {
        const BackupStoreService = require("../services/BackupStoreService");
        const BackupVoteModel = require("../models/backup-vote.model");
        const adminId = _callerAdminId(req);
        const archiveId = req.params.id;

        // Validate archive exists (CWE-22 check inside getArchive).
        await BackupStoreService.getArchive(archiveId);

        // Check no existing request
        const existingVotes =
            await BackupVoteModel.findVotesByArchive(archiveId);
        if (existingVotes.length > 0) {
            throw new AppError(
                PURGE_ERRORS.BACKUP_DELETE_ALREADY_REQUESTED,
                HTTP_STATUS.CONFLICT,
                { type: "ConflictError" },
            );
        }

        // Cast the requester's own vote
        await BackupVoteModel.castVote(archiveId, adminId, adminId);

        // Calculate threshold
        const activeSuperAdmins = await BackupStoreService.countActiveSuperAdmins();
        const votesNeeded = Math.floor(activeSuperAdmins / 2) + 1;

        logger.notice(
            dataBackupMessages.DELETE_REQUEST_CREATED(
                archiveId,
                adminId,
                votesNeeded,
            ),
        );

        // If sole admin, threshold is 1 — auto-execute
        if (1 >= votesNeeded) {
            logger.notice(
                dataBackupMessages.DELETE_VOTE_THRESHOLD_MET(
                    archiveId,
                    adminId,
                ),
            );
            const deleteResult =
                await BackupStoreService.deleteArchive(archiveId);
            await BackupVoteModel.cancelRequest(archiveId);
            return res.status(HTTP_STATUS.OK).json(
                sendSuccess(RESPONSE_MESSAGES.BACKUP_DELETED, {
                    ...deleteResult,
                    votesNeeded,
                    votesCast: 1,
                    autoExecuted: true,
                }),
            );
        }

        const votes = await BackupVoteModel.findVotesByArchive(archiveId);
        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.BACKUP_DELETE_REQUESTED, {
                archiveId,
                votesNeeded,
                votesCast: votes.length,
                voters: votes.map((v) => ({
                    votedBy: v.VOTED_BY,
                    votedAt: v.VOTED_AT,
                })),
            }),
        );
    });

    /**
     * POST /api/v1/data-purge/backups/:id/vote
     * Casts an approval vote on an existing delete request. If the vote
     * meets the majority threshold, auto-executes the chain-safe delete.
     *
     * @param {import('express').Request}  req
     * @param {import('express').Response} res
     */
    static voteDeleteBackup = catchAsync(async (req, res) => {
        const BackupStoreService = require("../services/BackupStoreService");
        const BackupVoteModel = require("../models/backup-vote.model");
        const adminId = _callerAdminId(req);
        const archiveId = req.params.id;

        // Validate archive exists
        await BackupStoreService.getArchive(archiveId);

        // Check a request exists
        const existingVotes =
            await BackupVoteModel.findVotesByArchive(archiveId);
        if (existingVotes.length === 0) {
            throw new AppError(
                PURGE_ERRORS.BACKUP_DELETE_NO_REQUEST,
                HTTP_STATUS.BAD_REQUEST,
                { type: "ValidationError" },
            );
        }

        // Cast vote (UIX prevents double-vote)
        const castResult = await BackupVoteModel.castVote(
            archiveId,
            adminId,
            existingVotes[0].REQUESTED_BY,
        );
        if (!castResult.inserted) {
            throw new AppError(
                PURGE_ERRORS.BACKUP_DELETE_ALREADY_VOTED,
                HTTP_STATUS.CONFLICT,
                { type: "ConflictError" },
            );
        }

        // Check threshold
        const activeSuperAdmins = await BackupStoreService.countActiveSuperAdmins();
        const votesNeeded = Math.floor(activeSuperAdmins / 2) + 1;
        const votesCast = await BackupVoteModel.countVotesForArchive(archiveId);

        logger.info(
            dataBackupMessages.DELETE_VOTE_CAST(
                archiveId,
                adminId,
                votesCast,
                votesNeeded,
            ),
        );

        // Threshold met → auto-execute
        if (votesCast >= votesNeeded) {
            logger.notice(
                dataBackupMessages.DELETE_VOTE_THRESHOLD_MET(
                    archiveId,
                    adminId,
                ),
            );
            const deleteResult =
                await BackupStoreService.deleteArchive(archiveId);
            await BackupVoteModel.cancelRequest(archiveId);
            return res.status(HTTP_STATUS.OK).json(
                sendSuccess(RESPONSE_MESSAGES.BACKUP_DELETED, {
                    ...deleteResult,
                    votesNeeded,
                    votesCast,
                    autoExecuted: true,
                }),
            );
        }

        const votes = await BackupVoteModel.findVotesByArchive(archiveId);
        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.BACKUP_DELETE_VOTED, {
                archiveId,
                votesNeeded,
                votesCast,
                voters: votes.map((v) => ({
                    votedBy: v.VOTED_BY,
                    votedAt: v.VOTED_AT,
                })),
            }),
        );
    });

    /**
     * DELETE /api/v1/data-purge/backups/:id/delete-request
     * Cancels a pending delete request — removes all votes for the archive.
     * Any SUPER_ADMIN can cancel.
     *
     * @param {import('express').Request}  req
     * @param {import('express').Response} res
     */
    static cancelDeleteRequest = catchAsync(async (req, res) => {
        const BackupStoreService = require("../services/BackupStoreService");
        const BackupVoteModel = require("../models/backup-vote.model");
        const adminId = _callerAdminId(req);
        const archiveId = req.params.id;

        // Validate archive exists
        await BackupStoreService.getArchive(archiveId);

        // Check a request exists
        const existingVotes =
            await BackupVoteModel.findVotesByArchive(archiveId);
        if (existingVotes.length === 0) {
            throw new AppError(
                PURGE_ERRORS.BACKUP_DELETE_NO_REQUEST,
                HTTP_STATUS.BAD_REQUEST,
                { type: "ValidationError" },
            );
        }

        await BackupVoteModel.cancelRequest(archiveId);
        logger.notice(
            dataBackupMessages.DELETE_REQUEST_CANCELLED(archiveId, adminId),
        );

        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.BACKUP_DELETE_CANCELLED, {
                archiveId,
            }),
        );
    });
}

module.exports = DataPurgeController;
