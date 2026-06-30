/**
 * Changelog.view.jsx — Version History page.
 *
 * Displays all changelog entries grouped by displayDate using an open
 * dot-and-line timeline. "What Changed" bullets are collapsed by default
 * behind a disclosure toggle so the page stays scannable.
 * SUPER_ADMIN users see Add / Edit / Delete controls.
 */

import { faArrowUp, faBug, faChevronDown, faChevronUp, faCodeBranch, faCodeMerge, faFileLines, faFlagCheckered, faFlask, faGears, faLock, faPen, faPlus, faRocket, faShieldHalved, faTrashCan, faTriangleExclamation, faWrench } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useState } from "react";

import { ErrorBoundary } from "../../../components/feedback/ErrorBoundary";
import { Input } from "../../../components/forms/Input";
import { Select } from "../../../components/forms/Select";
import { Textarea } from "../../../components/forms/Textarea";
import Badge from "../../../components/ui/Badge";
import Button from "../../../components/ui/Button";
import { Datepicker } from "../../../components/ui/Datepicker";
import { Modal } from "../../../components/ui/Modal";
import { Skeleton } from "../../../components/ui/Skeleton";

import { ANIMATE_FADE_IN_UP, ANIMATE_PAGE_ENTER, ANIMATE_PULSE_SCALE, ANIM_DELAY_0, ANIM_DELAY_100, ANIM_DELAY_200, BASE_COLOR_BG, BASE_COLOR_TEXT, GRADIENT_COLOR_TEXT, STANDARD_BORDER, TITLE_COLOR_TEXT, staggerDelay } from "../../../assets/styles/pre-set-styles";
import { STAGE_META, parseStageFromVersion } from "../../../config/appVersion";

import { useChangelog } from "./changelog.hook";

// ── Type metadata ─────────────────────────────────────────────────────────────

const TYPE_META = {
    breaking: { badge: "red", icon: faTriangleExclamation, label: "Breaking", dotColor: "bg-danger-400" },
    feat: { badge: "blue", icon: faRocket, label: "Feature", dotColor: "bg-blue-400" },
    fix: { badge: "red", icon: faBug, label: "Bug Fix", dotColor: "bg-danger-400" },
    patch: { badge: "amber", icon: faWrench, label: "Patch", dotColor: "bg-warn-400" },
    perf: { badge: "purple", icon: faGears, label: "Performance", dotColor: "bg-purple-400" },
    refactor: { badge: "grey", icon: faCodeBranch, label: "Refactor", dotColor: "bg-grey-400" },
    security: { badge: "orange", icon: faShieldHalved, label: "Security", dotColor: "bg-orange-400" },
    test: { badge: "teal", icon: faFlask, label: "Test", dotColor: "bg-teal-400" },
    docs: { badge: "cyan", icon: faFileLines, label: "Docs", dotColor: "bg-blue-300" },
    chore: { badge: "grey", icon: faGears, label: "Chore", dotColor: "bg-grey-300" },
    release: { badge: "green", icon: faFlagCheckered, label: "Release", dotColor: "bg-success-400" },
};

const TYPE_OPTIONS = Object.entries(TYPE_META).map(([value, { label }]) => ({ value, label }));

// ── Date formatting ───────────────────────────────────────────────────────────

function formatDisplayDate(iso) {
    const [y, m, d] = iso.split("-");
    return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
    });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function VersionBadge({ version }) {
    return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-semibold text-orange-500 dark:text-orange-300 bg-orange-100/25 dark:bg-orange-400/15 border border-orange-400/30 dark:border-orange-400/25">v{version}</span>;
}

/**
 * Release-stage badge for a changelog entry. The stage is inferred from the
 * version's semver pre-release tag (e.g. "1.2.0-beta.1" → Beta); a plain version
 * with no tag is a final release and shown as "Stable".
 *
 * @param {{ version: string }} props
 */
function StageBadge({ version }) {
    const meta = STAGE_META[parseStageFromVersion(version) ?? "stable"];
    return (
        <Badge variant={meta.variant} size="xs" dot={meta.dot} pill>
            {meta.label}
        </Badge>
    );
}

// ── Release-train control (SUPER_ADMIN) ───────────────────────────────────────

const RELEASE_LADDER = ["dev", "alpha", "beta", "rc", "stable"];
const BUMP_OPTIONS = [
    { bump: "patch", label: "Patch" },
    { bump: "minor", label: "Minor" },
    { bump: "major", label: "Major" },
];

/**
 * Release-train control card — SUPER_ADMIN only. Shows the in-flight target, a
 * ladder progress strip, and the stage transitions (Promote / Cut / Open). Each
 * button does NOT write directly — it opens the create form pre-filled with the
 * backend-supplied draft, which the admin reviews and saves (single write path).
 *
 * @param {{ hook: object }} props
 */
function ReleaseControl({ hook }) {
    if (!hook.isSuperAdmin) return null;

    const rs = hook.releaseState;
    const drafts = rs?.drafts;
    const stage = rs?.stage ?? null;
    const curIdx = stage ? RELEASE_LADDER.indexOf(stage) : -1;
    const nextStage = curIdx >= 0 && curIdx < RELEASE_LADDER.length - 2 ? RELEASE_LADDER[curIdx + 1] : null;

    return (
        <div className={`rounded-2xl ${BASE_COLOR_BG} ${STANDARD_BORDER} p-5 ${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_100}`}>
            {/* Header row */}
            <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                    <FontAwesomeIcon icon={faCodeMerge} className="w-4 h-4 text-(--accent-icon)" />
                    <span className={`text-sm font-semibold ${BASE_COLOR_TEXT}`}>Release Control</span>
                </div>
                {rs?.hasTarget ? (
                    <div className="flex items-center gap-2">
                        <VersionBadge version={rs.version} />
                        <StageBadge version={rs.version} />
                    </div>
                ) : (
                    <span className={`text-xs ${BASE_COLOR_TEXT} opacity-50`}>No release in flight</span>
                )}
            </div>

            {/* Ladder progress */}
            {rs?.hasTarget && (
                <div className="mt-4 flex items-center">
                    {RELEASE_LADDER.map((s, i) => {
                        const reached = i <= curIdx;
                        const isCurrent = i === curIdx;
                        return (
                            <div key={s} className={`flex items-center ${i < RELEASE_LADDER.length - 1 ? "flex-1" : ""}`}>
                                <div className="flex flex-col items-center gap-1">
                                    <span className={`w-2.5 h-2.5 rounded-full ${reached ? "bg-(--accent-icon)" : "bg-grey-300 dark:bg-white/15"} ${isCurrent ? ANIMATE_PULSE_SCALE : ""}`} />
                                    <span className={`text-[10px] uppercase tracking-wide ${isCurrent ? `font-semibold ${BASE_COLOR_TEXT}` : `${BASE_COLOR_TEXT} opacity-40`}`}>{STAGE_META[s].short || "GA"}</span>
                                </div>
                                {i < RELEASE_LADDER.length - 1 && <div className={`h-px flex-1 mx-1.5 mb-4 ${i < curIdx ? "bg-(--accent-icon)" : "bg-grey-200 dark:bg-white/10"}`} />}
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Actions — each opens the pre-filled create form (no direct write) */}
            <div className="mt-4 flex flex-wrap items-center gap-2">
                {drafts?.promote && nextStage && (
                    <Button variant="primary" size="sm" onClick={() => hook.openReleaseDraft(drafts.promote)}>
                        <FontAwesomeIcon icon={faArrowUp} className="w-3.5 h-3.5 mr-1.5" />
                        Promote to {STAGE_META[nextStage].label}
                    </Button>
                )}
                {drafts?.cut && (
                    <Button variant="accent" size="sm" onClick={() => hook.openReleaseDraft(drafts.cut)}>
                        <FontAwesomeIcon icon={faFlagCheckered} className="w-3.5 h-3.5 mr-1.5" />
                        Cut {rs.core} to Stable
                    </Button>
                )}
                {drafts?.open && (
                    <>
                        <span className={`text-xs ${BASE_COLOR_TEXT} opacity-55`}>Open next cycle:</span>
                        {BUMP_OPTIONS.map((b) => (
                            <Button key={b.bump} variant="ghost" size="sm" onClick={() => hook.openReleaseDraft(drafts.open[b.bump])}>
                                {b.label}
                            </Button>
                        ))}
                    </>
                )}
            </div>

            {/* Hint */}
            <p className={`mt-3 text-xs ${BASE_COLOR_TEXT} opacity-45`}>
                {!rs?.hasTarget || stage === "stable" ? "No cycle in flight — open one to start logging changes. Every action opens an entry you review before it’s written." : stage === "rc" ? "Release candidate — review and cut to stable when ready. A new fix is just a new entry at rc." : "Promote when this stage is ready. Each action opens a pre-filled entry you review before saving."}
            </p>
        </div>
    );
}

function AuthorList({ authors, coAuthors }) {
    if (!authors?.length && !coAuthors?.length) return null;
    return (
        <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-xs ${BASE_COLOR_TEXT} opacity-45`}>
            {authors?.length > 0 && (
                <span>
                    <span className="font-semibold opacity-75">By:</span> {authors.join(", ")}
                </span>
            )}
            {coAuthors?.length > 0 && (
                <span>
                    <span className="font-semibold opacity-75">Co-authors:</span> {coAuthors.join(", ")}
                </span>
            )}
        </div>
    );
}

function EntryActions({ entry, isSuperAdmin, onEdit, onDelete }) {
    if (!isSuperAdmin) return null;
    return (
        <div className="flex items-center gap-0.5 shrink-0">
            <button onClick={() => onEdit(entry)} aria-label="Edit entry" className="p-1.5 rounded-lg text-grey-400 hover:text-blue-400 hover:bg-blue-400/10 transition-colors duration-150">
                <FontAwesomeIcon icon={faPen} className="w-3 h-3" />
            </button>
            <button onClick={() => onDelete(entry)} aria-label="Delete entry" className="p-1.5 rounded-lg text-grey-400 hover:text-danger-400 hover:bg-danger-400/10 transition-colors duration-150">
                <FontAwesomeIcon icon={faTrashCan} className="w-3 h-3" />
            </button>
        </div>
    );
}

/**
 * Collapsible "What Changed" section — collapsed by default.
 * Shows a `▾ N changes` disclosure toggle; expands inline on click.
 * Inspired by GitHub's PR review thread collapse pattern.
 *
 * @param {{ items: Array<{ text: string, items?: string[] }> }} props
 */
function WhatChangedSection({ items }) {
    const [open, setOpen] = useState(false);
    if (!items?.length) return null;

    return (
        <div className="mt-2.5">
            <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className={`inline-flex items-center gap-1.5 text-xs font-medium ${BASE_COLOR_TEXT} opacity-45 hover:opacity-75 transition-opacity duration-150`}>
                <FontAwesomeIcon icon={open ? faChevronUp : faChevronDown} className="w-2.5 h-2.5" />
                {open ? "Hide changes" : `${items.length} change${items.length !== 1 ? "s" : ""}`}
            </button>

            {open && (
                <ul className={`mt-2 space-y-1.5 pl-0.5 ${ANIMATE_FADE_IN_UP}`}>
                    {items.map((item, i) => (
                        <li key={i} className="flex items-start gap-2">
                            <span className="text-(--accent-icon) mt-0.75 shrink-0 text-xs leading-none select-none">•</span>
                            <div className="min-w-0">
                                <span className={`text-sm leading-snug ${BASE_COLOR_TEXT} opacity-75`}>{item.text}</span>
                                {item.items?.length > 0 && (
                                    <ul className="mt-1 space-y-0.5 pl-1">
                                        {item.items.map((nested, j) => (
                                            <li key={j} className="flex items-start gap-2">
                                                <span className={`${BASE_COLOR_TEXT} opacity-40 mt-0.75 shrink-0 text-xs leading-none select-none`}>–</span>
                                                <span className={`text-xs leading-snug ${BASE_COLOR_TEXT} opacity-60`}>{nested}</span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

/**
 * Single changelog entry rendered as a timeline row.
 * Left column: coloured dot + optional vertical connector to the next entry.
 * Right column: version badge, type badge, title, message, disclosure toggle.
 *
 * @param {{ entry: object, meta: object, showLine: boolean, isSuperAdmin: boolean, onEdit: Function, onDelete: Function }} props
 */
function ChangelogEntry({ entry, meta, showLine, isSuperAdmin, onEdit, onDelete }) {
    return (
        <div className="relative flex gap-4">
            {/* Timeline rail: dot + optional connector line */}
            <div className="relative flex flex-col items-center flex-none w-3 pt-1.25">
                <div className={`w-2.5 h-2.5 rounded-full shrink-0 ring-2 ring-white dark:ring-[#1a1030] z-10 ${meta.dotColor}`} />
                {showLine && <div className="mt-1.5 flex-1 w-px bg-grey-200 dark:bg-white/10 min-h-4" />}
            </div>

            {/* Entry content */}
            <div className={`flex-1 min-w-0 ${showLine ? "pb-7" : "pb-1"}`}>
                {/* Row 1: version badge + type badge (left) · admin actions (right) */}
                <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                        <VersionBadge version={entry.version} />
                        <StageBadge version={entry.version} />
                        <Badge variant={meta.badge} size="xs" pill>
                            <FontAwesomeIcon icon={meta.icon} className="mr-1 w-2.5 h-2.5" />
                            {meta.label}
                        </Badge>
                    </div>
                    <EntryActions entry={entry} isSuperAdmin={isSuperAdmin} onEdit={onEdit} onDelete={onDelete} />
                </div>

                {/* Title */}
                <p className="mt-1.5 font-semibold text-sm text-black/85 dark:text-white/90 leading-snug">{entry.title}</p>

                {/* Summary message */}
                <p className={`mt-1 text-sm leading-relaxed ${BASE_COLOR_TEXT} opacity-65`}>{entry.message}</p>

                {/* What Changed — collapsed by default */}
                <WhatChangedSection items={entry.whatChanged} />

                {/* Authors */}
                <AuthorList authors={entry.authors} coAuthors={entry.coAuthors} />
            </div>
        </div>
    );
}

// ── Date group separator ──────────────────────────────────────────────────────

function DateGroupHeader({ displayDate, index }) {
    return (
        <div className={`flex items-center gap-3 ${ANIMATE_FADE_IN_UP} ${staggerDelay(index)}`}>
            <div className="h-px flex-1 bg-grey-200 dark:bg-(--bg-surface-3)" />
            <span className={`text-xs font-semibold uppercase tracking-widest px-3 py-1 rounded-full bg-grey-100 dark:bg-(--bg-surface-3) ${BASE_COLOR_TEXT} opacity-60`}>{formatDisplayDate(displayDate)}</span>
            <div className="h-px flex-1 bg-grey-200 dark:bg-(--bg-surface-3)" />
        </div>
    );
}

// ── Changelog form (shared create / edit) ─────────────────────────────────────

/**
 * Parses a "YYYY-MM-DD" string to a local Date (avoids UTC midnight shift).
 * Returns null for empty / invalid strings.
 * @param {string} iso
 * @returns {Date|null}
 */
function parseDateString(iso) {
    if (!iso) return null;
    const [y, m, d] = iso.split("-").map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
}

/**
 * @param {{ form: object, onChange: Function}} props
 */
function ChangelogForm({ form, onChange }) {
    return (
        <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Select label="Type" options={TYPE_OPTIONS} value={form.type} onChange={(v) => onChange("type", v)} />
                <Datepicker label="Display Date" value={parseDateString(form.displayDate)} onChange={(date) => onChange("displayDate", date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}` : "")} placeholder="Pick a date" />
            </div>
            <Input label="Version" name="version" value={form.version} onChange={(e) => onChange("version", e.target.value)} required />
            <Input label="Title" name="title" value={form.title} onChange={(e) => onChange("title", e.target.value)} required />
            <Input label="Message" name="message" value={form.message} onChange={(e) => onChange("message", e.target.value)} required />
            <div className="space-y-1.5">
                <Textarea label="What Changed" name="whatChanged" value={form.whatChanged} onChange={(e) => onChange("whatChanged", e.target.value)} rows={6} />
                <p className={`text-xs pl-0.5 ${BASE_COLOR_TEXT} opacity-50`}>
                    One item per line. Indent nested items with <span className="font-mono font-semibold">2 spaces</span> to create sub-bullets.
                </p>
            </div>
            <Input label="Authors (comma-separated)" name="authors" placeholder="e.g. John Moises Paunlagui, Adrian Parco" value={form.authors} onChange={(e) => onChange("authors", e.target.value)} />
            <Input label="Co-authors (comma-separated)" name="coAuthors" placeholder="e.g. Skyler Clyde, Mark Angelo" value={form.coAuthors} onChange={(e) => onChange("coAuthors", e.target.value)} />
        </div>
    );
}

// ── Main content ──────────────────────────────────────────────────────────────

function ChangelogContent() {
    const hook = useChangelog();

    const groups = groupByDate(hook.entries);
    const dateKeys = Object.keys(groups).sort((a, b) => b.localeCompare(a));

    return (
        <div className="max-w-3xl mx-auto px-4 py-10 font-aumovio space-y-10">
            {/* ── Header ──────────────────────────────────────────────────── */}
            <div className={`flex flex-wrap items-start justify-between gap-4 ${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_0}`}>
                <div>
                    <h1 className={`text-3xl font-extrabold ${TITLE_COLOR_TEXT}`}>
                        Version <span className={GRADIENT_COLOR_TEXT}>History</span>
                    </h1>
                    <p className={`mt-1 text-sm ${BASE_COLOR_TEXT} opacity-70`}>Track all changes, improvements, and fixes</p>
                </div>
                {hook.isSuperAdmin && (
                    <Button variant="primary" size="sm" onClick={hook.openCreate} disabled={!hook.releaseState?.drafts?.content}>
                        <FontAwesomeIcon icon={faPlus} className="mr-1.5 w-3.5 h-3.5" />
                        New Entry
                    </Button>
                )}
            </div>

            {/* ── Release control (SUPER_ADMIN) ────────────────────────────── */}
            <ReleaseControl hook={hook} />

            {/* ── Loading skeleton ─────────────────────────────────────────── */}
            {hook.loading && (
                <div className={`space-y-0 ${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_100}`}>
                    {[...Array(4)].map((_, i) => (
                        <div key={i} className="flex gap-4">
                            <div className="flex flex-col items-center flex-none w-3 pt-1.25">
                                <Skeleton className="w-2.5 h-2.5 rounded-full shrink-0" />
                                {i < 3 && <div className="mt-1.5 flex-1 w-px bg-grey-200 dark:bg-white/10 min-h-12" />}
                            </div>
                            <div className={`flex-1 space-y-2 ${i < 3 ? "pb-7" : "pb-1"}`}>
                                <div className="flex gap-2">
                                    <Skeleton className="h-5 w-14 rounded" />
                                    <Skeleton className="h-5 w-20 rounded-full" />
                                </div>
                                <Skeleton className="h-4 w-2/3 rounded" />
                                <Skeleton className="h-4 w-full rounded" />
                                <Skeleton className="h-3 w-16 rounded" />
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* ── Empty state ───────────────────────────────────────────────── */}
            {!hook.loading && hook.entries.length === 0 && (
                <div className={`text-center py-20 rounded-2xl ${BASE_COLOR_BG} ${STANDARD_BORDER} ${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_100}`}>
                    <FontAwesomeIcon icon={faLock} className="text-4xl text-grey-300 dark:text-grey-600 mb-3" />
                    <p className={`${BASE_COLOR_TEXT} opacity-60`}>No changelog entries yet.</p>
                </div>
            )}

            {/* ── Date groups ───────────────────────────────────────────────── */}
            {!hook.loading &&
                dateKeys.map((date, groupIdx) => {
                    const entries = groups[date];
                    return (
                        <div key={date} className={`space-y-4 ${ANIMATE_FADE_IN_UP} ${staggerDelay(groupIdx)}`}>
                            <DateGroupHeader displayDate={date} index={groupIdx} />
                            <div className="pl-1">
                                {entries.map((entry, i) => {
                                    const meta = TYPE_META[entry.type] ?? TYPE_META.feat;
                                    return <ChangelogEntry key={entry.id} entry={entry} meta={meta} showLine={i < entries.length - 1} isSuperAdmin={hook.isSuperAdmin} onEdit={hook.openEdit} onDelete={hook.openDelete} />;
                                })}
                            </div>
                        </div>
                    );
                })}

            {/* ── Footer count ─────────────────────────────────────────────── */}
            {!hook.loading && hook.entries.length > 0 && (
                <p className={`text-center text-xs ${BASE_COLOR_TEXT} opacity-40 pb-4 ${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_200}`}>
                    {hook.entries.length} release{hook.entries.length !== 1 ? "s" : ""} across {dateKeys.length} date{dateKeys.length !== 1 ? "s" : ""}
                </p>
            )}

            {/* ── Create modal ─────────────────────────────────────────────── */}
            <Modal
                open={hook.createOpen}
                onClose={hook.closeCreate}
                title="New Changelog Entry"
                footer={
                    <>
                        <Button variant="ghost" onClick={hook.closeCreate} disabled={hook.saving}>
                            Cancel
                        </Button>
                        <Button variant="primary" loading={hook.saving} onClick={hook.handleCreate}>
                            Create Entry
                        </Button>
                    </>
                }
            >
                <ChangelogForm form={hook.form} onChange={hook.handleFormChange} />
            </Modal>

            {/* ── Edit modal ───────────────────────────────────────────────── */}
            <Modal
                open={!!hook.editTarget}
                onClose={hook.closeEdit}
                title="Edit Changelog Entry"
                footer={
                    <>
                        <Button variant="ghost" onClick={hook.closeEdit} disabled={hook.saving}>
                            Cancel
                        </Button>
                        <Button variant="primary" loading={hook.saving} onClick={hook.handleUpdate}>
                            Save Changes
                        </Button>
                    </>
                }
            >
                <ChangelogForm form={hook.form} onChange={hook.handleFormChange} />
            </Modal>

            {/* ── Delete confirm modal ─────────────────────────────────────── */}
            <Modal
                open={!!hook.deleteTarget}
                onClose={hook.closeDelete}
                title="Delete Entry"
                variant="danger"
                footer={
                    <>
                        <Button variant="ghost" onClick={hook.closeDelete} disabled={hook.deleting}>
                            Cancel
                        </Button>
                        <Button variant="danger" loading={hook.deleting} onClick={hook.handleDelete}>
                            Delete
                        </Button>
                    </>
                }
            >
                <p className={`text-sm ${BASE_COLOR_TEXT}`}>
                    Are you sure you want to permanently delete <span className="font-semibold">&ldquo;{hook.deleteTarget?.title}&rdquo;</span>? This action cannot be undone.
                </p>
            </Modal>
        </div>
    );
}

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Groups entries by displayDate.
 * @param {object[]} entries
 * @returns {Record<string, object[]>}
 */
function groupByDate(entries) {
    return entries.reduce((acc, entry) => {
        const key = entry.displayDate;
        if (!acc[key]) acc[key] = [];
        acc[key].push(entry);
        return acc;
    }, {});
}

// ── Export ────────────────────────────────────────────────────────────────────

export default function ChangelogView() {
    return (
        <div className={ANIMATE_PAGE_ENTER}>
            <ErrorBoundary>
                <ChangelogContent />
            </ErrorBoundary>
        </div>
    );
}
