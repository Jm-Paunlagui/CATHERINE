/**
 * AdminManagement.view.jsx — Access Control feature view (Super Admin / Admin / User).
 *
 * Presentation layer only. Imports useAdminManagement hook and Aumovio
 * components. Never imports adminmanagement.api.js directly.
 *
 * Layout:
 *   - Page header (title + description)
 *   - "Add Admin" button + record count Badge
 *   - Admin table (Username, Name, Role badge, Status, Permissions, Integrity, Actions)
 *
 *   Modals:
 *     - Add Admin modal (account search → role + permission flags)
 *     - Edit modal (role only)
 *     - Reset Password confirmation modal
 *     - Reset Signature confirmation modal
 *     - Revoke/Delete Access flow (RevokeAdminModal — mandatory backup download,
 *       Revoke primary action, Delete Permanently secondary/edge-case)
 *
 * Wrapped in ErrorBoundary.
 */

import { ArrowPathIcon, KeyIcon, MagnifyingGlassIcon, PencilIcon, ShieldCheckIcon, TrashIcon, UserPlusIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo } from "react";
import { ANIMATE_ENTER_UP, ANIMATE_PAGE_ENTER, HOVER_LIFT_SM, TRANSITION_SMOOTH, staggerDelay } from "../../../assets/styles/pre-set-styles";
import ApiErrorAlert from "../../../components/feedback/ApiErrorAlert";
import ErrorBoundary from "../../../components/feedback/ErrorBoundary";
import { Input } from "../../../components/forms/Input";
import { Select } from "../../../components/forms/Select";
import { Badge } from "../../../components/ui/Badge";
import Button from "../../../components/ui/Button";
import { Modal } from "../../../components/ui/Modal";
import Pagination from "../../../components/ui/Pagination";
import { Table } from "../../../components/ui/Table";
import { Tooltip } from "../../../components/ui/Tooltip";
import { usePagination } from "../../../hooks/usePagination";
import { DEFAULT_PAGE_SIZE, buildPageSizeOptions } from "../../../utils/pagination";
import { useAdminManagement } from "./adminmanagement.hook";
import { PermissionCluster } from "./components/PermissionCluster";
import { PermissionFlagsFieldset } from "./components/PermissionFlagsFieldset";
import { RevokeAdminModal } from "./components/RevokeAdminModal";
import { TempPasswordBadge } from "./components/TempPasswordBadge";
import { TemporaryPasswordRecipient } from "./components/TemporaryPasswordRecipient";

// ─── Role options for Select ───────────────────────────────────────────────────

const ROLE_OPTIONS = [
    { value: "SUPER_ADMIN", label: "Super Admin" },
    { value: "ADMIN", label: "Admin" },
    { value: "USER", label: "User" },
];

const EDIT_ROLE_OPTIONS = ROLE_OPTIONS;

const ROLE_BADGE_VARIANTS = {
    SUPER_ADMIN: "purple",
    ADMIN: "orange",
    USER: "cyan",
};

// ─── Table column definitions ─────────────────────────────────────────────────

/**
 * Build column definitions for the Admin table.
 *
 * @param {Function} onEdit
 * @param {Function} onResetPw
 * @param {Function} onResetSig
 * @param {Function} onRevoke - opens the Revoke/Delete flow (RevokeAdminModal)
 * @param {Function|null} onPermissions - null when caller is not SUPER_ADMIN; cluster is still shown read-only
 * @param {ReturnType<import('./adminmanagement.hook').accessPolicy>} policy - which actions this caller may take on a row
 * @returns {Array}
 */
function buildColumns(onEdit, onResetPw, onResetSig, onRevoke, onPermissions, policy) {
    return [
        {
            key: "username",
            label: "Username",
            sortable: true,
        },
        {
            key: "name",
            label: "Name",
            render: (row) => <span className={row.isActive === "N" ? "opacity-45" : ""}>{row.firstName || row.lastName ? `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() : <span className="text-grey-400 italic text-xs">No profile name</span>}</span>,
        },
        {
            key: "role",
            label: "Role",
            render: (row) => (
                <Badge variant={row.isActive === "N" ? "grey" : (ROLE_BADGE_VARIANTS[row.role] ?? "grey")} pill>
                    {row.role?.replace("_", " ") ?? "—"}
                </Badge>
            ),
        },
        {
            key: "isActive",
            label: "Status",
            render: (row) => (
                <div className="flex flex-wrap items-center gap-1.5">
                    {row.isActive === "N" ? (
                        <Badge variant="red" dot>
                            Inactive
                        </Badge>
                    ) : (
                        <Badge variant="green" dot>
                            Active
                        </Badge>
                    )}
                    <TempPasswordBadge expiresAt={row.tempPasswordExpiresAt} />
                </div>
            ),
        },
        {
            key: "permissions",
            label: "Permissions",
            render: (row) => <PermissionCluster row={row} onClick={onPermissions ? () => onPermissions(row) : undefined} />,
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
                        <span className="text-xs text-grey-500 dark:text-grey-400 cursor-default">{new Date(row.updatedAt).toLocaleDateString()}</span>
                    </Tooltip>
                ) : (
                    <span className="text-xs text-grey-300 dark:text-grey-600">—</span>
                ),
        },
        {
            key: "actions",
            label: "Actions",
            render: (row) => (
                <RowActions row={row} policy={policy} label={String(row.username)} onEdit={onEdit} onResetPw={onResetPw} onResetSig={onResetSig} onRevoke={onRevoke} onPermissions={onPermissions} />
            ),
        },
    ];
}

// ─── Row actions ──────────────────────────────────────────────────────────────

/**
 * The action buttons for one admin row, filtered by the caller's access
 * policy — an ADMIN sees Reset Password on User rows only; everything else is
 * Super Admin only. The API enforces the same rules; this only hides what
 * would be refused.
 *
 * @param {{ row: object, policy: object, label: string, onEdit: Function, onResetPw: Function, onResetSig: Function, onRevoke: Function, onPermissions: Function|null }} props
 */
function RowActions({ row, policy, label, onEdit, onResetPw, onResetSig, onRevoke, onPermissions }) {
    const canEdit = policy.canEdit(row);
    const canResetPw = policy.canResetPassword(row);
    const canResetSig = !row.signatureValid && policy.canResetSignature();
    const canRevoke = policy.canRevoke();
    if (!canEdit && !canResetPw && !canResetSig && !onPermissions && !canRevoke) {
        return <span className="text-xs text-grey-300 dark:text-grey-600">—</span>;
    }
    return (
        <div className="flex items-center gap-2">
            {canEdit && <Button size="xs" variant="ghost" leftIcon={PencilIcon} onClick={() => onEdit(row)} aria-label={`Edit ${label}`} />}
            {canResetPw && <Button size="xs" variant="warning" leftIcon={ShieldCheckIcon} onClick={() => onResetPw(row)} aria-label={`Reset password for ${label}`} />}
            {canResetSig && <Button size="xs" variant="accent" leftIcon={ArrowPathIcon} onClick={() => onResetSig(row)} aria-label={`Reset signature for ${label}`} />}
            {onPermissions && <Button size="xs" variant="ghost" leftIcon={KeyIcon} onClick={() => onPermissions(row)} aria-label={`Edit permissions for ${label}`} />}
            {canRevoke && <Button size="xs" variant="danger" leftIcon={TrashIcon} onClick={() => onRevoke(row)} aria-label={`Revoke or delete access for ${label}`} />}
        </div>
    );
}

// ─── Account Search UI ──────────────────────────────────────────────────────────

/**
 * Account search section used inside the Add Admin modal.
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
 *   selectedAccount: object|null,
 * }} props
 */
function AccountSearchSection({ searchQuery, setSearchQuery, debouncedQuery, searchResults, searchLoading, isDebouncing, onSelect, onClear, selectedAccount }) {
    return (
        <>
            {!selectedAccount && (
                <>
                    <Input
                        id="adminManagementAccountSearch"
                        name="adminManagementAccountSearch"
                        label="Search Account"
                        placeholder="Type username, first or last name…"
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
                            {searchResults.map((acct, idx) => (
                                <li key={`${acct.username}-${idx}`} className={`p-4 cursor-pointer flex items-center justify-between text-sm hover:bg-orange-400/8 dark:hover:bg-orange-400/15 ${TRANSITION_SMOOTH}`} onClick={() => onSelect(acct)} role="option" aria-selected={false}>
                                    <span className="font-aumovio text-black/80 dark:text-white/80">
                                        {acct.username} — {acct.firstName} {acct.lastName}
                                    </span>
                                    {acct.isAdmin && (
                                        <Badge variant="purple" size="xs">
                                            Already admin
                                        </Badge>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}

                    {!searchLoading && !isDebouncing && debouncedQuery.trim() && searchResults.length === 0 && <p className="text-xs text-black/40 dark:text-white/40 pl-1 italic">No accounts found for "{debouncedQuery.trim()}".</p>}

                    {!searchQuery && <p className="text-xs text-black/40 dark:text-white/40 pl-1">Start typing to search for an account by username, first name, or last name.</p>}
                </>
            )}

            {selectedAccount && (
                <div className="flex items-center gap-3 p-4 rounded-xl bg-success-100/40 dark:bg-success-400/10 border border-success-400/30">
                    <ShieldCheckIcon className="w-5 h-5 text-success-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-aumovio-bold text-black/80 dark:text-white/80 truncate">
                            {selectedAccount.firstName} {selectedAccount.lastName}
                        </p>
                        <p className="text-xs text-black/50 dark:text-white/50">{selectedAccount.username}</p>
                    </div>
                    <Button size="xs" variant="ghost" onClick={onClear} aria-label="Clear selected account">
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

    // Trigger search when the debounced query changes while the Add modal is open.
    const { addModalOpen, executeSearch, debouncedQuery } = hook;
    useEffect(() => {
        if (addModalOpen) {
            executeSearch(debouncedQuery);
        }
    }, [debouncedQuery, addModalOpen, executeSearch]);

    const isSuperAdmin = hook.policy.isSuperAdmin;
    const addRoleOptions = ROLE_OPTIONS.filter((o) => hook.policy.addableRoles.includes(o.value));

    const columns = buildColumns(hook.openEditModal, hook.openResetPwModal, hook.openResetSigModal, hook.openRevokeModal, isSuperAdmin ? hook.openPermissionsModal : null, hook.policy);

    // Normalise rows so Table's id lookup works.
    // Inactive admins are visually muted via row-level className passed to Table.
    const adminTableData = hook.admins.map((a) => ({
        ...a,
        id: a.username,
        _rowClassName: a.isActive === "N" ? "opacity-50" : "",
    }));

    const adminPagination = usePagination({ items: adminTableData, defaultPageSize: DEFAULT_PAGE_SIZE });
    const adminPageSizeOptions = useMemo(() => buildPageSizeOptions(adminTableData.length), [adminTableData.length]);

    return (
        <div className={`p-6 flex flex-col gap-4 h-full ${ANIMATE_PAGE_ENTER}`}>
            {/* ── Header ──────────────────────────────────────────────────── */}
            <div className="flex flex-col gap-1">
                <h1 className="text-xl font-aumovio-bold text-black dark:text-white tracking-tight">Access Control</h1>
                <p className="text-sm text-black/60 dark:text-white/60">Manage who has Super Admin, Admin, and User access to this system. Permissions are deny-by-default — grant each capability explicitly.</p>
            </div>
            {/* View-level API error — suppressed while any modal is open (modal renders its own) */}
            {!hook.addModalOpen && !hook.editModalOpen && !hook.resetPwModalOpen && !hook.resetSigModalOpen && !hook.revokeModalOpen && !hook.permissionsModalOpen && <ApiErrorAlert error={hook.apiError} onDismiss={() => hook.setApiError(null)} />}
            {/* ── Error state ──────────────────────────────────────────────── */}
            {hook.listError && !hook.listLoading && <div className="p-4 rounded-xl border border-danger-400/30 bg-danger-100 dark:bg-danger-400/10 text-danger-400 text-sm font-aumovio">Failed to load admin list. Please refresh the page.</div>}

                <div className="flex flex-col gap-4 flex-1 min-h-0">
                    {/* Toolbar */}
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-aumovio-bold text-black/70 dark:text-white/70">Admin Accounts</span>
                            {!hook.listLoading && (
                                <Badge variant="grey" pill size="sm">
                                    {hook.admins.length}
                                </Badge>
                            )}
                        </div>
                        <Button variant="primary" leftIcon={UserPlusIcon} onClick={hook.openAddModal}>
                            Add Admin
                        </Button>
                    </div>

                    {/* Table */}
                    <div className="flex-1 min-h-0 flex flex-col gap-3">
                        {hook.listLoading ? (
                            <Table columns={columns} data={[]} loading loadingRows={adminPagination.pageSize} emptyText="No admins found. Click 'Add Admin' to create the first one." stickyHeader striped compact />
                        ) : (
                            <>
                                {adminPagination.paginatedItems.map((row, i) => (
                                    <span key={row.id} className={`${ANIMATE_ENTER_UP} ${staggerDelay(i)} ${TRANSITION_SMOOTH} ${HOVER_LIFT_SM} hidden`} />
                                ))}
                                <Table columns={columns} data={adminPagination.paginatedItems} loading={false} emptyText="No admins found. Click 'Add Admin' to create the first one." stickyHeader striped compact />
                                <Pagination
                                    page={adminPagination.page}
                                    totalPages={adminPagination.totalPages}
                                    onChange={adminPagination.goToPage}
                                    pageSize={adminPagination.pageSize}
                                    pageSizeOptions={adminPageSizeOptions}
                                    onPageSizeChange={adminPagination.setPageSize}
                                />
                            </>
                        )}
                    </div>
                </div>

            {/* ──────────────────────────────────────────────────────────────
                ADD ADMIN MODAL
            ────────────────────────────────────────────────────────────── */}
            <Modal
                open={hook.addModalOpen}
                onClose={hook.closeAddModal}
                title="Add Admin"
                size={hook.addForm.selectedAccount ? "lg" : "md"}
                footer={
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={hook.closeAddModal} disabled={hook.actionLoading}>
                            Cancel
                        </Button>
                        <Button variant="primary" loading={hook.actionLoading} onClick={hook.submitAddAdmin} disabled={!hook.addForm.selectedAccount}>
                            Create Admin
                        </Button>
                    </div>
                }
            >
                <div className="space-y-4">
                    <ApiErrorAlert error={hook.apiError} onDismiss={() => hook.setApiError(null)} className="mb-4" />
                    <AccountSearchSection
                        searchQuery={hook.searchQuery}
                        setSearchQuery={hook.setSearchQuery}
                        debouncedQuery={hook.debouncedQuery}
                        searchResults={hook.searchResults}
                        searchLoading={hook.searchLoading}
                        isDebouncing={hook.isDebouncing}
                        onSelect={hook.selectAccount}
                        onClear={() => {
                            hook.handleAddFormChange("selectedAccount", null);
                            hook.setSearchQuery("");
                        }}
                        selectedAccount={hook.addForm.selectedAccount}
                    />

                    {hook.addForm.selectedAccount && (
                        <>
                            {/* Role */}
                            <Select label="Role" options={addRoleOptions} value={hook.addForm.role} onChange={(v) => hook.handleAddFormChange("role", v)} fixed />
                            {!isSuperAdmin && <p className="-mt-2 text-xs text-black/50 dark:text-white/50">An Admin can add User accounts. Ask a Super Admin to add other roles.</p>}

                            {/* Temporary password — generated and emailed by the server */}
                            <TemporaryPasswordRecipient
                                id="addAdminOverrideEmail"
                                emailHint={hook.addForm.selectedAccount.emailHint}
                                needsEmail={hook.addNeedsEmail}
                                value={hook.addForm.overrideEmail}
                                onChange={(v) => hook.handleAddFormChange("overrideEmail", v)}
                            />

                            {/* Permission flags — pre-populated with defaults, editable at creation */}
                            <hr className="border-grey-200 dark:border-grey-700" />
                            <p className="text-xs font-aumovio-bold text-black/60 dark:text-white/50 uppercase tracking-wide">Permission Flags</p>
                            <PermissionFlagsFieldset form={hook.addForm.flags} onToggle={hook.handleAddFlagToggle} />
                        </>
                    )}
                </div>
            </Modal>

            {/* ──────────────────────────────────────────────────────────────
                EDIT ADMIN MODAL — role only, Super Admin only. Edit sets no password.
            ────────────────────────────────────────────────────────────── */}
            <Modal
                open={hook.editModalOpen}
                onClose={hook.closeEditModal}
                title={`Edit Admin — ${hook.targetAdmin?.username ?? ""}`}
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
                    <ApiErrorAlert error={hook.apiError} onDismiss={() => hook.setApiError(null)} className="mb-4" />
                    <Select label="Role" options={EDIT_ROLE_OPTIONS} value={hook.editForm.role} onChange={(v) => hook.handleEditFormChange("role", v)} fixed />

                    <p className="text-xs text-black/50 dark:text-white/50">To replace this account's password, use Reset Password — it emails the holder a temporary one.</p>
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
                            Send New Password
                        </Button>
                    </div>
                }
            >
                <ApiErrorAlert error={hook.apiError} onDismiss={() => hook.setApiError(null)} className="mb-4" />
                <div className="space-y-4">
                    <p className="text-sm font-aumovio text-black/75 dark:text-white/75">
                        Email <strong>{hook.targetAdmin?.username}</strong> a new temporary password? Their current password stops working straight away, and they will set a new one when they sign in.
                    </p>
                    <TemporaryPasswordRecipient
                        id="resetPwOverrideEmail"
                        emailHint={hook.targetAdmin?.emailHint}
                        needsEmail={hook.resetNeedsEmail}
                        value={hook.resetPwForm.overrideEmail}
                        onChange={hook.handleResetPwEmailChange}
                    />
                </div>
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
                <ApiErrorAlert error={hook.apiError} onDismiss={() => hook.setApiError(null)} className="mb-4" />
                <p className="text-sm font-aumovio text-black/75 dark:text-white/75">
                    The record for <strong>{hook.targetAdmin?.username}</strong> has a broken integrity signature. This will recompute the signature from the current data. No password or role will be changed.
                </p>
            </Modal>

            {/* ──────────────────────────────────────────────────────────────
                REVOKE / DELETE FLOW — mandatory backup, Revoke primary,
                Delete Permanently secondary
            ────────────────────────────────────────────────────────────── */}
            <RevokeAdminModal hook={hook} />

            {/* ──────────────────────────────────────────────────────────────
                PERMISSIONS MODAL (SUPER_ADMIN only)
            ────────────────────────────────────────────────────────────── */}
            <Modal
                open={hook.permissionsModalOpen}
                onClose={hook.closePermissionsModal}
                title={`Permissions — ${hook.targetAdmin?.username ?? ""}`}
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
                <ApiErrorAlert error={hook.apiError} onDismiss={() => hook.setApiError(null)} className="mb-4" />
                <PermissionFlagsFieldset form={hook.permissionsForm} onToggle={hook.handlePermissionToggle} showAuditTrail updatedAt={hook.targetAdmin?.updatedAt ?? null} updatedBy={hook.targetAdmin?.updatedBy ?? null} />
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
