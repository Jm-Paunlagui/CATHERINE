/**
 * AdminManagement.view.jsx — Admin Management feature view.
 *
 * Presentation layer only. Imports useAdminManagement hook and Aumovio
 * components. Never imports adminmanagement.api.js directly.
 *
 * Layout:
 *   - Page header (title + description; no top-level CTA button)
 *   - Tab nav strip: "Admin" | "Robot"
 *
 *   Admin tab:
 *     - "Add Admin" button + record count Badge
 *     - Admin table (Employee ID, Name, Role badge, Signature badge, Actions)
 *
 *   Robot tab:
 *     - "Add Robot" button (SUPER_ADMIN only) + record count Badge
 *     - Robot table (Employee ID, Name, Signature badge, Actions — no Role column)
 *     - Empty state with SUPER_ADMIN note
 *
 *   Modals:
 *     - Add Admin modal (employee search → role/password form)
 *     - Add Robot modal (employee search → password form; role hardcoded to ROBOT)
 *     - Edit modal (role + optional password change; role hidden for ROBOT accounts)
 *     - Reset Password confirmation modal
 *     - Reset Signature confirmation modal
 *     - Delete confirmation modal
 *
 * Wrapped in ErrorBoundary.
 */

import { ArrowPathIcon, CpuChipIcon, KeyIcon, MagnifyingGlassIcon, PencilIcon, ShieldCheckIcon, TrashIcon, UserGroupIcon, UserPlusIcon } from "@heroicons/react/24/outline";
import { useEffect } from "react";
import { ANIMATE_ENTER_UP, ANIMATE_PAGE_ENTER, HOVER_LIFT_SM, TRANSITION_COLORS, TRANSITION_SMOOTH, staggerDelay } from "../../../assets/styles/pre-set-styles";
import ErrorBoundary from "../../../components/feedback/ErrorBoundary";
import { Input } from "../../../components/forms/Input";
import { Select } from "../../../components/forms/Select";
import { Badge } from "../../../components/ui/Badge";
import Button from "../../../components/ui/Button";
import { Modal } from "../../../components/ui/Modal";
import Skeleton from "../../../components/ui/Skeleton";
import { Table } from "../../../components/ui/Table";
import { Tooltip } from "../../../components/ui/Tooltip";
import { useAdminManagement } from "./adminmanagement.hook";
import { PermissionFlagsFieldset } from "./components/PermissionFlagsFieldset";
import { PermissionCluster } from "./components/PermissionCluster";

// ─── Tab definitions ──────────────────────────────────────────────────────────

const TABS = [
    { id: "admin", label: "Admin", Icon: UserGroupIcon },
    { id: "robot", label: "Robot", Icon: CpuChipIcon },
];

// ─── Role options for Select (Admin tab only — no ROBOT option) ───────────────

const ROLE_OPTIONS = [
    { value: "ADMIN", label: "Admin" },
    { value: "SUPER_ADMIN", label: "Super Admin" },
    { value: "APPROVER", label: "Approver" },
    { value: "VIEWER", label: "Viewer" },
];

/** Role options for the Edit modal (same exclusion — no ROBOT). */
const EDIT_ROLE_OPTIONS = ROLE_OPTIONS;

const ROLE_BADGE_VARIANTS = {
    SUPER_ADMIN: "purple",
    ADMIN: "orange",
    APPROVER: "blue",
    VIEWER: "grey",
    ROBOT: "green",
};

// ─── Table column definitions ─────────────────────────────────────────────────

/**
 * Build column definitions for the Admin table.
 *
 * @param {Function} onEdit
 * @param {Function} onResetPw
 * @param {Function} onResetSig
 * @param {Function} onDelete
 * @param {Function|null} onPermissions - null when caller is not SUPER_ADMIN; cluster is still shown read-only
 * @returns {Array}
 */
function buildColumns(onEdit, onResetPw, onResetSig, onDelete, onPermissions) {
    return [
        {
            key: "empId",
            label: "Employee ID",
            sortable: true,
        },
        {
            key: "name",
            label: "Name",
            render: (row) => (
                <span className={row.isActive === "N" ? "opacity-45" : ""}>
                    {row.firstName || row.lastName
                        ? `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim()
                        : <span className="text-grey-400 italic text-xs">Not in HRIS</span>}
                </span>
            ),
        },
        {
            key: "empRole",
            label: "Role",
            render: (row) => (
                <Badge variant={row.isActive === "N" ? "grey" : (ROLE_BADGE_VARIANTS[row.empRole] ?? "grey")} pill>
                    {row.empRole?.replace("_", " ") ?? "—"}
                </Badge>
            ),
        },
        {
            key: "isActive",
            label: "Status",
            render: (row) =>
                row.isActive === "N" ? (
                    <Badge variant="red" dot>Inactive</Badge>
                ) : (
                    <Badge variant="green" dot>Active</Badge>
                ),
        },
        {
            key: "permissions",
            label: "Permissions",
            render: (row) => (
                <PermissionCluster
                    row={row}
                    onClick={onPermissions ? () => onPermissions(row) : undefined}
                />
            ),
        },
        {
            key: "signatureValid",
            label: "Integrity",
            render: (row) =>
                row.signatureValid ? (
                    <Badge variant="green" dot>
                        Valid
                    </Badge>
                ) : (
                    <Badge variant="red" dot>
                        Tampered
                    </Badge>
                ),
        },
        {
            key: "updatedAt",
            label: "Last Updated",
            render: (row) =>
                row.updatedAt ? (
                    <Tooltip content={`By: ${row.updatedBy ?? "system"}`} placement="top">
                        <span className="text-xs text-grey-500 dark:text-grey-400 cursor-default">
                            {new Date(row.updatedAt).toLocaleDateString()}
                        </span>
                    </Tooltip>
                ) : (
                    <span className="text-xs text-grey-300 dark:text-grey-600">—</span>
                ),
        },
        {
            key: "actions",
            label: "Actions",
            render: (row) => (
                <div className="flex items-center gap-1.5">
                    <Button size="xs" variant="ghost" leftIcon={PencilIcon} onClick={() => onEdit(row)} aria-label={`Edit ${row.empId}`} />
                    <Button size="xs" variant="warning" leftIcon={ShieldCheckIcon} onClick={() => onResetPw(row)} aria-label={`Reset password for ${row.empId}`} />
                    {!row.signatureValid && <Button size="xs" variant="accent" leftIcon={ArrowPathIcon} onClick={() => onResetSig(row)} aria-label={`Reset signature for ${row.empId}`} />}
                    {onPermissions && (
                        <Button size="xs" variant="ghost" leftIcon={KeyIcon} onClick={() => onPermissions(row)} aria-label={`Edit permissions for ${row.empId}`} />
                    )}
                    <Button size="xs" variant="danger" leftIcon={TrashIcon} onClick={() => onDelete(row)} aria-label={`Remove ${row.empId}`} />
                </div>
            ),
        },
    ];
}

/**
 * Build column definitions for the Robot table.
 * Role column is omitted — all robots share the same ROBOT role.
 * Permissions cluster is shown for all rows; click to edit requires SUPER_ADMIN.
 *
 * @param {Function} onEdit
 * @param {Function} onResetPw
 * @param {Function} onResetSig
 * @param {Function} onDelete
 * @param {Function|null} onPermissions - null when caller is not SUPER_ADMIN; cluster is still shown read-only
 * @returns {Array}
 */
function buildRobotColumns(onEdit, onResetPw, onResetSig, onDelete, onPermissions) {
    return [
        {
            key: "empId",
            label: "Employee ID",
            sortable: true,
        },
        {
            key: "name",
            label: "Name",
            render: (row) => (row.firstName || row.lastName ? `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() : <span className="text-grey-400 italic text-xs">Not in HRIS</span>),
        },
        {
            key: "permissions",
            label: "Permissions",
            render: (row) => (
                <PermissionCluster
                    row={row}
                    onClick={onPermissions ? () => onPermissions(row) : undefined}
                />
            ),
        },
        {
            key: "signatureValid",
            label: "Integrity",
            render: (row) =>
                row.signatureValid ? (
                    <Badge variant="green" dot>
                        Valid
                    </Badge>
                ) : (
                    <Badge variant="red" dot>
                        Tampered
                    </Badge>
                ),
        },
        {
            key: "actions",
            label: "Actions",
            render: (row) => (
                <div className="flex items-center gap-1.5">
                    <Button size="xs" variant="ghost" leftIcon={PencilIcon} onClick={() => onEdit(row)} aria-label={`Edit robot ${row.empId}`} />
                    <Button size="xs" variant="warning" leftIcon={ShieldCheckIcon} onClick={() => onResetPw(row)} aria-label={`Reset password for robot ${row.empId}`} />
                    {!row.signatureValid && <Button size="xs" variant="accent" leftIcon={ArrowPathIcon} onClick={() => onResetSig(row)} aria-label={`Reset signature for robot ${row.empId}`} />}
                    {onPermissions && (
                        <Button size="xs" variant="ghost" leftIcon={KeyIcon} onClick={() => onPermissions(row)} aria-label={`Edit permissions for robot ${row.empId}`} />
                    )}
                    <Button size="xs" variant="danger" leftIcon={TrashIcon} onClick={() => onDelete(row)} aria-label={`Remove robot ${row.empId}`} />
                </div>
            ),
        },
    ];
}

// ─── Employee Search UI (shared between Add Admin + Add Robot modals) ─────────

/**
 * Reusable employee search section used inside both Add Admin and Add Robot modals.
 *
 * @param {{
 *   searchQuery: string,
 *   setSearchQuery: Function,
 *   debouncedQuery: string,
 *   searchResults: Array,
 *   searchLoading: boolean,
 *   isDebouncing: boolean,
 *   onSelect: Function,
 *   onClear: Function,
 *   selectedEmployee: object|null,
 * }} props
 */
function EmployeeSearchSection({ searchQuery, setSearchQuery, debouncedQuery, searchResults, searchLoading, isDebouncing, onSelect, onClear, selectedEmployee }) {
    return (
        <>
            {!selectedEmployee && (
                <>
                    <Input
                        label="Search Employee"
                        placeholder="Type employee ID, first or last name…"
                        value={searchQuery}
                        onChange={(e) => {
                            setSearchQuery(e.target.value);
                            if (!e.target.value) onClear();
                        }}
                        leftIcon={MagnifyingGlassIcon}
                        required
                    />

                    {(searchLoading || (isDebouncing && searchQuery)) && <p className="text-xs text-grey-400 dark:text-grey-500 pl-1">{searchLoading ? "Searching…" : "Typing…"}</p>}

                    {!searchLoading && !isDebouncing && searchResults.length > 0 && (
                        <ul className="border rounded-xl divide-y divide-grey-100 dark:divide-grey-700 overflow-hidden border-grey-200 dark:border-grey-700 max-h-48 overflow-y-auto">
                            {searchResults.map((emp, idx) => (
                                <li key={`${emp.USERID}-${idx}`} className={`px-4 py-2.5 cursor-pointer flex items-center justify-between text-sm hover:bg-orange-400/8 dark:hover:bg-orange-400/15 ${TRANSITION_SMOOTH}`} onClick={() => onSelect(emp)} role="option" aria-selected={false}>
                                    <span className="font-aumovio text-black/80 dark:text-white/80">
                                        {emp.USERID} — {emp.FIRSTNAME} {emp.LASTNAME}
                                    </span>
                                    {emp.isAdmin && (
                                        <Badge variant="purple" size="xs">
                                            Already admin
                                        </Badge>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}

                    {!searchLoading && !isDebouncing && debouncedQuery.trim() && searchResults.length === 0 && <p className="text-xs text-black/40 dark:text-white/40 pl-1 italic">No employees found for "{debouncedQuery.trim()}".</p>}

                    {!searchQuery && <p className="text-xs text-black/40 dark:text-white/40 pl-1">Start typing to search for an employee by ID, first name, or last name.</p>}
                </>
            )}

            {selectedEmployee && (
                <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-success-100/40 dark:bg-success-400/10 border border-success-400/30">
                    <ShieldCheckIcon className="w-5 h-5 text-success-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-aumovio-bold text-black/80 dark:text-white/80 truncate">
                            {selectedEmployee.FIRSTNAME} {selectedEmployee.LASTNAME}
                        </p>
                        <p className="text-xs text-black/50 dark:text-white/50">{selectedEmployee.USERID}</p>
                    </div>
                    <Button size="xs" variant="ghost" onClick={onClear} aria-label="Clear selected employee">
                        Change
                    </Button>
                </div>
            )}
        </>
    );
}

// ─── View ─────────────────────────────────────────────────────────────────────

function AdminManagementView() {
    const hook = useAdminManagement();

    // Trigger search when debounced query changes (fires for both open modals)
    useEffect(() => {
        if (hook.addModalOpen || hook.addRobotModalOpen) {
            hook.executeSearch(hook.debouncedQuery);
        }
    }, [hook.debouncedQuery, hook.addModalOpen, hook.addRobotModalOpen, hook.executeSearch]);

    const isSuperAdmin = hook.currentUser?.role === "SUPER_ADMIN";

    const columns = buildColumns(
        hook.openEditModal,
        hook.openResetPwModal,
        hook.openResetSigModal,
        hook.openDeleteModal,
        isSuperAdmin ? hook.openPermissionsModal : null,
    );
    const robotColumns = buildRobotColumns(
        hook.openEditModal,
        hook.openResetPwModal,
        hook.openResetSigModal,
        hook.openDeleteModal,
        isSuperAdmin ? hook.openPermissionsModal : null,
    );

    // Normalise rows so Table's id lookup works.
    // Inactive admins are visually muted via row-level className passed to Table.
    const adminTableData = hook.adminRows.map((a) => ({
        ...a,
        id: a.empId,
        _rowClassName: a.isActive === "N" ? "opacity-50" : "",
    }));
    const robotTableData = hook.robotRows.map((a) => ({ ...a, id: a.empId }));

    return (
        <div className={`p-6 flex flex-col gap-6 h-full ${ANIMATE_PAGE_ENTER}`}>
            {/* ── Header ──────────────────────────────────────────────────── */}
            <div className="flex flex-col gap-1">
                <h1 className="text-xl font-aumovio-bold text-black dark:text-white tracking-tight">Admin Management</h1>
                <p className="text-sm text-black/60 dark:text-white/60">Manage who has administrative access to this system, including automation robot accounts.</p>
            </div>

            {/* ── Error state ──────────────────────────────────────────────── */}
            {hook.listError && !hook.listLoading && <div className="p-4 rounded-xl border border-danger-400/30 bg-danger-100 dark:bg-danger-400/10 text-danger-400 text-sm font-aumovio">Failed to load admin list. Please refresh the page.</div>}

            {/* ── Tab nav strip ────────────────────────────────────────────── */}
            <div className="flex gap-1 p-1 bg-grey-100 dark:bg-(--bg-surface-3) rounded-xl w-fit font-aumovio">
                {TABS.map((tab) => {
                    const isActive = hook.activeTab === tab.id;
                    return (
                        <button
                            key={tab.id}
                            type="button"
                            onClick={() => hook.handleTabChange(tab.id)}
                            className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-aumovio-bold
                                ${TRANSITION_COLORS}
                                ${isActive ? "bg-(--bg-surface) dark:bg-(--bg-surface-2) text-(--accent-foreground) shadow-sm" : "text-grey-500 hover:text-(--accent-foreground)"}`}
                        >
                            <tab.Icon className="w-4 h-4 shrink-0" />
                            {tab.label}
                        </button>
                    );
                })}
            </div>

            {/* ──────────────────────────────────────────────────────────────
                ADMIN TAB
            ────────────────────────────────────────────────────────────── */}
            {hook.activeTab === "admin" && (
                <div className="flex flex-col gap-4 flex-1 min-h-0">
                    {/* Tab toolbar */}
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-aumovio-bold text-black/70 dark:text-white/70">Admin Accounts</span>
                            {!hook.listLoading && (
                                <Badge variant="grey" pill size="sm">
                                    {hook.adminRows.length}
                                </Badge>
                            )}
                        </div>
                        <Button variant="primary" leftIcon={UserPlusIcon} onClick={hook.openAddModal}>
                            Add Admin
                        </Button>
                    </div>

                    {/* Table */}
                    <div className="flex-1 min-h-0">
                        {hook.listLoading ? (
                            <Skeleton variant="table" rows={5} />
                        ) : (
                            <>
                                {adminTableData.map((row, i) => (
                                    <span key={row.id} className={`${ANIMATE_ENTER_UP} ${staggerDelay(i)} ${TRANSITION_SMOOTH} ${HOVER_LIFT_SM} hidden`} />
                                ))}
                                <Table columns={columns} data={adminTableData} loading={false} emptyText="No admins found. Click 'Add Admin' to create the first one." stickyHeader striped compact />
                            </>
                        )}
                    </div>
                </div>
            )}

            {/* ──────────────────────────────────────────────────────────────
                ROBOT TAB
            ────────────────────────────────────────────────────────────── */}
            {hook.activeTab === "robot" && (
                <div className="flex flex-col gap-4 flex-1 min-h-0">
                    {/* Tab toolbar */}
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-aumovio-bold text-black/70 dark:text-white/70">Robot Accounts</span>
                            {!hook.listLoading && (
                                <Badge variant="grey" pill size="sm">
                                    {hook.robotRows.length}
                                </Badge>
                            )}
                        </div>
                        {isSuperAdmin && (
                            <Button variant="primary" leftIcon={CpuChipIcon} onClick={hook.openAddRobotModal}>
                                Add Robot
                            </Button>
                        )}
                    </div>

                    {/* Table */}
                    <div className="flex-1 min-h-0">
                        {hook.listLoading ? (
                            <Skeleton variant="table" rows={5} />
                        ) : robotTableData.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
                                <CpuChipIcon className="w-10 h-10 text-grey-300 dark:text-grey-600" />
                                <p className="text-sm font-aumovio-bold text-black/50 dark:text-white/50">No robot accounts found.</p>
                                <p className="text-xs text-black/35 dark:text-white/35">Only SUPER_ADMIN can add robot accounts.</p>
                            </div>
                        ) : (
                            <>
                                {robotTableData.map((row, i) => (
                                    <span key={row.id} className={`${ANIMATE_ENTER_UP} ${staggerDelay(i)} ${TRANSITION_SMOOTH} ${HOVER_LIFT_SM} hidden`} />
                                ))}
                                <Table columns={robotColumns} data={robotTableData} loading={false} emptyText="No robot accounts found." stickyHeader striped compact />
                            </>
                        )}
                    </div>
                </div>
            )}

            {/* ──────────────────────────────────────────────────────────────
                ADD ADMIN MODAL
            ────────────────────────────────────────────────────────────── */}
            <Modal
                open={hook.addModalOpen}
                onClose={hook.closeAddModal}
                title="Add Admin"
                size={hook.addForm.selectedEmployee ? "lg" : "md"}
                footer={
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={hook.closeAddModal} disabled={hook.actionLoading}>
                            Cancel
                        </Button>
                        <Button variant="primary" loading={hook.actionLoading} onClick={hook.submitAddAdmin} disabled={!hook.addForm.selectedEmployee}>
                            Create Admin
                        </Button>
                    </div>
                }
            >
                <div className="space-y-4">
                    <EmployeeSearchSection
                        searchQuery={hook.searchQuery}
                        setSearchQuery={hook.setSearchQuery}
                        debouncedQuery={hook.debouncedQuery}
                        searchResults={hook.searchResults}
                        searchLoading={hook.searchLoading}
                        isDebouncing={hook.isDebouncing}
                        onSelect={hook.selectEmployee}
                        onClear={() => {
                            hook.handleAddFormChange("selectedEmployee", null);
                            hook.setSearchQuery("");
                        }}
                        selectedEmployee={hook.addForm.selectedEmployee}
                    />

                    {hook.addForm.selectedEmployee && (
                        <>
                            {/* Role */}
                            <Select label="Role" options={ROLE_OPTIONS} value={hook.addForm.role} onChange={(v) => hook.handleAddFormChange("role", v)} />

                            {/* Password option */}
                            <div className="space-y-3">
                                <p className="text-xs font-aumovio-bold text-black/70 dark:text-white/70">Password</p>
                                <div className="flex gap-3">
                                    <label className="flex items-center gap-2 cursor-pointer text-sm font-aumovio text-black/75 dark:text-white/75">
                                        <input type="radio" name="addAdminRetainPassword" checked={hook.addForm.retainPassword} onChange={() => hook.handleAddFormChange("retainPassword", true)} className="accent-orange-400" />
                                        Use default password
                                    </label>
                                    <label className="flex items-center gap-2 cursor-pointer text-sm font-aumovio text-black/75 dark:text-white/75">
                                        <input type="radio" name="addAdminRetainPassword" checked={!hook.addForm.retainPassword} onChange={() => hook.handleAddFormChange("retainPassword", false)} className="accent-orange-400" />
                                        Set custom password
                                    </label>
                                </div>
                                {!hook.addForm.retainPassword && <Input label="New Password" type="password" value={hook.addForm.newPassword} onChange={(e) => hook.handleAddFormChange("newPassword", e.target.value)} placeholder="Enter a strong password…" required />}
                            </div>

                            {/* Permission flags — pre-populated with defaults, editable at creation */}
                            <hr className="border-grey-200 dark:border-grey-700" />
                            <p className="text-xs font-aumovio-bold text-black/60 dark:text-white/50 uppercase tracking-wide">
                                Permission Flags
                            </p>
                            <PermissionFlagsFieldset
                                form={hook.addForm.flags}
                                onToggle={hook.handleAddFlagToggle}
                            />
                        </>
                    )}
                </div>
            </Modal>

            {/* ──────────────────────────────────────────────────────────────
                ADD ROBOT MODAL
            ────────────────────────────────────────────────────────────── */}
            <Modal
                open={hook.addRobotModalOpen}
                onClose={hook.closeAddRobotModal}
                title="Add Robot Account"
                size={hook.addRobotForm.selectedEmployee ? "lg" : "md"}
                footer={
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={hook.closeAddRobotModal} disabled={hook.actionLoading}>
                            Cancel
                        </Button>
                        <Button variant="primary" loading={hook.actionLoading} onClick={hook.submitAddRobot} disabled={!hook.addRobotForm.selectedEmployee}>
                            Create Robot Account
                        </Button>
                    </div>
                }
            >
                <div className="space-y-4">
                    {/* Role fixed notice */}
                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-grey-100 dark:bg-grey-800/40 border border-grey-200 dark:border-grey-700">
                        <CpuChipIcon className="w-4 h-4 text-green-500 shrink-0" />
                        <p className="text-xs text-black/60 dark:text-white/60 font-aumovio">
                            Role is fixed as <span className="font-aumovio-bold text-green-600 dark:text-green-400">ROBOT</span>. Robot accounts are used for RPA/automation and bypass the duplicate-name check in RFID uploads.
                        </p>
                    </div>

                    <EmployeeSearchSection
                        searchQuery={hook.searchQuery}
                        setSearchQuery={hook.setSearchQuery}
                        debouncedQuery={hook.debouncedQuery}
                        searchResults={hook.searchResults}
                        searchLoading={hook.searchLoading}
                        isDebouncing={hook.isDebouncing}
                        onSelect={hook.selectRobotEmployee}
                        onClear={() => {
                            hook.handleAddRobotFormChange("selectedEmployee", null);
                            hook.setSearchQuery("");
                        }}
                        selectedEmployee={hook.addRobotForm.selectedEmployee}
                    />

                    {/* Password section — only after employee is selected */}
                    {hook.addRobotForm.selectedEmployee && (
                        <div className="space-y-3">
                            <p className="text-xs font-aumovio-bold text-black/70 dark:text-white/70">Password</p>
                            <div className="flex gap-3">
                                <label className="flex items-center gap-2 cursor-pointer text-sm font-aumovio text-black/75 dark:text-white/75">
                                    <input type="radio" name="addRobotRetainPassword" checked={hook.addRobotForm.retainPassword} onChange={() => hook.handleAddRobotFormChange("retainPassword", true)} className="accent-orange-400" />
                                    Use default password
                                </label>
                                <label className="flex items-center gap-2 cursor-pointer text-sm font-aumovio text-black/75 dark:text-white/75">
                                    <input type="radio" name="addRobotRetainPassword" checked={!hook.addRobotForm.retainPassword} onChange={() => hook.handleAddRobotFormChange("retainPassword", false)} className="accent-orange-400" />
                                    Set custom password
                                </label>
                            </div>
                            {!hook.addRobotForm.retainPassword && <Input label="New Password" type="password" value={hook.addRobotForm.newPassword} onChange={(e) => hook.handleAddRobotFormChange("newPassword", e.target.value)} placeholder="Enter a strong password…" required />}
                        </div>
                    )}
                </div>
            </Modal>

            {/* ──────────────────────────────────────────────────────────────
                EDIT ADMIN / ROBOT MODAL
            ────────────────────────────────────────────────────────────── */}
            <Modal
                open={hook.editModalOpen}
                onClose={hook.closeEditModal}
                title={`Edit ${hook.targetAdmin?.empRole === "ROBOT" ? "Robot" : "Admin"} — ${hook.targetAdmin?.empId ?? ""}`}
                size="md"
                footer={
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={hook.closeEditModal} disabled={hook.actionLoading}>
                            Cancel
                        </Button>
                        <Button variant="primary" loading={hook.actionLoading} onClick={hook.submitEditAdmin}>
                            Save Changes
                        </Button>
                    </div>
                }
            >
                <div className="space-y-4">
                    {/* Role selector — hidden for ROBOT accounts */}
                    {hook.targetAdmin?.empRole !== "ROBOT" ? (
                        <Select label="Role" options={EDIT_ROLE_OPTIONS} value={hook.editForm.role} onChange={(v) => hook.handleEditFormChange("role", v)} />
                    ) : (
                        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-grey-100 dark:bg-grey-800/40 border border-grey-200 dark:border-grey-700">
                            <CpuChipIcon className="w-4 h-4 text-green-500 shrink-0" />
                            <p className="text-xs text-black/60 dark:text-white/60 font-aumovio">
                                Role is fixed as <span className="font-aumovio-bold text-green-600 dark:text-green-400">ROBOT</span> and cannot be changed here.
                            </p>
                        </div>
                    )}

                    <label className="flex items-center gap-2 cursor-pointer text-sm font-aumovio text-black/75 dark:text-white/75">
                        <input type="checkbox" checked={hook.editForm.changePassword} onChange={(e) => hook.handleEditFormChange("changePassword", e.target.checked)} className="w-4 h-4 rounded accent-orange-400" />
                        Change password
                    </label>
                    {hook.editForm.changePassword && <Input label="New Password" type="password" value={hook.editForm.newPassword} onChange={(e) => hook.handleEditFormChange("newPassword", e.target.value)} placeholder="Enter a strong password…" required />}
                </div>
            </Modal>

            {/* ──────────────────────────────────────────────────────────────
                RESET PASSWORD CONFIRMATION MODAL
            ────────────────────────────────────────────────────────────── */}
            <Modal
                open={hook.resetPwModalOpen}
                onClose={hook.closeResetPwModal}
                title="Reset Password"
                variant="default"
                size="sm"
                footer={
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={hook.closeResetPwModal} disabled={hook.actionLoading}>
                            Cancel
                        </Button>
                        <Button variant="warning" loading={hook.actionLoading} onClick={hook.confirmResetPassword}>
                            Reset Password
                        </Button>
                    </div>
                }
            >
                <p className="text-sm font-aumovio text-black/75 dark:text-white/75">
                    Reset <strong>{hook.targetAdmin?.empId}</strong>'s password back to the system default? The account will be required to change it on next login.
                </p>
            </Modal>

            {/* ──────────────────────────────────────────────────────────────
                RESET SIGNATURE CONFIRMATION MODAL
            ────────────────────────────────────────────────────────────── */}
            <Modal
                open={hook.resetSigModalOpen}
                onClose={hook.closeResetSigModal}
                title="Reset Record Signature"
                size="sm"
                footer={
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={hook.closeResetSigModal} disabled={hook.actionLoading}>
                            Cancel
                        </Button>
                        <Button variant="accent" loading={hook.actionLoading} onClick={hook.confirmResetSignature}>
                            Recompute Signature
                        </Button>
                    </div>
                }
            >
                <p className="text-sm font-aumovio text-black/75 dark:text-white/75">
                    The record for <strong>{hook.targetAdmin?.empId}</strong> has a broken integrity signature. This will recompute the signature from the current data. No password or role will be changed.
                </p>
            </Modal>

            {/* ──────────────────────────────────────────────────────────────
                DELETE CONFIRMATION MODAL
            ────────────────────────────────────────────────────────────── */}
            <Modal
                open={hook.deleteModalOpen}
                onClose={hook.closeDeleteModal}
                title={hook.targetAdmin?.empRole === "ROBOT" ? "Remove Robot Account" : "Remove Admin"}
                variant="danger"
                size="sm"
                footer={
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={hook.closeDeleteModal} disabled={hook.actionLoading}>
                            Cancel
                        </Button>
                        <Button variant="danger" loading={hook.actionLoading} onClick={hook.confirmDelete}>
                            {hook.targetAdmin?.empRole === "ROBOT" ? "Remove Robot" : "Remove Admin"}
                        </Button>
                    </div>
                }
            >
                <p className="text-sm font-aumovio text-black/75 dark:text-white/75">
                    Remove <strong>{hook.targetAdmin?.empId}</strong> from the {hook.targetAdmin?.empRole === "ROBOT" ? "robot roster" : "admin roster"}? This action cannot be undone. The employee's HRIS record is not affected.
                </p>
            </Modal>

            {/* ──────────────────────────────────────────────────────────────
                PERMISSIONS MODAL (SUPER_ADMIN only)
            ────────────────────────────────────────────────────────────── */}
            <Modal
                open={hook.permissionsModalOpen}
                onClose={hook.closePermissionsModal}
                title={`Permissions — ${hook.targetAdmin?.empId ?? ""}`}
                size="md"
                footer={
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={hook.closePermissionsModal} disabled={hook.actionLoading}>
                            Cancel
                        </Button>
                        <Button variant="primary" loading={hook.actionLoading} onClick={hook.submitPermissions}>
                            Save Permissions
                        </Button>
                    </div>
                }
            >
                <PermissionFlagsFieldset
                    form={hook.permissionsForm}
                    onToggle={hook.handlePermissionToggle}
                    showAuditTrail
                    updatedAt={hook.targetAdmin?.updatedAt ?? null}
                    updatedBy={hook.targetAdmin?.updatedBy ?? null}
                />
            </Modal>
        </div>
    );
}

export default function AdminManagementViewWrapped() {
    return (
        <ErrorBoundary>
            <AdminManagementView />
        </ErrorBoundary>
    );
}
