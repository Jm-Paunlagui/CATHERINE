/**
 * @fileoverview Hook for the Data Purge & Restore feature (SUPER_ADMIN only).
 * Owns all state, data fetching, the 5-step purge stepper, and the restore
 * dropzone → dry-run preview → confirm flow.
 * DataPurge.view.jsx imports this hook — never datapurge.api.js directly.
 *
 * State managed here:
 *   - Scope catalogue (GET /scopes) — deliberately re-fetched fresh, never
 *     cached client-side either: a destructive-purge decision must always
 *     see current row counts (mirrors the backend's own "never cached"
 *     posture for this route).
 *   - Group selection for the Purge tab + client-side "auto-included"
 *     preview (derived from each group's `autoIncludes` list — the same
 *     `GROUP_CLOSURE_HINTS` the backend resolves against, surfaced by
 *     `GET /scopes` so the FE never has to guess).
 *   - The 5-step purge stepper (Scope Review → Backup → Authorise → Final
 *     Confirm → Processing).
 *   - The Restore panel (dropzone → dry-run `/restore/preview` → confirm →
 *     `/restore`).
 *
 * Confirm-phrase source of truth (rule: the backend issues the phrase; it is
 * never composed client-side):
 *   - Purge: `POST /preview` returns `confirmPhrase` for the Scope Review
 *     step. The AUTHORITATIVE phrase gating Step 4 is instead read from
 *     `POST /backup`'s `X-Confirm-Phrase` response header once the backup
 *     completes — it is built server-side from the SAME frozen row-count
 *     snapshot embedded in the backup token that `/execute` verifies
 *     against (`DataPurgeService.buildConfirmPhrase(groups, tokenTotalRows)`),
 *     so it can never drift from what the server will actually check.
 *   - Restore: as shipped, `POST /restore/preview`'s response does NOT
 *     include a confirm phrase field (`DataRestoreService._preflight`
 *     returns `{ tables, kind, entity, rowCounts, tablesGettingNewPks,
 *     fidelityNotes, archiveMeta }` — no `confirmPhrase`).
 *     This is the one exception to that rule. Rather than
 *     silently failing to show the operator what to type, this hook derives
 *     the exact phrase from the SAME public, documented, deterministic
 *     formula the server uses to build and re-verify it
 *     (`DataRestoreService.buildConfirmPhrase`: `RESTORE <sorted unique
 *     groups joined by ", "> <sum of rowCounts> ROWS`), using only fields
 *     the preview response DOES return (`tables`, `rowCounts`). This is safe
 *     because `POST /restore` recomputes and compares against that exact
 *     same formula server-side regardless of what the FE displays — the FE
 *     value only guides the operator, it is never trusted as the gate.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { extractApiError, toast } from "../../../components/ui/toast.utils";
import { dataPurgeApi } from "./datapurge.api";

// ─── Local pure helpers (no state, no side effects) ───────────────────────────

/**
 * UX-only pre-check ceiling for the restore dropzone. Mirrors the backend's
 * `BACKUP_UPLOAD_MAX_MB` default (100) — the multer limit in
 * `data-purge.route.js` is the actual source of truth; this only lets the FE
 * reject an obviously oversized file before spending a 120s upload attempt.
 */
const MAX_RESTORE_FILE_SIZE = 100 * 1024 * 1024;

/**
 * Formats a byte count into a human-readable string (e.g. "2.1 MB").
 * @param {number} bytes
 * @returns {string}
 */
function formatFileSize(bytes) {
    if (!bytes) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Triggers a browser download of a Blob with the given filename.
 * @param {Blob} blob
 * @param {string} filename
 */
function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
    }, 0);
}

/**
 * Extracts the filename from a `Content-Disposition: attachment;
 * filename="..."` header value.
 * @param {string|undefined} headerValue
 * @param {string} fallback
 * @returns {string}
 */
function parseFilenameFromContentDisposition(headerValue, fallback) {
    if (!headerValue) return fallback;
    const match = /filename="?([^";]+)"?/i.exec(headerValue);
    return match?.[1] ?? fallback;
}

/**
 * Decodes a backend `AppError` delivered as a binary Blob body. `/backup`
 * uses `responseType: "blob"`, so a JSON error (400/401/403/…) arrives as
 * raw bytes — `err.response.data.message` is undefined until decoded.
 * @param {import('axios').AxiosError} err
 * @returns {Promise<string|null>}
 */
async function extractBlobErrorMessage(err) {
    const data = err.response?.data;
    if (!data) return null;
    if (typeof data.message === "string") return data.message;
    try {
        const text = data instanceof Blob ? await data.text() : null;
        if (!text) return null;
        return JSON.parse(text)?.message ?? null;
    } catch {
        return null;
    }
}

/**
 * Builds the exact restore confirm phrase using the same public,
 * deterministic formula `DataRestoreService.buildConfirmPhrase` uses
 * server-side — see the file header note on why this is derived rather than
 * read from the response.
 * @param {string[]} groups
 * @param {number} totalRows
 * @returns {string}
 */
function buildRestoreConfirmPhrase(groups, totalRows) {
    const groupList = [...new Set(groups)].sort().join(", ");
    return `RESTORE ${groupList} ${totalRows} ROWS`;
}

/**
 * Resolves a table's purge group from the scope catalogue (`GET /scopes`),
 * which lists every registered table under its group — the same registry the
 * server builds the restore phrase from. Falls back to the table name's
 * leading segment (`"T_ADMINS_DEV"` → `"T_"`) when the catalogue is absent.
 * @param {string} table
 * @param {{ groups?: Array<{ group: string, tables: Array<{ table: string }> }> }|null} catalogue
 * @returns {string}
 */
function groupKeyFromTable(table, catalogue) {
    const owner = (catalogue?.groups ?? []).find((g) => (g.tables ?? []).some((t) => t.table === table));
    return owner?.group ?? `${table.split("_")[0]}_`;
}

/** The admin-account table: purging it destroys every admin login (lockout acknowledgement). */
const ADMIN_ACCOUNT_TABLE = "T_ADMINS_DEV";

const EMPTY_PURGE_SELECTION = Object.freeze({ groups: [], tables: [] });

/**
 * Business logic, state, and data for the Data Purge & Restore feature.
 *
 * @returns {object} See individual property JSDoc inline below for shape;
 *   the hook exposes: scope catalogue + selection, the 5-step purge
 *   stepper, and the restore panel state/handlers.
 */
export const useDataPurge = () => {
    // ── Tab ───────────────────────────────────────────────────────────────────
    const [activeTab, setActiveTab] = useState("purge");
    const handleTabChange = useCallback((tabId) => setActiveTab(tabId), []);

    // ── Scope catalogue (GET /scopes) — manual fetch, never cached. Guarded
    // against React Strict Mode's double-mount effect via initFiredRef
    // (CLAUDE.md §7.1 — useRequest is not used here on purpose: a
    // destructive-purge decision must always see current data, and
    // useRequest's cache TTL would risk showing stale row counts). ─────────
    const [scopeCatalogue, setScopeCatalogue] = useState(null);
    const [scopesLoading, setScopesLoading] = useState(true);
    const [scopesError, setScopesError] = useState(null);
    const scopesFiredRef = useRef(false);

    /** Fetch (or re-fetch) the group catalogue with live row counts. */
    const refetchScopes = useCallback(async () => {
        setScopesLoading(true);
        setScopesError(null);
        try {
            const res = await dataPurgeApi.getScopes();
            setScopeCatalogue(res.data?.data ?? null);
        } catch (err) {
            setScopesError(extractApiError(err, "Failed to load the purge scope catalogue."));
        } finally {
            setScopesLoading(false);
        }
    }, []);

    // Mount-time fetch, guarded against React Strict Mode's double-invoke
    // (CLAUDE.md §7.1 initFiredRef pattern) — this is a raw fetcher, not
    // useRequest, so the guard must be applied manually.
    useEffect(() => {
        if (scopesFiredRef.current) return;
        scopesFiredRef.current = true;

        let cancelled = false;
        const run = async () => {
            if (cancelled) return;
            await refetchScopes();
        };
        run();
        return () => {
            cancelled = true;
        };
    }, [refetchScopes]);

    // ── Group selection (Purge tab) ──────────────────────────────────────────
    const [selectedGroups, setSelectedGroups] = useState([]);

    /** Toggle a group key in/out of the selection. */
    const toggleGroup = useCallback((group) => {
        setSelectedGroups((prev) => (prev.includes(group) ? prev.filter((g) => g !== group) : [...prev, group]));
    }, []);

    /** Clear the current group selection. */
    const clearSelection = useCallback(() => setSelectedGroups([]), []);

    // Client-side "pulled in by dependency" preview — derived from each
    // group's `autoIncludes` (GET /scopes), the same GROUP_CLOSURE_HINTS the
    // backend resolves against. This is a UI preview only; the AUTHORITATIVE
    // resolved closure is always re-fetched from POST /preview when the
    // stepper opens, so the operator sees the auto-included groups before
    // anything is downloaded or deleted.
    const autoIncludedGroupsPreview = (() => {
        if (!scopeCatalogue) return [];
        const included = new Set();
        for (const g of scopeCatalogue.groups) {
            if (!selectedGroups.includes(g.group)) continue;
            for (const dep of g.autoIncludes ?? []) {
                if (!selectedGroups.includes(dep)) included.add(dep);
            }
        }
        return [...included].sort();
    })();

    // ── Purge stepper modal (5 steps) ─────────────────────────────────────────
    const [purgeModalOpen, setPurgeModalOpen] = useState(false);
    const [purgeStep, setPurgeStep] = useState(1);
    /** Selection frozen at the moment the modal opened — reused unchanged
     * across preview → backup → execute so the three calls never drift from
     * each other even if the operator edits the card selection behind the
     * modal (they cannot, since the modal is a portal overlay, but freezing
     * here is cheap insurance). */
    const [purgeSelection, setPurgeSelection] = useState(EMPTY_PURGE_SELECTION);

    // Step 1 — Scope Review
    const [previewLoading, setPreviewLoading] = useState(false);
    const [previewData, setPreviewData] = useState(null);
    const [previewError, setPreviewError] = useState(null);

    // Step 2 — Backup
    const [backupDownloading, setBackupDownloading] = useState(false);
    const [backupDownloaded, setBackupDownloaded] = useState(false);
    const [backupError, setBackupError] = useState(null);
    const [backupToken, setBackupToken] = useState(null);
    const [backupTokenExpiresAt, setBackupTokenExpiresAt] = useState(null);
    /** Server-issued confirm phrase from the backup response — see file
     * header note on why this (not `previewData.confirmPhrase`) is the
     * authoritative value gating Step 4. */
    const [purgeConfirmPhrase, setPurgeConfirmPhrase] = useState(null);

    // Step 3 — Authorise
    const [adminPassword, setAdminPassword] = useState("");
    const [authorising, setAuthorising] = useState(false);
    const [authoriseError, setAuthoriseError] = useState(null);

    // Step 4 — Final Confirm
    const [confirmPhraseTyped, setConfirmPhraseTyped] = useState("");
    const [confirmShaking, setConfirmShaking] = useState(false);
    const [acknowledgeLockout, setAcknowledgeLockout] = useState(false);

    // Step 5 — Processing
    const [executing, setExecuting] = useState(false);
    const [executeResult, setExecuteResult] = useState(null);
    const [executeError, setExecuteError] = useState(null);

    /** True when the resolved scope includes the admin-account table. */
    const requiresLockoutAck = (previewData?.tables ?? []).some((t) => t.table === ADMIN_ACCOUNT_TABLE);
    const confirmPhraseMatches = purgeConfirmPhrase !== null && confirmPhraseTyped.trim() === purgeConfirmPhrase;
    const canExecutePurge = backupDownloaded && !!adminPassword.trim() && confirmPhraseMatches && (!requiresLockoutAck || acknowledgeLockout) && !executing;

    const fetchPreview = useCallback(async (selection) => {
        setPreviewLoading(true);
        setPreviewError(null);
        try {
            const res = await dataPurgeApi.preview(selection);
            setPreviewData(res.data?.data ?? null);
        } catch (err) {
            setPreviewError(extractApiError(err, "Failed to generate the purge preview."));
        } finally {
            setPreviewLoading(false);
        }
    }, []);

    /** Open the purge stepper modal for the current group selection. */
    const openPurgeModal = useCallback(() => {
        if (selectedGroups.length === 0) {
            toast.warning("Select at least one group to purge.");
            return;
        }
        const selection = { groups: [...selectedGroups] };
        setPurgeSelection(selection);
        setPurgeStep(1);
        setPreviewData(null);
        setPreviewError(null);
        setBackupDownloaded(false);
        setBackupToken(null);
        setBackupTokenExpiresAt(null);
        setPurgeConfirmPhrase(null);
        setBackupError(null);
        setAdminPassword("");
        setAuthoriseError(null);
        setConfirmPhraseTyped("");
        setConfirmShaking(false);
        setAcknowledgeLockout(false);
        setExecuting(false);
        setExecuteResult(null);
        setExecuteError(null);
        setPurgeModalOpen(true);
        fetchPreview(selection);
    }, [selectedGroups, fetchPreview]);

    /** Close the purge stepper modal and reset all step state. */
    const closePurgeModal = useCallback(() => {
        if (executing) return; // never allow closing mid-execute
        setPurgeModalOpen(false);
        setPurgeStep(1);
        setPreviewData(null);
        setAdminPassword("");
        setAuthoriseError(null);
        setConfirmPhraseTyped("");
        setAcknowledgeLockout(false);
        setExecuteResult(null);
        setExecuteError(null);
    }, [executing]);

    /** Advance/rewind the purge stepper to an explicit step number. */
    const advancePurgeStep = useCallback((step) => setPurgeStep(step), []);

    /**
     * Step 3 → 4 gate. Verifies the typed admin password server-side BEFORE
     * letting the operator move on to the confirm phrase, so a wrong password
     * surfaces here rather than at /execute — i.e. before they have committed
     * to the action. Purely a UX gate: /execute re-verifies the password
     * independently, so passing this grants nothing.
     */
    const handleAuthorise = useCallback(async () => {
        if (!adminPassword.trim()) return false;
        setAuthorising(true);
        setAuthoriseError(null);
        try {
            await dataPurgeApi.authorise(adminPassword);
            setPurgeStep(4);
            return true;
        } catch (err) {
            setAuthoriseError(err);
            return false;
        } finally {
            setAuthorising(false);
        }
    }, [adminPassword]);

    const handleDownloadBackup = useCallback(async () => {
        setBackupDownloading(true);
        setBackupError(null);
        try {
            const res = await dataPurgeApi.backup(purgeSelection);
            const token = res.headers["x-backup-token"];
            if (!token) throw new Error("Backup token missing from the server response.");
            const expiresAtHeader = res.headers["x-backup-token-expires-at"];
            const confirmPhraseHeader = res.headers["x-confirm-phrase"];
            const filename = parseFilenameFromContentDisposition(res.headers["content-disposition"], `app-backup_${Date.now()}.zip`);

            downloadBlob(res.data, filename);

            setBackupToken(token);
            setBackupTokenExpiresAt(expiresAtHeader ? Number(expiresAtHeader) : null);
            setPurgeConfirmPhrase(confirmPhraseHeader ? decodeURIComponent(confirmPhraseHeader) : (previewData?.confirmPhrase ?? null));
            setBackupDownloaded(true);
            toast.success("Backup archive downloaded. Keep it safe — this is the only copy.");
        } catch (err) {
            const backendMsg = await extractBlobErrorMessage(err);
            const fallback = "Backup download failed. The purge cannot proceed without a completed backup.";
            setBackupError({ ...extractApiError(err, fallback), message: backendMsg ?? fallback });
        } finally {
            setBackupDownloading(false);
        }
    }, [purgeSelection, previewData]);

    /** Validates Step 4 client-side and either advances to Processing + executes, or shakes. */
    const handleExecutePurge = useCallback(async () => {
        if (!confirmPhraseMatches || !adminPassword.trim() || (requiresLockoutAck && !acknowledgeLockout)) {
            setConfirmShaking(true);
            return;
        }
        setPurgeStep(5);
        setExecuting(true);
        setExecuteError(null);
        try {
            const res = await dataPurgeApi.execute({
                scope: purgeSelection,
                backupToken,
                adminPassword,
                confirmPhrase: confirmPhraseTyped.trim(),
                ...(requiresLockoutAck ? { acknowledgeLockout: true } : {}),
            });
            setExecuteResult(res.data?.data ?? null);
            toast.success(res.data?.message || "Purge completed successfully.");
        } catch (err) {
            setExecuteError(extractApiError(err, "Purge failed. No data was deleted — the operation was rolled back atomically."));
            setPurgeStep(4); // let the operator see the error and correct/retry
        } finally {
            setExecuting(false);
        }
    }, [confirmPhraseMatches, adminPassword, requiresLockoutAck, acknowledgeLockout, purgeSelection, backupToken, confirmPhraseTyped]);

    // ── Restore panel ────────────────────────────────────────────────────────
    const [restoreFile, setRestoreFile] = useState(null);
    const [restoreFileError, setRestoreFileError] = useState(null);
    const [restoreShaking, setRestoreShaking] = useState(false);

    const [restorePreviewLoading, setRestorePreviewLoading] = useState(false);
    const [restorePreviewData, setRestorePreviewData] = useState(null);
    const [restorePreviewError, setRestorePreviewError] = useState(null);

    const [restoreAdminPassword, setRestoreAdminPassword] = useState("");
    const [restoreConfirmPhraseTyped, setRestoreConfirmPhraseTyped] = useState("");
    const [restoreConfirmShaking, setRestoreConfirmShaking] = useState(false);

    const [restoreExecuting, setRestoreExecuting] = useState(false);
    const [restoreResult, setRestoreResult] = useState(null);
    const [restoreError, setRestoreError] = useState(null);

    /** Accepts a dropped/selected `.zip` file, validating type + size (UX pre-check only). */
    const handleRestoreFile = useCallback((file) => {
        if (!file) return;
        const isZip = file.name?.toLowerCase().endsWith(".zip") || file.type === "application/zip" || file.type === "application/x-zip-compressed";
        if (!isZip) {
            setRestoreFileError("Invalid file type. Only .zip backup archives are accepted.");
            setRestoreShaking(true);
            return;
        }
        if (file.size > MAX_RESTORE_FILE_SIZE) {
            setRestoreFileError(`File too large. Maximum size is ${formatFileSize(MAX_RESTORE_FILE_SIZE)}.`);
            setRestoreShaking(true);
            return;
        }
        setRestoreFileError(null);
        setRestoreFile(file);
        setRestorePreviewData(null);
        setRestorePreviewError(null);
    }, []);

    /** Clears the selected restore file and any downstream preview/confirm state. */
    const handleRemoveRestoreFile = useCallback(() => {
        setRestoreFile(null);
        setRestoreFileError(null);
        setRestorePreviewData(null);
        setRestorePreviewError(null);
        setRestoreAdminPassword("");
        setRestoreConfirmPhraseTyped("");
        setRestoreResult(null);
        setRestoreError(null);
    }, []);

    /** Runs the read-only dry-run pre-flight (`POST /restore/preview`). */
    const handleRestorePreview = useCallback(async () => {
        if (!restoreFile) return;
        setRestorePreviewLoading(true);
        setRestorePreviewError(null);
        try {
            const res = await dataPurgeApi.restorePreview(restoreFile);
            setRestorePreviewData(res.data?.data ?? null);
        } catch (err) {
            setRestorePreviewError(extractApiError(err, "Restore pre-flight failed."));
        } finally {
            setRestorePreviewLoading(false);
        }
    }, [restoreFile]);

    /** Expected confirm phrase for the loaded archive — see file header note. */
    const restoreExpectedPhrase = restorePreviewData
        ? buildRestoreConfirmPhrase(
              restorePreviewData.tables.map((t) => groupKeyFromTable(t, scopeCatalogue)),
              Object.values(restorePreviewData.rowCounts ?? {}).reduce((sum, n) => sum + n, 0),
          )
        : null;

    const restoreConfirmMatches = restoreExpectedPhrase !== null && restoreConfirmPhraseTyped.trim() === restoreExpectedPhrase;
    const canExecuteRestore = !!restorePreviewData && !!restoreAdminPassword.trim() && restoreConfirmMatches && !restoreExecuting;

    /** Performs the restore (`POST /restore`). */
    const handleRestoreExecute = useCallback(async () => {
        if (!restorePreviewData || !restoreAdminPassword.trim() || !restoreConfirmMatches) {
            setRestoreConfirmShaking(true);
            return;
        }
        setRestoreExecuting(true);
        setRestoreError(null);
        try {
            const res = await dataPurgeApi.restore(restoreFile, restoreAdminPassword, restoreConfirmPhraseTyped.trim());
            setRestoreResult(res.data?.data ?? null);
            toast.success(res.data?.message || "Restore completed successfully.");
        } catch (err) {
            setRestoreError(extractApiError(err, "Restore failed. No data was written — the operation was rolled back atomically."));
        } finally {
            setRestoreExecuting(false);
        }
    }, [restorePreviewData, restoreAdminPassword, restoreConfirmMatches, restoreFile, restoreConfirmPhraseTyped]);

    /** Resets the entire Restore panel back to the dropzone. */
    const resetRestore = useCallback(() => {
        setRestoreFile(null);
        setRestoreFileError(null);
        setRestorePreviewData(null);
        setRestorePreviewError(null);
        setRestoreAdminPassword("");
        setRestoreConfirmPhraseTyped("");
        setRestoreResult(null);
        setRestoreError(null);
    }, []);

    // ── Backup tab ────────────────────────────────────────────────────────
    const [backupList, setBackupList] = useState(null);
    const [backupListLoading, setBackupListLoading] = useState(false);
    const [backupListError, setBackupListError] = useState(null);
    const [backupTotalSizeBytes, setBackupTotalSizeBytes] = useState(0);

    const [manualBackupRunning, setManualBackupRunning] = useState(false);
    const [verifyingArchiveId, setVerifyingArchiveId] = useState(null);
    const [deleteConfirmId, setDeleteConfirmId] = useState(null);

    /** Fetch (or re-fetch) the backup archive list. */
    const refetchBackups = useCallback(async () => {
        setBackupListLoading(true);
        setBackupListError(null);
        try {
            const res = await dataPurgeApi.listBackups();
            const data = res.data?.data ?? {};
            setBackupList(data.archives ?? []);
            setBackupTotalSizeBytes(data.totalSizeBytes ?? 0);
        } catch (err) {
            setBackupListError(extractApiError(err, "Failed to load backup archives."));
        } finally {
            setBackupListLoading(false);
        }
    }, []);

    /** Trigger a manual backup ("Back Up Now"). */
    const handleRunManualBackup = useCallback(async () => {
        setManualBackupRunning(true);
        try {
            const res = await dataPurgeApi.runManualBackup();
            toast.success(res.data?.message || "Manual backup completed.");
            await refetchBackups();
        } catch (err) {
            toast.error(extractApiError(err, "Manual backup failed.").message);
        } finally {
            setManualBackupRunning(false);
        }
    }, [refetchBackups]);

    /** Download a materialised self-contained FULL zip. */
    const handleDownloadArchive = useCallback(async (archiveId) => {
        try {
            const res = await dataPurgeApi.downloadBackup(archiveId);
            const filename = parseFilenameFromContentDisposition(res.headers["content-disposition"], `app-backup_${archiveId}.zip`);
            downloadBlob(res.data, filename);
            toast.success("Backup archive downloaded. This is a self-contained copy regardless of how it was stored.");
        } catch (err) {
            const backendMsg = await extractBlobErrorMessage(err);
            toast.error(backendMsg || "Backup download failed.");
        }
    }, []);

    /** Verify an archive's signature + chain integrity. */
    const handleVerifyArchive = useCallback(async (archiveId) => {
        setVerifyingArchiveId(archiveId);
        try {
            await dataPurgeApi.verifyBackup(archiveId);
            toast.success("Archive integrity verified — signature and chain are valid.");
        } catch (err) {
            toast.error(extractApiError(err, "Archive verification failed.").message);
        } finally {
            setVerifyingArchiveId(null);
        }
    }, []);

    return {
        // Tab
        activeTab,
        handleTabChange,

        // Scope catalogue
        scopeCatalogue,
        scopesLoading,
        scopesError,
        refetchScopes,

        // Selection
        selectedGroups,
        toggleGroup,
        clearSelection,
        autoIncludedGroupsPreview,

        // Purge stepper modal
        purgeModalOpen,
        purgeStep,
        openPurgeModal,
        closePurgeModal,
        advancePurgeStep,
        handleAuthorise,
        authorising,
        authoriseError,
        setAuthoriseError,

        previewLoading,
        previewData,
        previewError,

        backupDownloading,
        backupDownloaded,
        backupError,
        backupTokenExpiresAt,
        purgeConfirmPhrase,
        handleDownloadBackup,

        adminPassword,
        setAdminPassword,

        confirmPhraseTyped,
        setConfirmPhraseTyped,
        confirmShaking,
        setConfirmShaking,
        acknowledgeLockout,
        setAcknowledgeLockout,
        requiresLockoutAck,
        confirmPhraseMatches,

        executing,
        executeResult,
        executeError,
        canExecutePurge,
        handleExecutePurge,

        // Restore panel
        restoreFile,
        restoreFileError,
        restoreShaking,
        setRestoreShaking,
        handleRestoreFile,
        handleRemoveRestoreFile,
        formatFileSize,
        maxRestoreFileSize: MAX_RESTORE_FILE_SIZE,

        restorePreviewLoading,
        restorePreviewData,
        restorePreviewError,
        handleRestorePreview,

        restoreAdminPassword,
        setRestoreAdminPassword,
        restoreConfirmPhraseTyped,
        setRestoreConfirmPhraseTyped,
        restoreConfirmShaking,
        setRestoreConfirmShaking,
        restoreExpectedPhrase,
        restoreConfirmMatches,

        restoreExecuting,
        restoreResult,
        restoreError,
        canExecuteRestore,
        handleRestoreExecute,
        resetRestore,

        // Backup tab
        backupList,
        backupListLoading,
        backupListError,
        backupTotalSizeBytes,
        refetchBackups,
        manualBackupRunning,
        handleRunManualBackup,
        handleDownloadArchive,
        verifyingArchiveId,
        handleVerifyArchive,
        deleteConfirmId,
        setDeleteConfirmId,

        // Vote handlers
        handleRequestDelete: useCallback(
            async (archiveId) => {
                try {
                    const res = await dataPurgeApi.requestDeleteBackup(archiveId);
                    const data = res.data?.data;
                    if (data?.autoExecuted) {
                        toast.success(res.data?.message || "Backup deleted (sole admin).");
                    } else {
                        toast.success(res.data?.message || "Delete request submitted.");
                    }
                    await refetchBackups();
                } catch (err) {
                    toast.error(extractApiError(err, "Failed to request delete.").message);
                }
            },
            [refetchBackups],
        ),

        handleVoteDelete: useCallback(
            async (archiveId) => {
                try {
                    const res = await dataPurgeApi.voteDeleteBackup(archiveId);
                    const data = res.data?.data;
                    if (data?.autoExecuted) {
                        toast.success(res.data?.message || "Backup deleted (threshold met).");
                    } else {
                        toast.success(res.data?.message || "Vote recorded.");
                    }
                    await refetchBackups();
                } catch (err) {
                    toast.error(extractApiError(err, "Failed to cast vote.").message);
                }
            },
            [refetchBackups],
        ),

        handleCancelDeleteRequest: useCallback(
            async (archiveId) => {
                try {
                    const res = await dataPurgeApi.cancelDeleteRequest(archiveId);
                    toast.success(res.data?.message || "Delete request cancelled.");
                    await refetchBackups();
                } catch (err) {
                    toast.error(extractApiError(err, "Failed to cancel delete request.").message);
                }
            },
            [refetchBackups],
        ),
    };
};

export default useDataPurge;
