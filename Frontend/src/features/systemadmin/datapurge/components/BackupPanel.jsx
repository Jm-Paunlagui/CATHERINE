/**
 * @fileoverview Backup tab panel — archive list, "Back Up Now", disk usage,
 * and per-archive actions (Download / Verify / Delete).
 *
 * Tier 1 component — presentation only. Receives the whole `useDataPurge()`
 * hook object via props (whole-hook pattern). Never imports the hook or
 * API directly.
 *
 * Display rules:
 *   - Row counts use `formatCompactNumber` + `Tooltip` (never `formatNumber`
 *     in a fixed-width cell — a busy table reaches millions of rows).
 *   - Download copy states plainly that the file is self-contained even when
 *     the stored archive is incremental.
 *   - Badge variants use only valid names (`green`, `orange`, `red`, `grey`,
 *     `cyan`, `purple`) — an invalid name renders silently grey.
 *
 * @param {object} props
 * @param {object} props.hook - Full `useDataPurge()` hook object.
 */

import { faDownload, faRotateRight, faShieldHalved, faTrashCan } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { CloudArrowUpIcon, ExclamationTriangleIcon, ServerStackIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef } from "react";
import { ANIMATE_FADE_IN_UP, FOCUS_RING, TRANSITION_COLORS } from "../../../../assets/styles/pre-set-styles";
import ApiErrorAlert from "../../../../components/feedback/ApiErrorAlert";
import Alert from "../../../../components/ui/Alert";
import Badge from "../../../../components/ui/Badge";
import Button from "../../../../components/ui/Button";
import { Modal } from "../../../../components/ui/Modal";
import Skeleton from "../../../../components/ui/Skeleton";
import Spinner from "../../../../components/ui/Spinner";
import { Tooltip } from "../../../../components/ui/Tooltip";
import { formatCompactNumber, formatDateTime, formatNumber } from "../../../../utils/formatters";
import { BackupChainBadge } from "./BackupChainBadge";

/** Formats bytes into a human-readable string. */
function fmtSize(bytes) {
    if (!bytes) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/** Trigger label → human-readable. */
const TRIGGER_LABELS = { SCHEDULED: "Scheduled", MANUAL: "Manual", PURGE: "Pre-purge" };

/** Abbreviated row count with exact figure on hover. */
const CompactRows = ({ value }) => (
    <Tooltip content={`${formatNumber(value)} row${value === 1 ? "" : "s"}`} placement="top">
        <span className="tabular-nums cursor-default text-black/70 dark:text-white/70">{formatCompactNumber(value)}</span>
    </Tooltip>
);

/**
 * @param {object} props
 * @param {object} props.hook - Full `useDataPurge()` hook object.
 */
export function BackupPanel({ hook }) {
    // Fetch backup list on mount (guarded against Strict Mode double-fire).
    // Destructure refetchBackups so the exhaustive-deps lint sees the stable
    // useCallback ref, not the whole hook object.
    const { refetchBackups } = hook;
    const initFiredRef = useRef(false);
    useEffect(() => {
        if (initFiredRef.current) return;
        initFiredRef.current = true;
        refetchBackups();
    }, [refetchBackups]);

    const archives = hook.backupList ?? [];

    return (
        <div className={`space-y-6 ${ANIMATE_FADE_IN_UP}`}>
            {/* ── Header + actions ──────────────────────────────────────── */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="flex items-center gap-3">
                    <div className="p-3 rounded-xl bg-blue-100/30 dark:bg-blue-400/10">
                        <ServerStackIcon className="w-6 h-6 text-(--blue-foreground)" />
                    </div>
                    <div>
                        <h2 className="text-base font-aumovio-bold text-black/85 dark:text-white/85">Database Backups</h2>
                        <p className="text-xs text-black/50 dark:text-white/50">Automatic backups at every scheduled backup event. Only changed tables are re-written.</p>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={hook.refetchBackups} disabled={hook.backupListLoading} aria-label="Refresh backup list">
                        <FontAwesomeIcon icon={faRotateRight} className={`w-3.5 h-3.5 mr-1.5 ${hook.backupListLoading ? "animate-spin" : ""}`} />
                        Refresh
                    </Button>
                    <Button variant="primary" size="sm" onClick={hook.handleRunManualBackup} loading={hook.manualBackupRunning} disabled={hook.manualBackupRunning}>
                        <CloudArrowUpIcon className="w-4 h-4" />
                        Back Up Now
                    </Button>
                </div>
            </div>

            {/* ── Disk usage strip ──────────────────────────────────────── */}
            {archives.length > 0 && (
                <div className="flex items-center gap-4 text-xs text-black/60 dark:text-white/60">
                    <span>
                        <span className="font-aumovio-bold text-black/85 dark:text-white/85">{archives.length}</span> archive{archives.length === 1 ? "" : "s"} on disk
                    </span>
                    <span className="text-grey-300 dark:text-grey-600">·</span>
                    <span>
                        Total size: <span className="font-aumovio-bold text-black/85 dark:text-white/85">{fmtSize(hook.backupTotalSizeBytes)}</span>
                    </span>
                </div>
            )}

            {/* ── Error ─────────────────────────────────────────────────── */}
            {hook.backupListError && <ApiErrorAlert error={hook.backupListError} onDismiss={null} />}

            {/* ── Loading skeleton ──────────────────────────────────────── */}
            {/* Archives render as dense multi-column tables — use a table
                skeleton, not an avatar-row list. */}
            {hook.backupListLoading && !hook.backupList && <Skeleton variant="table" columns={8} lines={4} />}

            {/* ── Empty state ───────────────────────────────────────────── */}
            {!hook.backupListLoading && archives.length === 0 && !hook.backupListError && (
                <div className="text-center py-16 text-grey-400 dark:text-grey-400">
                    <ServerStackIcon className="w-12 h-12 mx-auto mb-3 opacity-40" />
                    <p className="text-sm">No backup archives found.</p>
                    <p className="text-xs mt-1">Use "Back Up Now" to take the first backup, or wait for the next scheduled backup.</p>
                </div>
            )}

            {/* ── Auto Backups section ───────────────────────────────── */}
            <ArchiveSection title="Auto Backups" subtitle="Scheduled + manual" archives={archives.filter((a) => a.trigger !== "PURGE")} hook={hook} columns={AUTO_COLUMNS} />

            {/* ── Purge Backups section ─────────────────────────────────── */}
            <ArchiveSection title="Purge Backups" subtitle="Pre-purge safety snapshots" archives={archives.filter((a) => a.trigger === "PURGE")} hook={hook} columns={PURGE_COLUMNS} />

            {/* ── Delete request modal ──────────────────────────────────── */}
            <Modal
                open={!!hook.deleteConfirmId}
                onClose={() => hook.setDeleteConfirmId(null)}
                title="Request Delete — Majority Vote Required"
                variant="danger"
                footer={
                    <>
                        <Button variant="ghost" onClick={() => hook.setDeleteConfirmId(null)}>
                            Cancel
                        </Button>
                        <Button
                            variant="danger"
                            onClick={() => {
                                hook.handleRequestDelete(hook.deleteConfirmId);
                                hook.setDeleteConfirmId(null);
                            }}
                        >
                            Request Delete
                        </Button>
                    </>
                }
            >
                <p className="text-sm text-black/70 dark:text-white/70">This will start a delete request that requires a majority of active SUPER_ADMINs to approve. Your vote is cast automatically. If you are the sole admin, the archive is deleted immediately.</p>
            </Modal>

            {/* ── Info note ─────────────────────────────────────────────── */}
            <Alert variant="info" title="How backups work">
                <ul className="text-sm mt-1 space-y-1 list-disc list-inside text-black/60 dark:text-white/60">
                    <li>Backups run automatically at every event the backup scheduler is given (a project registers its own event source).</li>
                    <li>Only tables that changed since the last backup are re-written (per-table content-hash dedup).</li>
                    <li>Downloads are always self-contained — even when stored as incremental, the download resolves the full chain.</li>
                    <li>Deleting an archive that other backups depend on is blocked until the dependents are removed first.</li>
                </ul>
            </Alert>
        </div>
    );
}

// ─── Column definitions ───────────────────────────────────────────────────────

const AUTO_COLUMNS = ["takenAt", "trigger", "mode", "tables", "rows", "size", "consistent", "actions"];
const PURGE_COLUMNS = ["takenAt", "purgedBy", "scope", "tables", "rows", "size", "actions"];

// ─── Shared archive section sub-component ─────────────────────────────────────

/**
 * @param {object} props
 * @param {string} props.title
 * @param {string} props.subtitle
 * @param {Array} props.archives
 * @param {object} props.hook
 * @param {string[]} props.columns
 */
function ArchiveSection({ title, subtitle, archives, hook, columns }) {
    if (archives.length === 0) {
        return (
            <div className="space-y-2">
                <h3 className="text-sm font-aumovio-bold text-black/70 dark:text-white/70">{title}</h3>
                <p className="text-xs text-black/50 dark:text-white/50 py-4 text-center">{subtitle} — none yet.</p>
            </div>
        );
    }

    const HEADER_MAP = {
        takenAt: "Taken At",
        trigger: "Trigger",
        mode: "Mode",
        tables: "Tables",
        rows: "Rows",
        size: "Size",
        consistent: "Consistent",
        actions: "Actions",
        purgedBy: "Purged By",
        scope: "Scope",
    };

    const RIGHT_COLS = new Set(["tables", "rows", "size", "actions"]);
    const CENTER_COLS = new Set(["consistent"]);

    return (
        <div className="space-y-2">
            <h3 className="text-sm font-aumovio-bold text-black/70 dark:text-white/70">{title}</h3>
            <div className="overflow-x-auto rounded-xl border border-(--color-card-surface-border)">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="bg-grey-50 dark:bg-(--bg-surface-3) text-left text-xs uppercase tracking-wider text-black/50 dark:text-white/50">
                            {columns.map((col) => (
                                <th key={col} className={`p-4 font-medium ${RIGHT_COLS.has(col) ? "text-right" : ""} ${CENTER_COLS.has(col) ? "text-center" : ""}`}>
                                    {HEADER_MAP[col] ?? col}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-grey-100 dark:divide-grey-800">
                        {archives.map((a) => (
                            <ArchiveRow key={a.archiveId} archive={a} hook={hook} columns={columns} />
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

/**
 * @param {object} props
 * @param {object} props.archive
 * @param {object} props.hook
 * @param {string[]} props.columns
 */
function ArchiveRow({ archive: a, hook, columns }) {
    const tableCount = a.tables ? Object.keys(a.tables).length : 0;
    const totalRows = a.tables ? Object.values(a.tables).reduce((s, t) => s + (t.rows ?? 0), 0) : 0;
    const vote = a.deleteVote;
    const hasVote = !!vote;

    const CELL = {
        takenAt: (
            <td key="takenAt" className="p-4 whitespace-nowrap text-black/70 dark:text-white/70">
                {a.createdAt ? formatDateTime(a.createdAt) : "—"}
            </td>
        ),
        trigger: (
            <td key="trigger" className="p-4 whitespace-nowrap">
                <Badge variant={a.trigger === "SCHEDULED" ? "blue" : a.trigger === "PURGE" ? "red" : "grey"} size="sm" pill>
                    {TRIGGER_LABELS[a.trigger] ?? a.trigger}
                </Badge>
            </td>
        ),
        mode: (
            <td key="mode" className="p-4 whitespace-nowrap">
                <BackupChainBadge mode={a.mode} chain={a.chain} />
            </td>
        ),
        tables: (
            <td key="tables" className="p-4 whitespace-nowrap text-right tabular-nums text-black/70 dark:text-white/70">
                {tableCount}
            </td>
        ),
        rows: (
            <td key="rows" className="p-4 whitespace-nowrap text-right">
                <CompactRows value={totalRows} />
            </td>
        ),
        size: (
            <td key="size" className="p-4 whitespace-nowrap text-right tabular-nums text-black/70 dark:text-white/70">
                {fmtSize(a.sizeBytes)}
            </td>
        ),
        consistent: (
            <td key="consistent" className="p-4 whitespace-nowrap text-center">
                {a.readConsistent === false ? (
                    <Tooltip content="Snapshot was torn (ORA-01555 fallback)" placement="top">
                        <ExclamationTriangleIcon className="w-4 h-4 text-warn-400 inline" />
                    </Tooltip>
                ) : (
                    <span className="text-success-400 text-xs">✓</span>
                )}
            </td>
        ),
        purgedBy: (
            <td key="purgedBy" className="p-4 whitespace-nowrap text-black/70 dark:text-white/70">
                {a.createdBy ? `EMP ${a.createdBy}` : "—"}
            </td>
        ),
        scope: (
            <td key="scope" className="p-4 whitespace-nowrap">
                {a.purgeScope?.groups?.length > 0 ? <span className="text-xs font-mono text-black/70 dark:text-white/70">{a.purgeScope.groups.join(", ")}</span> : <span className="text-xs text-black/50 dark:text-white/50">Full DB</span>}
            </td>
        ),
        actions: (
            <td key="actions" className="p-4 whitespace-nowrap text-right">
                <div className="flex items-center justify-end gap-1">
                    <Tooltip content="Download — always a self-contained full archive" placement="top">
                        <button onClick={() => hook.handleDownloadArchive(a.archiveId)} className={`p-2 rounded text-(--blue-foreground) hover:bg-blue-100/30 dark:hover:bg-blue-400/10 ${FOCUS_RING} ${TRANSITION_COLORS}`} aria-label={`Download archive ${a.archiveId}`}>
                            <FontAwesomeIcon icon={faDownload} className="w-3.5 h-3.5" />
                        </button>
                    </Tooltip>
                    <Tooltip content="Verify signature + chain integrity" placement="top">
                        <button onClick={() => hook.handleVerifyArchive(a.archiveId)} disabled={hook.verifyingArchiveId === a.archiveId} className={`p-2 rounded text-(--secondary-foreground) hover:bg-purple-100/30 dark:hover:bg-purple-400/10 ${FOCUS_RING} ${TRANSITION_COLORS} disabled:opacity-40`} aria-label={`Verify archive ${a.archiveId}`}>
                            {hook.verifyingArchiveId === a.archiveId ? <Spinner size="xs" /> : <FontAwesomeIcon icon={faShieldHalved} className="w-3.5 h-3.5" />}
                        </button>
                    </Tooltip>
                    {/* Vote-based delete flow */}
                    {hasVote ? (
                        <VoteActions archive={a} hook={hook} />
                    ) : (
                        <Tooltip content="Request delete (requires majority vote)" placement="top">
                            <button onClick={() => hook.setDeleteConfirmId(a.archiveId)} className={`p-2 rounded text-danger-400 hover:bg-danger-100/30 dark:hover:bg-danger-400/10 ${FOCUS_RING} ${TRANSITION_COLORS}`} aria-label={`Request delete ${a.archiveId}`}>
                                <FontAwesomeIcon icon={faTrashCan} className="w-3.5 h-3.5" />
                            </button>
                        </Tooltip>
                    )}
                </div>
            </td>
        ),
    };

    return <tr className={`${TRANSITION_COLORS} hover:bg-grey-50/50 dark:hover:bg-white/2`}>{columns.map((col) => CELL[col])}</tr>;
}

/**
 * Vote action buttons — shown when a delete request is pending.
 * @param {object} props
 * @param {object} props.archive
 * @param {object} props.hook
 */
function VoteActions({ archive: a, hook }) {
    const vote = a.deleteVote;
    if (!vote) return null;

    return (
        <div className="flex items-center gap-2">
            <Tooltip content={`${vote.votesCast} of ${vote.votesNeeded} votes`} placement="top">
                <Badge variant="orange" size="sm" pill>
                    {vote.votesCast}/{vote.votesNeeded}
                </Badge>
            </Tooltip>
            <Tooltip content="Approve delete" placement="top">
                <button onClick={() => hook.handleVoteDelete(a.archiveId)} className={`p-2 rounded text-danger-400 hover:bg-danger-100/30 dark:hover:bg-danger-400/10 ${FOCUS_RING} ${TRANSITION_COLORS}`} aria-label={`Vote to delete ${a.archiveId}`}>
                    <FontAwesomeIcon icon={faTrashCan} className="w-3.5 h-3.5" />
                </button>
            </Tooltip>
            <Tooltip content="Cancel delete request" placement="top">
                <button onClick={() => hook.handleCancelDeleteRequest(a.archiveId)} className={`p-1 rounded text-grey-400 hover:text-black dark:hover:text-white hover:bg-grey-100 dark:hover:bg-grey-800 ${FOCUS_RING} ${TRANSITION_COLORS}`} aria-label={`Cancel delete request ${a.archiveId}`}>
                    <span className="text-xs font-aumovio-bold">✕</span>
                </button>
            </Tooltip>
        </div>
    );
}

export default BackupPanel;
