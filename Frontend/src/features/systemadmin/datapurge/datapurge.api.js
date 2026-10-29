/**
 * @fileoverview HTTP API layer for the Data Purge & Restore feature.
 * All calls go through httpClient — never direct Axios imports (CWE-352).
 * No state, no React, no side effects — pure HTTP calls only.
 *
 * Backend base: /api/v1/data-purge (SUPER_ADMIN only)
 *
 * Endpoints (see `Backend/src/routes/data-purge.route.js` /
 * `DataPurgeController.js`):
 *   GET  data-purge/scopes           → group catalogue + live per-table row counts. Never cached.
 *   POST data-purge/preview          body { groups?, tables? } → resolved closure, fidelity notes, confirm phrase. Read-only.
 *   POST data-purge/backup           body { groups?, tables? } → binary .zip; X-Backup-Token / X-Backup-Token-Expires-At / X-Confirm-Phrase response headers.
 *   POST data-purge/execute          body { scope, backupToken, adminPassword, confirmPhrase, acknowledgeLockout? } → per-table delete report.
 *   POST data-purge/restore/preview  multipart "file" (.zip) → pre-flight report. Never writes.
 *   POST data-purge/restore          multipart "file" (.zip) + { adminPassword, confirmPhrase } → per-table restore report.
 *
 * Timeouts: `/backup`, `/execute`, and `/restore` all carry an explicit
 * 120s override — a full-schema backup or a large delete/insert transaction
 * genuinely runs longer than HttpClient's global 30s default.
 * `/scopes`, `/preview`, and `/restore/preview` stay on the 30s default —
 * they are read-only and expected to be fast.
 */

import httpClient from "../../../middleware/HttpClient";

/**
 * @typedef {{ groups?: string[], tables?: string[] }} PurgeSelection
 */

/**
 * @namespace dataPurgeApi
 */
export const dataPurgeApi = {
    /**
     * Fetch the full group catalogue with live per-table row counts.
     * Deliberately never cached server-side — an operator making a
     * destructive-purge decision must always see current data.
     *
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    getScopes: () => httpClient.get("data-purge/scopes"),

    /**
     * Read-only preview — resolves the FK closure, live per-table counts,
     * fidelity disclosures, and the exact confirm phrase for the Scope
     * Review step. Never writes anything.
     *
     * @param {PurgeSelection} selection
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    preview: (selection) => httpClient.post("data-purge/preview", selection),

    /**
     * Credential pre-check for the Authorise step, so a wrong password is
     * caught there rather than at `/execute` after the operator has already
     * typed the confirm phrase.
     *
     * Grants nothing — no token is returned and no state changes. `/execute`
     * re-verifies the password independently, so this is a UX gate only and
     * must never be treated as authorisation in its own right.
     *
     * @param {string} adminPassword
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    authorise: (adminPassword) => httpClient.post("data-purge/authorise", { adminPassword }),

    /**
     * Streams the backup `.zip` and issues the signed backup token that
     * `/execute` independently verifies server-side (CWE-602 — the FE
     * stepper gate alone is not the control). Response is binary; read the
     * `X-Backup-Token`, `X-Backup-Token-Expires-At`, and `X-Confirm-Phrase`
     * response headers to continue the stepper.
     *
     * @param {PurgeSelection} selection
     * @returns {Promise<import('axios').AxiosResponse<Blob>>}
     */
    backup: (selection) =>
        httpClient.post("data-purge/backup", selection, {
            responseType: "blob",
            // A full-schema backup genuinely runs longer than the default
            // request budget (HttpClient's global 30s).
            timeout: 120_000,
        }),

    /**
     * Performs the purge. `scope` is re-resolved server-side and never
     * trusted to already equal a prior `/preview` or `/backup` call.
     *
     * @param {{ scope: PurgeSelection, backupToken: string, adminPassword: string, confirmPhrase: string, acknowledgeLockout?: boolean }} payload
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    execute: (payload) =>
        httpClient.post("data-purge/execute", payload, {
            // A large multi-table DELETE transaction can genuinely take
            // longer than the default request budget.
            timeout: 120_000,
        }),

    /**
     * Dry-run pre-flight over an uploaded backup archive. Verifies the
     * archive's HMAC signature and returns the fidelity report + per-table
     * row counts. NEVER writes to the database.
     *
     * @param {File} file - The `.zip` backup archive.
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    restorePreview: (file) => {
        const formData = new FormData();
        formData.append("file", file);
        return httpClient.post("data-purge/restore/preview", formData, {
            headers: { "Content-Type": "multipart/form-data" },
            timeout: 120_000,
        });
    },

    /**
     * Performs the restore. Re-verifies the archive signature and pre-flight
     * server-side (never trusts the prior `/restore/preview` response).
     *
     * @param {File} file - The `.zip` backup archive.
     * @param {string} adminPassword
     * @param {string} confirmPhrase
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    restore: (file, adminPassword, confirmPhrase) => {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("adminPassword", adminPassword);
        formData.append("confirmPhrase", confirmPhrase);
        return httpClient.post("data-purge/restore", formData, {
            headers: { "Content-Type": "multipart/form-data" },
            timeout: 120_000,
        });
    },

    // ── Backup tab ─────────────────────────────────────────────────────────

    /**
     * Lists all backup archives on disk — chain health, disk usage,
     * per-archive metadata. Not cached.
     *
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    listBackups: () => httpClient.get("data-purge/backups"),

    /**
     * Triggers a manual full-DB backup to disk ("Back Up Now").
     * Rate-limited server-side.
     *
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    runManualBackup: () => httpClient.post("data-purge/backups/run", {}, { timeout: 120_000 }),

    /**
     * Downloads a materialised self-contained FULL zip for one archive.
     * The server resolves the chain if incremental — the download is
     * always a complete archive regardless of storage mode.
     *
     * @param {string} archiveId
     * @returns {Promise<import('axios').AxiosResponse<Blob>>}
     */
    downloadBackup: (archiveId) =>
        httpClient.get(`data-purge/backups/${encodeURIComponent(archiveId)}/download`, {
            responseType: "blob",
            timeout: 120_000,
        }),

    /**
     * Re-verifies the archive's HMAC signature and chain integrity.
     * Read-only.
     *
     * @param {string} archiveId
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    verifyBackup: (archiveId) => httpClient.post(`data-purge/backups/${encodeURIComponent(archiveId)}/verify`),

    // ── Majority-vote delete ──────────────────────────────────────────────

    /**
     * Initiates a delete request (casts the requester's own vote).
     * @param {string} archiveId
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    requestDeleteBackup: (archiveId) => httpClient.post(`data-purge/backups/${encodeURIComponent(archiveId)}/delete-request`),

    /**
     * Casts an approval vote on an existing delete request.
     * @param {string} archiveId
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    voteDeleteBackup: (archiveId) => httpClient.post(`data-purge/backups/${encodeURIComponent(archiveId)}/vote`),

    /**
     * Cancels a pending delete request (removes all votes).
     * @param {string} archiveId
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    cancelDeleteRequest: (archiveId) => httpClient.delete(`data-purge/backups/${encodeURIComponent(archiveId)}/delete-request`),
};

export default dataPurgeApi;
