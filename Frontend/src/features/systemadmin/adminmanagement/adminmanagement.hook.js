/**
 * adminmanagement.hook.js — Admin Management state and handlers.
 *
 * Business logic layer. Imports adminmanagement.api.js for HTTP calls.
 * Views import this hook — never the API file directly.
 *
 * State managed here:
 *   - Admin list (via useRequest for server-state caching)
 *   - Account search results + debounce (Add Admin modal)
 *   - Modal open/close states (add, edit, reset-password, reset-sig,
 *     revoke/delete, permissions)
 *   - Form state for add, edit, and permissions operations
 *   - Current authenticated user (role check for SUPER_ADMIN gate)
 *   - Per-operation loading flags
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { extractApiError, toast } from "../../../components/ui/toast.utils";
import useDebounce from "../../../hooks/useDebounce";
import { invalidateCache, useRequest } from "../../../hooks/useRequest";
import AuthMiddleware from "../../../middleware/authentication/AuthMiddleware";
import { adminManagementApi } from "./adminmanagement.api";

const CACHE_KEY = "admin-management/list";

/** Canonical set of valid ROLE values — kept in sync with backend AdminManagementService.VALID_ROLES. */
const VALID_ROLES = ["SUPER_ADMIN", "ADMIN", "USER"];

// ─── Revoke/Delete flow — local pure helpers ───────────────────────────────────
// Mirrors the identically-named helpers in datapurge.hook.js (Data Purge &
// Restore uses the same signed backup-token machinery) — duplicated rather
// than shared to avoid coupling two independently-owned feature hooks.

/**
 * Triggers a browser download of a Blob with the given filename.
 * @param {Blob} blob
 * @param {string} filename
 */
function downloadRevokeBackupBlob(blob, filename) {
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
function parseRevokeBackupFilename(headerValue, fallback) {
    if (!headerValue) return fallback;
    const match = /filename="?([^";]+)"?/i.exec(headerValue);
    return match?.[1] ?? fallback;
}

/**
 * Decodes a backend `AppError` delivered as a binary Blob body.
 * `revokeBackup` uses `responseType: "blob"`, so a JSON error (401/403/404/…)
 * arrives as raw bytes — `err.response.data.message` is undefined until
 * decoded. Mirrors `extractBlobErrorMessage` in `datapurge.hook.js`.
 * @param {import('axios').AxiosError} err
 * @returns {Promise<string|null>}
 */
async function extractRevokeBlobErrorMessage(err) {
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
 * Default permission flags used when opening the Add Admin modal.
 * Access Control policy: deny-by-default — every permission starts at 'N'
 * and must be granted explicitly; only isActive starts at 'Y'.
 * Mirrors the backend creation defaults so what the creator sees
 * is exactly what will be stored if they do not change anything.
 */
const EMPTY_ADD_FLAGS = {
    // Server Email Notifications opt-in flags — deny-by-default, never 'Y' here.
    canReceiveSrvCrit: "N",
    canReceiveSrvDeps: "N",
    canReceiveSrvRed: "N",
    canReceiveSrvSys: "N",
    isActive: "Y",
};

// The server generates the password and emails it. `overrideEmail` is only sent
// when the account profile has no address; `overrideRequired` flips on when the
// server answers 422 for an account whose email status was unknown at search time.
const EMPTY_ADD_FORM = {
    selectedAccount: null, // { username, firstName, lastName, emailOnFile, emailHint, ... }
    role: "ADMIN",
    overrideEmail: "",
    overrideRequired: false,
    flags: { ...EMPTY_ADD_FLAGS },
};

// Edit changes the ROLE only: passwords are issued by Add / Reset Password and
// emailed, never typed by an operator.
const EMPTY_EDIT_FORM = {
    role: "ADMIN",
};

/**
 * Who may do what in Access Control — the UI mirror of the API's
 * AdminManagementService._assertCanManage. The API enforces it; this only
 * hides actions the caller would be refused.
 *
 *   SUPER_ADMIN  manages every role.
 *   ADMIN        may add a USER and send Reset Password to a USER other
 *                than itself — nothing else.
 *
 * @param {{ role?: string, userId?: string|number }|null} currentUser
 * @returns {{
 *   isSuperAdmin: boolean,
 *   addableRoles: string[],
 *   canEdit: (row: {role: string}) => boolean,
 *   canResetPassword: (row: {role: string, username: string|number}) => boolean,
 *   canResetSignature: () => boolean,
 *   canRevoke: () => boolean,
 * }}
 */
export function accessPolicy(currentUser) {
    const role = currentUser?.role;
    const isSuperAdmin = role === "SUPER_ADMIN";
    const me = String(currentUser?.userId ?? "");
    return {
        isSuperAdmin,
        addableRoles: isSuperAdmin ? ["ADMIN", "SUPER_ADMIN", "USER"] : role === "ADMIN" ? ["USER"] : [],
        canEdit: () => isSuperAdmin,
        canResetPassword: (row) =>
            isSuperAdmin || (role === "ADMIN" && row?.role === "USER" && String(row?.username) !== me),
        canResetSignature: () => isSuperAdmin,
        canRevoke: () => isSuperAdmin,
    };
}

/** Default permission flags form — matches the backend defaults (notifications opt-in). */
const EMPTY_PERMISSIONS_FORM = {
    canReceiveSrvCrit: "N",
    canReceiveSrvDeps: "N",
    canReceiveSrvRed: "N",
    canReceiveSrvSys: "N",
    isActive: "Y",
};

/** Reset Password dialog — same override rules as Add. */
const EMPTY_RESET_PW_FORM = {
    overrideEmail: "",
    overrideRequired: false,
};

/**
 * True when the dialog must collect an address: the profile has none for this
 * account (`emailOnFile === false`), or the server already answered 422 for it.
 * An unknown status (`null` — the lookup failed) shows no input; the server
 * decides, and a 422 flips `overrideRequired`.
 *
 * @param {{ emailOnFile?: boolean|null }|null} account
 * @param {{ overrideRequired: boolean }} form
 * @returns {boolean}
 */
export function needsOverrideEmail(account, form) {
    return account?.emailOnFile === false || form.overrideRequired === true;
}

/** True when an API error says the override email is the missing piece (422 EMAIL_REQUIRED). */
function isEmailRequiredError(err) {
    return err?.response?.status === 422 && (err.response.data?.error?.details ?? []).some((d) => d?.field === "overrideEmail");
}

/**
 * Toast for a temporary-password issue. A written account whose email failed
 * is NOT an error — the account exists and Reset Password recovers it — but the
 * operator must be told, so it is a warning rather than a success.
 *
 * @param {object} data - response `data` (TempPasswordIssue)
 * @param {string} message - server success message
 */
function announceTemporaryPassword(data, message) {
    if (data?.emailDelivered === false) {
        toast.warning("Account saved, but the email could not be sent. Use Reset Password to send a new temporary password.");
        return;
    }
    const where = data?.recipientHint ? ` Temporary password sent to ${data.recipientHint}.` : "";
    toast.success(`${message}${where}`);
}

/**
 * Core hook for the Admin Management feature.
 *
 * @returns {object} All state and handlers consumed by AdminManagement.view.jsx
 */
export const useAdminManagement = () => {
    // ── Server data ───────────────────────────────────────────────────────────
    const { data: admins, loading: listLoading, error: listError, refetch: refetchAdmins } = useRequest(CACHE_KEY, () => adminManagementApi.list().then((r) => r.data?.data ?? []), { staleTime: 30_000 });

    // ── Current user (SUPER_ADMIN gates) ─────────────────────────────────────
    const [currentUser, setCurrentUser] = useState(null);
    const policy = useMemo(() => accessPolicy(currentUser), [currentUser]);
    const [apiError, setApiError] = useState(null);
    useEffect(() => {
        let cancelled = false;
        AuthMiddleware.isAuth().then((u) => {
            if (!cancelled) setCurrentUser(u ?? null);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    // ── Search state (Add Admin modal) ────────────────────────────────────────
    const [searchQuery, setSearchQuery] = useState("");
    const [searchResults, setSearchResults] = useState([]);
    const [searchLoading, setSearchLoading] = useState(false);

    const { value: debouncedQuery, isPending: isDebouncing } = useDebounce(searchQuery, 600);

    /**
     * Guards against a stale search response overwriting a newer one. The
     * debounce only spaces requests out — it does not order their responses.
     * Typing "Jo", pausing past the 600 ms debounce, then continuing to "John"
     * puts two substring searches in flight; the broader "Jo" query is the
     * slower one, so it routinely lands LAST. The results list renders bare
     * `username — NAME` rows with no echo of the query that produced them, so
     * nothing on screen tells the operator the list no longer matches the box —
     * and picking the top row here grants ADMIN / SUPER_ADMIN rights to that account.
     *
     * @type {React.MutableRefObject<object|null>}
     */
    const searchFetchRef = useRef(null);

    /**
     * Execute an account search against the /search endpoint.
     * Called from the view when debouncedQuery changes.
     *
     * @param {string} q - Search term (username, first name, last name)
     * @returns {Promise<void>}
     */
    const executeSearch = useCallback(async (q) => {
        const term = typeof q === "string" ? q.trim() : "";
        if (!term) {
            searchFetchRef.current = null; // cancel any in-flight response
            setSearchResults([]);
            return;
        }
        setSearchLoading(true);

        const token = {};
        searchFetchRef.current = token;

        try {
            const res = await adminManagementApi.search(term);
            if (searchFetchRef.current !== token) return;
            setSearchResults(res.data?.data ?? []);
        } catch (err) {
            if (searchFetchRef.current !== token) return;
            setApiError(extractApiError(err, "Search failed."));
            setSearchResults([]);
        } finally {
            if (searchFetchRef.current === token) setSearchLoading(false);
        }
    }, []);

    /** Clear search state — used when closing any modal that uses the search. */
    const clearSearch = useCallback(() => {
        searchFetchRef.current = null; // discard any in-flight response
        setSearchQuery("");
        setSearchResults([]);
    }, []);

    // ── Modal state ───────────────────────────────────────────────────────────
    const [addModalOpen, setAddModalOpen] = useState(false);
    const [editModalOpen, setEditModalOpen] = useState(false);
    const [resetPwModalOpen, setResetPwModalOpen] = useState(false);
    const [resetSigModalOpen, setResetSigModalOpen] = useState(false);
    const [revokeModalOpen, setRevokeModalOpen] = useState(false);
    const [permissionsModalOpen, setPermissionsModalOpen] = useState(false);

    /** The admin record currently targeted by an edit / reset / delete action. */
    const [targetAdmin, setTargetAdmin] = useState(null);

    // ── Form state ────────────────────────────────────────────────────────────
    const [addForm, setAddForm] = useState(EMPTY_ADD_FORM);
    const [editForm, setEditForm] = useState(EMPTY_EDIT_FORM);
    const [permissionsForm, setPermissionsForm] = useState(EMPTY_PERMISSIONS_FORM);
    const [resetPwForm, setResetPwForm] = useState(EMPTY_RESET_PW_FORM);

    // ── Per-operation loading ─────────────────────────────────────────────────
    const [actionLoading, setActionLoading] = useState(false);

    // ── Add Admin modal handlers ──────────────────────────────────────────────

    /**
     * Open the Add Admin modal and reset form + search state.
     */
    const openAddModal = useCallback(() => {
        setApiError(null);
        // An ADMIN can only add USER accounts — start on the one role it may pick.
        setAddForm({ ...EMPTY_ADD_FORM, role: policy.addableRoles.includes("ADMIN") ? "ADMIN" : "USER" });
        clearSearch();
        setAddModalOpen(true);
    }, [clearSearch, policy]);

    /**
     * Close the Add Admin modal and reset form + search state.
     */
    const closeAddModal = useCallback(() => {
        setApiError(null);
        setAddModalOpen(false);
        setAddForm(EMPTY_ADD_FORM);
        clearSearch();
    }, [clearSearch]);

    /**
     * Update a single field in the Add Admin form.
     *
     * @param {string} field - Form field name
     * @param {*} value - New field value
     */
    const handleAddFormChange = useCallback((field, value) => {
        setAddForm((prev) => ({ ...prev, [field]: value }));
    }, []);

    /**
     * Select an account from search results and populate the Add Admin form.
     *
     * @param {{ username: string, firstName: string, lastName: string }} account
     */
    const selectAccount = useCallback((account) => {
        setAddForm((prev) => ({ ...prev, selectedAccount: account, overrideEmail: "", overrideRequired: false }));
        setSearchQuery(`${account.firstName ?? ""} ${account.lastName ?? ""}`.trim());
        setSearchResults([]);
    }, []);

    /**
     * Toggle a single permission flag in the Add Admin form's flags object.
     * Flips 'Y' → 'N' or 'N' → 'Y'.
     *
     * @param {string} flagName - e.g. 'canReceiveSrvCrit'
     */
    const handleAddFlagToggle = useCallback((flagName) => {
        setAddForm((prev) => ({
            ...prev,
            flags: {
                ...prev.flags,
                [flagName]: prev.flags[flagName] === "Y" ? "N" : "Y",
            },
        }));
    }, []);

    /**
     * Submit handler for the Add Admin modal.
     * Passes the chosen permission flags to the backend at creation time.
     *
     * @returns {Promise<boolean>} true on success
     */
    const submitAddAdmin = useCallback(async () => {
        if (!addForm.selectedAccount) {
            toast.warning("Please select an account from the search results.");
            return false;
        }
        if (!VALID_ROLES.includes(addForm.role)) {
            toast.warning("Please select a valid role.");
            return false;
        }
        if (!policy.addableRoles.includes(addForm.role)) {
            toast.warning("An Admin can only add User accounts. Ask a Super Admin to add other roles.");
            return false;
        }
        const needsEmail = needsOverrideEmail(addForm.selectedAccount, addForm);
        if (needsEmail && !addForm.overrideEmail.trim()) {
            toast.warning("Enter the email address the temporary password should be sent to.");
            return false;
        }

        setActionLoading(true);
        try {
            const res = await adminManagementApi.create({
                username: addForm.selectedAccount.username,
                role: addForm.role,
                flags: addForm.flags,
                ...(needsEmail ? { overrideEmail: addForm.overrideEmail.trim() } : {}),
            });
            announceTemporaryPassword(res.data?.data, res.data?.message || "Admin created successfully.");
            invalidateCache(CACHE_KEY);
            refetchAdmins();
            closeAddModal();
            return true;
        } catch (err) {
            if (isEmailRequiredError(err)) setAddForm((prev) => ({ ...prev, overrideRequired: true }));
            setApiError(extractApiError(err, "Failed to create admin."));
            return false;
        } finally {
            setActionLoading(false);
        }
    }, [addForm, closeAddModal, refetchAdmins, policy]);

    // ── Edit modal handlers ───────────────────────────────────────────────────

    /**
     * Open the Edit modal for the given admin record.
     *
     * @param {{ username: string, role: string }} admin
     */
    const openEditModal = useCallback((admin) => {
        setApiError(null);
        setTargetAdmin(admin);
        setEditForm({ role: admin.role });
        setEditModalOpen(true);
    }, []);

    /**
     * Close the Edit modal and reset form + target state.
     */
    const closeEditModal = useCallback(() => {
        setApiError(null);
        setEditModalOpen(false);
        setTargetAdmin(null);
        setEditForm(EMPTY_EDIT_FORM);
    }, []);

    /**
     * Update a single field in the Edit form.
     *
     * @param {string} field - Form field name
     * @param {*} value - New field value
     */
    const handleEditFormChange = useCallback((field, value) => {
        setEditForm((prev) => ({ ...prev, [field]: value }));
    }, []);

    /**
     * Submit handler for the Edit Admin modal (role change).
     *
     * @returns {Promise<boolean>}
     */
    const submitEditAdmin = useCallback(async () => {
        if (!VALID_ROLES.includes(editForm.role)) {
            toast.warning("Please select a valid role.");
            return false;
        }

        setActionLoading(true);
        try {
            const res = await adminManagementApi.update(targetAdmin.username, {
                role: editForm.role,
            });
            toast.success(res.data?.message || "Admin updated successfully.");
            invalidateCache(CACHE_KEY);
            refetchAdmins();
            closeEditModal();
            return true;
        } catch (err) {
            setApiError(extractApiError(err, "Failed to update admin."));
            return false;
        } finally {
            setActionLoading(false);
        }
    }, [editForm, targetAdmin, closeEditModal, refetchAdmins]);

    // ── Reset password handlers ───────────────────────────────────────────────

    /**
     * Open the Reset Password confirmation modal for the given admin.
     *
     * @param {{ username: string }} admin
     */
    const openResetPwModal = useCallback((admin) => {
        setApiError(null);
        setTargetAdmin(admin);
        setResetPwForm(EMPTY_RESET_PW_FORM);
        setResetPwModalOpen(true);
    }, []);

    /**
     * Close the Reset Password confirmation modal.
     */
    const closeResetPwModal = useCallback(() => {
        setApiError(null);
        setResetPwModalOpen(false);
        setTargetAdmin(null);
        setResetPwForm(EMPTY_RESET_PW_FORM);
    }, []);

    /**
     * Update the Reset Password dialog's override email.
     *
     * @param {string} value
     */
    const handleResetPwEmailChange = useCallback((value) => {
        setResetPwForm((prev) => ({ ...prev, overrideEmail: value }));
    }, []);

    /**
     * Issue and email a new temporary password for the targeted admin.
     *
     * @returns {Promise<boolean>}
     */
    const confirmResetPassword = useCallback(async () => {
        if (!targetAdmin) return false;
        const needsEmail = needsOverrideEmail(targetAdmin, resetPwForm);
        if (needsEmail && !resetPwForm.overrideEmail.trim()) {
            toast.warning("Enter the email address the temporary password should be sent to.");
            return false;
        }
        setActionLoading(true);
        try {
            const res = await adminManagementApi.resetPassword(targetAdmin.username, needsEmail ? { overrideEmail: resetPwForm.overrideEmail.trim() } : {});
            announceTemporaryPassword(res.data?.data, res.data?.message || "A new temporary password was issued.");
            invalidateCache(CACHE_KEY);
            refetchAdmins();
            closeResetPwModal();
            return true;
        } catch (err) {
            if (isEmailRequiredError(err)) setResetPwForm((prev) => ({ ...prev, overrideRequired: true }));
            setApiError(extractApiError(err, "Failed to reset password."));
            return false;
        } finally {
            setActionLoading(false);
        }
    }, [targetAdmin, resetPwForm, closeResetPwModal, refetchAdmins]);

    // ── Reset signature handlers ──────────────────────────────────────────────

    /**
     * Open the Reset Signature confirmation modal for the given admin.
     *
     * @param {{ username: string }} admin
     */
    const openResetSigModal = useCallback((admin) => {
        setApiError(null);
        setTargetAdmin(admin);
        setResetSigModalOpen(true);
    }, []);

    /**
     * Close the Reset Signature confirmation modal.
     */
    const closeResetSigModal = useCallback(() => {
        setApiError(null);
        setResetSigModalOpen(false);
        setTargetAdmin(null);
    }, []);

    /**
     * Confirm and execute the signature recomputation for the targeted admin.
     *
     * @returns {Promise<boolean>}
     */
    const confirmResetSignature = useCallback(async () => {
        if (!targetAdmin) return false;
        setActionLoading(true);
        try {
            const res = await adminManagementApi.resetSignature(targetAdmin.username);
            toast.success(res.data?.message || "Signature reset successfully.");
            invalidateCache(CACHE_KEY);
            refetchAdmins();
            closeResetSigModal();
            return true;
        } catch (err) {
            setApiError(extractApiError(err, "Failed to reset signature."));
            return false;
        } finally {
            setActionLoading(false);
        }
    }, [targetAdmin, closeResetSigModal, refetchAdmins]);

    // ── Revoke / Delete flow ──────────────────────────────────────────────────
    // Revoke (deactivate) is the PRIMARY, recommended action — it preserves the
    // account's audit trail. Delete Permanently is the SECONDARY action. Both
    // require the SAME mandatory backup download first (Step 1) — same idiom
    // as PurgeStepperModal Step 2.

    /** Step 1 = Backup, Step 2 = Choose Action, Step 3 = Processing/Result. */
    const [revokeStep, setRevokeStep] = useState(1);

    const [revokeBackupDownloading, setRevokeBackupDownloading] = useState(false);
    const [revokeBackupDownloaded, setRevokeBackupDownloaded] = useState(false);
    const [revokeBackupError, setRevokeBackupError] = useState(null);
    const [revokeBackupToken, setRevokeBackupToken] = useState(null);
    const [revokeBackupTokenExpiresAt, setRevokeBackupTokenExpiresAt] = useState(null);

    /** Which action is currently in flight / just completed — 'revoke' | 'delete' | null. */
    const [revokeIntent, setRevokeIntent] = useState(null);
    const [revokeActionLoading, setRevokeActionLoading] = useState(false);
    const [revokeActionError, setRevokeActionError] = useState(null);
    const [revokeActionResult, setRevokeActionResult] = useState(null);

    /**
     * Open the Revoke/Delete modal for the given admin.
     *
     * @param {{ username: string }} admin
     */
    const openRevokeModal = useCallback((admin) => {
        setApiError(null);
        setTargetAdmin(admin);
        setRevokeStep(1);
        setRevokeBackupDownloading(false);
        setRevokeBackupDownloaded(false);
        setRevokeBackupError(null);
        setRevokeBackupToken(null);
        setRevokeBackupTokenExpiresAt(null);
        setRevokeIntent(null);
        setRevokeActionLoading(false);
        setRevokeActionError(null);
        setRevokeActionResult(null);
        setRevokeModalOpen(true);
    }, []);

    /** Close the Revoke/Delete modal and reset all step state. Never closes mid-action. */
    const closeRevokeModal = useCallback(() => {
        if (revokeActionLoading) return;
        setApiError(null);
        setRevokeModalOpen(false);
        setTargetAdmin(null);
        setRevokeStep(1);
        setRevokeActionError(null);
    }, [revokeActionLoading]);

    /** Advance/rewind the Revoke/Delete stepper to an explicit step number. */
    const advanceRevokeStep = useCallback((step) => setRevokeStep(step), []);

    /**
     * Download the Access Control revoke backup archive (ENTITY-kind, scoped
     * to this one admin) and capture the backup token that authorises EITHER
     * `revoke` or `delete` below — one download covers both actions.
     *
     * @returns {Promise<void>}
     */
    const handleDownloadRevokeBackup = useCallback(async () => {
        if (!targetAdmin) return;
        setRevokeBackupDownloading(true);
        setRevokeBackupError(null);
        try {
            const res = await adminManagementApi.revokeBackup(targetAdmin.username);
            const token = res.headers["x-backup-token"];
            if (!token) throw new Error("Backup token missing from the server response.");
            const expiresAtHeader = res.headers["x-backup-token-expires-at"];
            const filename = parseRevokeBackupFilename(res.headers["content-disposition"], `revoke-backup_${targetAdmin.username}_${Date.now()}.zip`);

            downloadRevokeBackupBlob(res.data, filename);

            setRevokeBackupToken(token);
            setRevokeBackupTokenExpiresAt(expiresAtHeader ? Number(expiresAtHeader) : null);
            setRevokeBackupDownloaded(true);
            toast.success("Backup archive downloaded. Keep it safe — it contains credential material.");
        } catch (err) {
            const backendMsg = await extractRevokeBlobErrorMessage(err);
            const fallback = "Backup download failed. Access cannot be revoked or deleted without a completed backup.";
            setRevokeBackupError({ ...extractApiError(err, fallback), message: backendMsg ?? fallback });
        } finally {
            setRevokeBackupDownloading(false);
        }
    }, [targetAdmin]);

    /**
     * Revoke access (deactivate) — the PRIMARY action. Reuses the SAME
     * `revokeBackupToken` already downloaded.
     *
     * @returns {Promise<boolean>} true on success
     */
    const confirmRevokeAccess = useCallback(async () => {
        if (!targetAdmin || !revokeBackupToken) return false;
        setRevokeIntent("revoke");
        setRevokeStep(3);
        setRevokeActionLoading(true);
        setRevokeActionError(null);
        try {
            const res = await adminManagementApi.revoke(targetAdmin.username, revokeBackupToken);
            setRevokeActionResult({ intent: "revoke", username: targetAdmin.username });
            toast.success(res.data?.message || "Access revoked successfully.");
            invalidateCache(CACHE_KEY);
            refetchAdmins();
            return true;
        } catch (err) {
            setRevokeActionError(extractApiError(err, "Failed to revoke access."));
            setRevokeStep(2); // let the operator see the error and correct/retry
            return false;
        } finally {
            setRevokeActionLoading(false);
        }
    }, [targetAdmin, revokeBackupToken, refetchAdmins]);

    /**
     * Delete permanently — the SECONDARY action. On failure (e.g. 409
     * `LAST_ACTIVE_SUPER_ADMIN`) returns to Step 2 with the error shown.
     *
     * @returns {Promise<boolean>} true on success
     */
    const confirmDeletePermanently = useCallback(async () => {
        if (!targetAdmin || !revokeBackupToken) return false;
        setRevokeIntent("delete");
        setRevokeStep(3);
        setRevokeActionLoading(true);
        setRevokeActionError(null);
        try {
            const res = await adminManagementApi.remove(targetAdmin.username, revokeBackupToken);
            setRevokeActionResult({ intent: "delete", username: targetAdmin.username });
            toast.success(res.data?.message || "Admin permanently deleted.");
            invalidateCache(CACHE_KEY);
            refetchAdmins();
            return true;
        } catch (err) {
            setRevokeActionError(extractApiError(err, "Failed to delete admin."));
            setRevokeStep(2); // let the operator see the error and choose again
            return false;
        } finally {
            setRevokeActionLoading(false);
        }
    }, [targetAdmin, revokeBackupToken, refetchAdmins]);

    // ── Permissions modal handlers (SUPER_ADMIN only) ────────────────────────

    /**
     * Open the Permissions modal for the given admin, seeding form from the
     * admin row's flag columns returned by the list endpoint.
     *
     * @param {object} admin - enrichedAdmin row from the list endpoint
     */
    const openPermissionsModal = useCallback((admin) => {
        setApiError(null);
        setTargetAdmin(admin);
        setPermissionsForm({
            canReceiveSrvCrit: admin.canReceiveSrvCrit ?? "N",
            canReceiveSrvDeps: admin.canReceiveSrvDeps ?? "N",
            canReceiveSrvRed: admin.canReceiveSrvRed ?? "N",
            canReceiveSrvSys: admin.canReceiveSrvSys ?? "N",
            isActive: admin.isActive ?? "Y",
        });
        setPermissionsModalOpen(true);
    }, []);

    /**
     * Close the Permissions modal and reset target + form state.
     */
    const closePermissionsModal = useCallback(() => {
        setApiError(null);
        setPermissionsModalOpen(false);
        setTargetAdmin(null);
        setPermissionsForm(EMPTY_PERMISSIONS_FORM);
    }, []);

    /**
     * Toggle a single permission flag in the permissions form.
     * Accepts the flag name and flips 'Y' → 'N' or 'N' → 'Y'.
     *
     * @param {string} flagName - e.g. 'canReceiveSrvCrit'
     */
    const handlePermissionToggle = useCallback((flagName) => {
        setPermissionsForm((prev) => ({
            ...prev,
            [flagName]: prev[flagName] === "Y" ? "N" : "Y",
        }));
    }, []);

    /**
     * Submit handler for the Permissions modal (SUPER_ADMIN only).
     * Surfaces backend guard errors (e.g. last active Super Admin) inline.
     *
     * @returns {Promise<boolean>}
     */
    const submitPermissions = useCallback(async () => {
        if (!targetAdmin) return false;
        setActionLoading(true);
        try {
            const res = await adminManagementApi.updatePermissions(targetAdmin.username, permissionsForm);
            toast.success(res.data?.message || "Permissions updated successfully.");
            invalidateCache(CACHE_KEY);
            refetchAdmins();
            closePermissionsModal();
            return true;
        } catch (err) {
            // Backend guard and other 4xx errors — show message from backend
            setApiError(extractApiError(err, "Failed to update permissions."));
            return false;
        } finally {
            setActionLoading(false);
        }
    }, [targetAdmin, permissionsForm, refetchAdmins, closePermissionsModal]);

    // ── Derived rows ──────────────────────────────────────────────────────────
    const allAdmins = admins ?? [];

    return {
        // List
        admins: allAdmins,
        listLoading,
        listError,
        refetchAdmins,

        // Current user
        currentUser,
        policy,

        // Search
        searchQuery,
        setSearchQuery,
        debouncedQuery,
        executeSearch,
        searchResults,
        searchLoading,
        isDebouncing,

        // Add Admin
        addModalOpen,
        openAddModal,
        closeAddModal,
        addForm,
        handleAddFormChange,
        addNeedsEmail: needsOverrideEmail(addForm.selectedAccount, addForm),
        handleAddFlagToggle,
        selectAccount,
        submitAddAdmin,

        // Edit
        editModalOpen,
        openEditModal,
        closeEditModal,
        editForm,
        handleEditFormChange,
        submitEditAdmin,

        // Reset password
        resetPwModalOpen,
        openResetPwModal,
        closeResetPwModal,
        confirmResetPassword,
        resetPwForm,
        handleResetPwEmailChange,
        resetNeedsEmail: needsOverrideEmail(targetAdmin, resetPwForm),

        // Reset signature
        resetSigModalOpen,
        openResetSigModal,
        closeResetSigModal,
        confirmResetSignature,

        // Revoke / Delete flow
        revokeModalOpen,
        revokeStep,
        openRevokeModal,
        closeRevokeModal,
        advanceRevokeStep,

        revokeBackupDownloading,
        revokeBackupDownloaded,
        revokeBackupError,
        revokeBackupTokenExpiresAt,
        handleDownloadRevokeBackup,

        revokeIntent,
        revokeActionLoading,
        revokeActionError,
        revokeActionResult,
        confirmRevokeAccess,
        confirmDeletePermanently,

        // Permissions (SUPER_ADMIN only)
        permissionsModalOpen,
        openPermissionsModal,
        closePermissionsModal,
        permissionsForm,
        handlePermissionToggle,
        submitPermissions,

        // Shared
        targetAdmin,
        actionLoading,
        VALID_ROLES,

        // API error
        apiError,
        setApiError,
    };
};
