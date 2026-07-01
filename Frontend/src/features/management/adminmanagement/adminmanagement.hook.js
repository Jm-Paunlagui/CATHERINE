/**
 * adminmanagement.hook.js — Admin Management state and handlers.
 *
 * Business logic layer. Imports adminmanagement.api.js for HTTP calls.
 * Views import this hook — never the API file directly.
 *
 * State managed here:
 *   - Admin list (via useRequest for server-state caching)
 *   - Employee search results + debounce (shared between Add Admin + Add Robot modals)
 *   - Modal open/close states (add, addRobot, edit, reset-password, reset-sig, delete,
 *     permissions)
 *   - Form state for add, addRobot, edit, and permissions operations
 *   - Active tab ("admin" | "robot")
 *   - Current authenticated user (role check for SUPER_ADMIN gate)
 *   - Per-operation loading flags
 */

import { useCallback, useEffect, useState } from "react";
import { extractApiError, toast } from "../../../components/ui/toast.utils";
import useDebounce from "../../../hooks/useDebounce";
import { invalidateCache, useRequest } from "../../../hooks/useRequest";
import AuthMiddleware from "../../../middleware/authentication/AuthMiddleware";
import { adminManagementApi } from "./adminmanagement.api";

const CACHE_KEY = "admin-management/list";

/** Canonical set of valid EMP_ROLE values — kept in sync with backend VALID_ROLES. */
const VALID_ROLES = ["ADMIN", "SUPER_ADMIN", "APPROVER", "VIEWER", "ROBOT"];

/**
 * Default permission flags used when opening the Add Admin modal.
 * Mirrors the backend-documented defaults so what the creator sees
 * is exactly what will be stored if they do not change anything.
 */
const EMPTY_ADD_FLAGS = {
    canApproveReset: "Y",
    canRejectReset: "Y",
    canApproveBilling: "Y",
    canRejectBilling: "Y",
    canReceiveBilling: "N",
    canExportBilling: "Y",
    isActive: "Y",
};

const EMPTY_ADD_FORM = {
    selectedEmployee: null, // { USERID, FIRSTNAME, LASTNAME, ... }
    role: "ADMIN",
    retainPassword: true,
    newPassword: "",
    flags: { ...EMPTY_ADD_FLAGS },
};

const EMPTY_EDIT_FORM = {
    role: "ADMIN",
    changePassword: false,
    newPassword: "",
};

/**
 * Default permission flags form — matches the backend default ('Y' for all
 * except CAN_RECEIVE_BILLING which opt-in defaults to 'N').
 */
const EMPTY_PERMISSIONS_FORM = {
    canApproveReset: "Y",
    canRejectReset: "Y",
    canApproveBilling: "Y",
    canRejectBilling: "Y",
    canReceiveBilling: "N",
    canExportBilling: "Y",
    isActive: "Y",
};

/**
 * Empty form state for the Add Robot modal.
 * No `role` field — role is always hardcoded to "ROBOT" on submit.
 */
const EMPTY_ADD_ROBOT_FORM = {
    selectedEmployee: null, // { USERID, FIRSTNAME, LASTNAME, ... }
    retainPassword: true,
    newPassword: "",
};

/**
 * Core hook for the Admin Management feature.
 *
 * @returns {object} All state and handlers consumed by AdminManagement.view.jsx
 */
export const useAdminManagement = () => {
    // ── Server data ───────────────────────────────────────────────────────────
    const { data: admins, loading: listLoading, error: listError, refetch: refetchAdmins } = useRequest(CACHE_KEY, () => adminManagementApi.list().then((r) => r.data?.data ?? []), { staleTime: 30_000 });

    // ── Current user (for SUPER_ADMIN gate on Add Robot) ─────────────────────
    const [currentUser, setCurrentUser] = useState(null);

    useEffect(() => {
        let cancelled = false;
        AuthMiddleware.isAuth().then((u) => {
            if (!cancelled) setCurrentUser(u ?? null);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    // ── Tab state ─────────────────────────────────────────────────────────────
    const [activeTab, setActiveTab] = useState("admin");

    /**
     * Switch between the Admin and Robot tabs.
     *
     * @param {string} tabId - "admin" | "robot"
     */
    const handleTabChange = useCallback((tabId) => {
        setActiveTab(tabId);
    }, []);

    // ── Search state (shared between Add Admin + Add Robot modals) ────────────
    const [searchQuery, setSearchQuery] = useState("");
    const [searchResults, setSearchResults] = useState([]);
    const [searchLoading, setSearchLoading] = useState(false);

    // ── Inline API error state (replaces toast for form/modal actions) ─────────
    const [apiError, setApiError] = useState(null);

    const { value: debouncedQuery, isPending: isDebouncing } = useDebounce(searchQuery, 600);

    /**
     * Execute an employee search against the /search endpoint.
     * Called from the view when debouncedQuery changes.
     *
     * @param {string} q - Search term (employee ID, first name, last name)
     * @returns {Promise<void>}
     */
    const executeSearch = useCallback(async (q) => {
        const term = typeof q === "string" ? q.trim() : "";
        if (!term) {
            setSearchResults([]);
            return;
        }
        setSearchLoading(true);
        try {
            const res = await adminManagementApi.search(term);
            setSearchResults(res.data?.data ?? []);
        } catch (err) {
            setApiError(extractApiError(err, "Search failed."));
            setSearchResults([]);
        } finally {
            setSearchLoading(false);
        }
    }, []);

    /** Clear search state — used when closing any modal that uses the search. */
    const clearSearch = useCallback(() => {
        setSearchQuery("");
        setSearchResults([]);
    }, []);

    // ── Modal state ───────────────────────────────────────────────────────────
    const [addModalOpen, setAddModalOpen] = useState(false);
    const [addRobotModalOpen, setAddRobotModalOpen] = useState(false);
    const [editModalOpen, setEditModalOpen] = useState(false);
    const [resetPwModalOpen, setResetPwModalOpen] = useState(false);
    const [resetSigModalOpen, setResetSigModalOpen] = useState(false);
    const [deleteModalOpen, setDeleteModalOpen] = useState(false);
    const [permissionsModalOpen, setPermissionsModalOpen] = useState(false);

    /** The admin record currently targeted by an edit / reset / delete action. */
    const [targetAdmin, setTargetAdmin] = useState(null);

    // ── Form state ────────────────────────────────────────────────────────────
    const [addForm, setAddForm] = useState(EMPTY_ADD_FORM);
    const [addRobotForm, setAddRobotForm] = useState(EMPTY_ADD_ROBOT_FORM);
    const [editForm, setEditForm] = useState(EMPTY_EDIT_FORM);
    const [permissionsForm, setPermissionsForm] = useState(EMPTY_PERMISSIONS_FORM);

    // ── Per-operation loading ─────────────────────────────────────────────────
    const [actionLoading, setActionLoading] = useState(false);

    // ── Add Admin modal handlers ──────────────────────────────────────────────

    /**
     * Open the Add Admin modal and reset form + search state.
     */
    const openAddModal = useCallback(() => {
        setAddForm(EMPTY_ADD_FORM);
        clearSearch();
        setApiError(null);
        setAddModalOpen(true);
    }, [clearSearch]);

    /**
     * Close the Add Admin modal and reset form + search state.
     */
    const closeAddModal = useCallback(() => {
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
     * Select an employee from search results and populate the Add Admin form.
     *
     * @param {{ USERID: string, FIRSTNAME: string, LASTNAME: string }} employee
     */
    const selectEmployee = useCallback((employee) => {
        setAddForm((prev) => ({ ...prev, selectedEmployee: employee }));
        setSearchQuery(`${employee.FIRSTNAME ?? ""} ${employee.LASTNAME ?? ""}`.trim());
        setSearchResults([]);
    }, []);

    /**
     * Toggle a single permission flag in the Add Admin form's flags object.
     * Flips 'Y' → 'N' or 'N' → 'Y'.
     *
     * @param {string} flagName - e.g. 'canApproveReset'
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
     * Validates role is not ROBOT (ROBOT accounts belong in the Robot tab).
     * Passes the chosen permission flags to the backend at creation time.
     *
     * @returns {Promise<boolean>} true on success
     */
    const submitAddAdmin = useCallback(async () => {
        if (!addForm.selectedEmployee) {
            toast.error("Please select an employee from the search results.");
            return false;
        }
        if (!VALID_ROLES.includes(addForm.role)) {
            toast.error("Please select a valid role.");
            return false;
        }
        if (addForm.role === "ROBOT") {
            toast.error("Use the Robot tab to add Robot accounts.");
            return false;
        }
        if (!addForm.retainPassword && !addForm.newPassword.trim()) {
            toast.error("A password is required when not using the default password.");
            return false;
        }

        setActionLoading(true);
        try {
            const res = await adminManagementApi.create({
                empId: addForm.selectedEmployee.USERID,
                role: addForm.role,
                retainPassword: addForm.retainPassword,
                newPassword: addForm.retainPassword ? undefined : addForm.newPassword,
                flags: addForm.flags,
            });
            toast.success(res.data?.message || "Admin created successfully.");
            invalidateCache(CACHE_KEY);
            refetchAdmins();
            closeAddModal();
            return true;
        } catch (err) {
            setApiError(extractApiError(err, "Failed to create admin."));
            return false;
        } finally {
            setActionLoading(false);
        }
    }, [addForm, closeAddModal, refetchAdmins]);

    // ── Add Robot modal handlers ──────────────────────────────────────────────

    /**
     * Open the Add Robot modal and reset form + search state.
     */
    const openAddRobotModal = useCallback(() => {
        setAddRobotForm(EMPTY_ADD_ROBOT_FORM);
        clearSearch();
        setApiError(null);
        setAddRobotModalOpen(true);
    }, [clearSearch]);

    /**
     * Close the Add Robot modal and reset form + search state.
     */
    const closeAddRobotModal = useCallback(() => {
        setAddRobotModalOpen(false);
        setAddRobotForm(EMPTY_ADD_ROBOT_FORM);
        clearSearch();
    }, [clearSearch]);

    /**
     * Update a single field in the Add Robot form.
     *
     * @param {string} field - Form field name
     * @param {*} value - New field value
     */
    const handleAddRobotFormChange = useCallback((field, value) => {
        setAddRobotForm((prev) => ({ ...prev, [field]: value }));
    }, []);

    /**
     * Select an employee from search results and populate the Add Robot form.
     *
     * @param {{ USERID: string, FIRSTNAME: string, LASTNAME: string }} employee
     */
    const selectRobotEmployee = useCallback((employee) => {
        setAddRobotForm((prev) => ({ ...prev, selectedEmployee: employee }));
        setSearchQuery(`${employee.FIRSTNAME ?? ""} ${employee.LASTNAME ?? ""}`.trim());
        setSearchResults([]);
    }, []);

    /**
     * Submit handler for the Add Robot modal.
     * Role is always hardcoded to "ROBOT" — no role selector in the form.
     *
     * @returns {Promise<boolean>} true on success
     */
    const submitAddRobot = useCallback(async () => {
        if (!addRobotForm.selectedEmployee) {
            toast.error("Please select an employee from the search results.");
            return false;
        }
        if (!addRobotForm.retainPassword && !addRobotForm.newPassword.trim()) {
            toast.error("A password is required when not using the default password.");
            return false;
        }

        setActionLoading(true);
        try {
            const res = await adminManagementApi.create({
                empId: addRobotForm.selectedEmployee.USERID,
                role: "ROBOT",
                retainPassword: addRobotForm.retainPassword,
                newPassword: addRobotForm.retainPassword ? undefined : addRobotForm.newPassword,
            });
            toast.success(res.data?.message || "Robot account created successfully.");
            invalidateCache(CACHE_KEY);
            refetchAdmins();
            closeAddRobotModal();
            return true;
        } catch (err) {
            setApiError(extractApiError(err, "Failed to create robot account."));
            return false;
        } finally {
            setActionLoading(false);
        }
    }, [addRobotForm, closeAddRobotModal, refetchAdmins]);

    // ── Edit modal handlers ───────────────────────────────────────────────────

    /**
     * Open the Edit modal for the given admin record.
     *
     * @param {{ empId: string, empRole: string }} admin
     */
    const openEditModal = useCallback((admin) => {
        setTargetAdmin(admin);
        setEditForm({ role: admin.empRole, changePassword: false, newPassword: "" });
        setApiError(null);
        setEditModalOpen(true);
    }, []);

    /**
     * Close the Edit modal and reset form + target state.
     */
    const closeEditModal = useCallback(() => {
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
     * Submit handler for the Edit Admin modal.
     * Prevents ROBOT role from being assigned through the Admin edit flow.
     *
     * @returns {Promise<boolean>}
     */
    const submitEditAdmin = useCallback(async () => {
        if (!VALID_ROLES.includes(editForm.role)) {
            toast.error("Please select a valid role.");
            return false;
        }
        if (editForm.role === "ROBOT") {
            toast.error("Robot role can only be assigned from the Robot tab.");
            return false;
        }
        if (editForm.changePassword && !editForm.newPassword.trim()) {
            toast.error("A new password is required when changing the password.");
            return false;
        }

        setActionLoading(true);
        try {
            const res = await adminManagementApi.update(targetAdmin.empId, {
                role: editForm.role,
                changePassword: editForm.changePassword,
                newPassword: editForm.changePassword ? editForm.newPassword : undefined,
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
     * @param {{ empId: string }} admin
     */
    const openResetPwModal = useCallback((admin) => {
        setTargetAdmin(admin);
        setApiError(null);
        setResetPwModalOpen(true);
    }, []);

    /**
     * Close the Reset Password confirmation modal.
     */
    const closeResetPwModal = useCallback(() => {
        setResetPwModalOpen(false);
        setTargetAdmin(null);
    }, []);

    /**
     * Confirm and execute the password reset for the targeted admin.
     *
     * @returns {Promise<boolean>}
     */
    const confirmResetPassword = useCallback(async () => {
        if (!targetAdmin) return false;
        setActionLoading(true);
        try {
            const res = await adminManagementApi.resetPassword(targetAdmin.empId);
            toast.success(res.data?.message || "Password reset to default.");
            invalidateCache(CACHE_KEY);
            refetchAdmins();
            closeResetPwModal();
            return true;
        } catch (err) {
            setApiError(extractApiError(err, "Failed to reset password."));
            return false;
        } finally {
            setActionLoading(false);
        }
    }, [targetAdmin, closeResetPwModal, refetchAdmins]);

    // ── Reset signature handlers ──────────────────────────────────────────────

    /**
     * Open the Reset Signature confirmation modal for the given admin.
     *
     * @param {{ empId: string }} admin
     */
    const openResetSigModal = useCallback((admin) => {
        setTargetAdmin(admin);
        setApiError(null);
        setResetSigModalOpen(true);
    }, []);

    /**
     * Close the Reset Signature confirmation modal.
     */
    const closeResetSigModal = useCallback(() => {
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
            const res = await adminManagementApi.resetSignature(targetAdmin.empId);
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

    // ── Delete handlers ───────────────────────────────────────────────────────

    /**
     * Open the Delete confirmation modal for the given admin.
     *
     * @param {{ empId: string }} admin
     */
    const openDeleteModal = useCallback((admin) => {
        setTargetAdmin(admin);
        setApiError(null);
        setDeleteModalOpen(true);
    }, []);

    /**
     * Close the Delete confirmation modal.
     */
    const closeDeleteModal = useCallback(() => {
        setDeleteModalOpen(false);
        setTargetAdmin(null);
    }, []);

    /**
     * Confirm and execute the deletion of the targeted admin.
     *
     * @returns {Promise<boolean>}
     */
    const confirmDelete = useCallback(async () => {
        if (!targetAdmin) return false;
        setActionLoading(true);
        try {
            const res = await adminManagementApi.remove(targetAdmin.empId);
            toast.success(res.data?.message || "Admin removed successfully.");
            invalidateCache(CACHE_KEY);
            refetchAdmins();
            closeDeleteModal();
            return true;
        } catch (err) {
            toast.error(err.response?.data?.message || "Failed to remove admin.");
            return false;
        } finally {
            setActionLoading(false);
        }
    }, [targetAdmin, closeDeleteModal, refetchAdmins]);

    // ── Permissions modal handlers (SUPER_ADMIN only) ────────────────────────

    /**
     * Open the Permissions modal for the given admin, seeding form from the
     * admin row's flag columns returned by the list endpoint.
     *
     * @param {object} admin - enrichedAdmin row from the list endpoint
     */
    const openPermissionsModal = useCallback((admin) => {
        setTargetAdmin(admin);
        setApiError(null);
        setPermissionsForm({
            canApproveReset: admin.canApproveReset ?? "Y",
            canRejectReset: admin.canRejectReset ?? "Y",
            canApproveBilling: admin.canApproveBilling ?? "Y",
            canRejectBilling: admin.canRejectBilling ?? "Y",
            canReceiveBilling: admin.canReceiveBilling ?? "N",
            canExportBilling: admin.canExportBilling ?? "Y",
            isActive: admin.isActive ?? "Y",
        });
        setPermissionsModalOpen(true);
    }, []);

    /**
     * Close the Permissions modal and reset target + form state.
     */
    const closePermissionsModal = useCallback(() => {
        setPermissionsModalOpen(false);
        setTargetAdmin(null);
        setPermissionsForm(EMPTY_PERMISSIONS_FORM);
    }, []);

    /**
     * Toggle a single permission flag in the permissions form.
     * Accepts the flag name and flips 'Y' → 'N' or 'N' → 'Y'.
     *
     * @param {string} flagName - e.g. 'canApproveReset'
     */
    const handlePermissionToggle = useCallback((flagName) => {
        setPermissionsForm((prev) => ({
            ...prev,
            [flagName]: prev[flagName] === "Y" ? "N" : "Y",
        }));
    }, []);

    /**
     * Submit handler for the Permissions modal (SUPER_ADMIN only).
     * Surfaces the zero-approver-guard error as a toast if the backend rejects.
     *
     * @returns {Promise<boolean>}
     */
    const submitPermissions = useCallback(async () => {
        if (!targetAdmin) return false;
        setActionLoading(true);
        try {
            const res = await adminManagementApi.updatePermissions(targetAdmin.empId, permissionsForm);
            toast.success(res.data?.message || "Permissions updated successfully.");
            invalidateCache(CACHE_KEY);
            refetchAdmins();
            closePermissionsModal();
            return true;
        } catch (err) {
            // Zero-approver guard and other 4xx errors — show message from backend
            toast.error(err.response?.data?.message || "Failed to update permissions.");
            return false;
        } finally {
            setActionLoading(false);
        }
    }, [targetAdmin, permissionsForm, refetchAdmins, closePermissionsModal]);

    // ── Derived rows ──────────────────────────────────────────────────────────
    const allAdmins = admins ?? [];
    const adminRows = allAdmins.filter((a) => a.empRole !== "ROBOT");
    const robotRows = allAdmins.filter((a) => a.empRole === "ROBOT");

    return {
        // List
        admins: allAdmins,
        adminRows,
        robotRows,
        listLoading,
        listError,
        refetchAdmins,

        // Tab
        activeTab,
        handleTabChange,

        // Current user
        currentUser,

        // Search (shared)
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
        handleAddFlagToggle,
        selectEmployee,
        submitAddAdmin,

        // Add Robot
        addRobotModalOpen,
        openAddRobotModal,
        closeAddRobotModal,
        addRobotForm,
        handleAddRobotFormChange,
        selectRobotEmployee,
        submitAddRobot,

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

        // Reset signature
        resetSigModalOpen,
        openResetSigModal,
        closeResetSigModal,
        confirmResetSignature,

        // Delete
        deleteModalOpen,
        openDeleteModal,
        closeDeleteModal,
        confirmDelete,

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

        // Inline API error
        apiError,
        setApiError,
    };
};
