/**
 * changelog.hook.js
 *
 * State, server data, modals, and form logic for the Version History page.
 *
 * Single write path: every entry — content builds AND release markers — is
 * created through the same create form. The form is seeded either from a plain
 * "New Entry" (the next in-cycle build) or from a Release Control action
 * (promote / cut / open), both supplied as DRAFTS by the backend
 * `GET /changelog/release/current`. The backend owns the version + stage rules;
 * this hook just seeds the form and posts it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { extractApiError, toast } from "../../../components/ui/toast.utils";
import { useVersion } from "../../../contexts/version/VersionContext";
import { AuthMiddleware } from "../../../middleware/authentication/AuthMiddleware";
import { changelogApi } from "./changelog.api";

const EMPTY_FORM = {
    displayDate: "",
    version: "",
    title: "",
    message: "",
    whatChanged: "",
    type: "feat",
    authors: "",
    coAuthors: "",
};

/** @returns {string} today's date as YYYY-MM-DD (local) */
function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── whatChanged textarea helpers ──────────────────────────────────────────────

/**
 * Converts a whatChanged structured array to a textarea-friendly string.
 * Top-level items are plain lines; nested items are indented with 2 spaces.
 *
 * @param {Array<{ text: string, items?: string[] }>} items
 * @returns {string}
 */
export function serializeWhatChanged(items) {
    if (!items?.length) return "";
    return items
        .map((item) => {
            const lines = [item.text ?? ""];
            (item.items ?? []).forEach((nested) => lines.push(`  ${nested}`));
            return lines.join("\n");
        })
        .join("\n");
}

/**
 * Parses a textarea string back into a whatChanged structured array.
 * Lines with 2+ leading spaces are nested under the previous top-level item.
 *
 * @param {string} text
 * @returns {Array<{ text: string, items?: string[] }>}
 */
export function parseWhatChanged(text) {
    if (!text?.trim()) return [];
    const lines = text
        .split("\n")
        .map((l) => l.trimEnd())
        .filter((l) => l.trim());
    const result = [];
    for (const line of lines) {
        const isNested = /^ {2,}/.test(line);
        if (isNested && result.length > 0) {
            const last = result[result.length - 1];
            if (!last.items) last.items = [];
            last.items.push(line.trim());
        } else {
            result.push({ text: line.trim() });
        }
    }
    return result;
}

/**
 * @returns {object} hook
 */
export function useChangelog() {
    const [entries, setEntries] = useState([]);
    const [loading, setLoading] = useState(true);
    const [user, setUser] = useState(null);

    // Survives React Strict Mode's artificial unmount/remount — prevents
    // fetchEntries from firing a second network request on the remount.
    const initFiredRef = useRef(false);

    // Modal state
    const [createOpen, setCreateOpen] = useState(false);
    const [editTarget, setEditTarget] = useState(null); // entry being edited
    const [deleteTarget, setDeleteTarget] = useState(null); // entry pending delete

    // Form state (shared for create / edit)
    const [form, setForm] = useState(EMPTY_FORM);
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);

    // Release-train state (derived server-side; drives the Release Control card
    // and seeds the create form). Null until the SUPER_ADMIN fetch resolves.
    const { refresh: refreshVersionBadge } = useVersion();
    const [releaseState, setReleaseState] = useState(null);

    // ── Auth ─────────────────────────────────────────────────────────────────
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const u = await AuthMiddleware.isAuth();
            if (!cancelled) setUser(u || null);
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const isSuperAdmin = user?.role === "SUPER_ADMIN";

    // ── Fetch ─────────────────────────────────────────────────────────────────
    const fetchEntries = useCallback(async () => {
        setLoading(true);
        try {
            const res = await changelogApi.list();
            setEntries(res.data?.data ?? []);
        } catch (err) {
            toast.apiError(err, "Failed to load version history.");
        } finally {
            setLoading(false);
        }
    }, []);

    // Release state is SUPER_ADMIN-only; non-admins never call it. Failures are
    // swallowed so the page still works without the Release Control.
    const fetchReleaseState = useCallback(async () => {
        try {
            const res = await changelogApi.release.current();
            setReleaseState(res.data?.data ?? null);
        } catch {
            setReleaseState(null);
        }
    }, []);

    useEffect(() => {
        if (initFiredRef.current) return;
        initFiredRef.current = true;
        fetchEntries();
    }, [fetchEntries]);

    // Load the release state once the user resolves as SUPER_ADMIN.
    useEffect(() => {
        if (isSuperAdmin) fetchReleaseState();
    }, [isSuperAdmin, fetchReleaseState]);

    // ── Create (single write path for content + release markers) ────────────────
    const closeCreate = useCallback(() => {
        setCreateOpen(false);
        setForm(EMPTY_FORM);
    }, []);

    /** Opens the form for a plain in-cycle content build (the next iteration). */
    const openCreate = useCallback(() => {
        const d = releaseState?.drafts?.content;
        setForm({
            ...EMPTY_FORM,
            displayDate: todayStr(),
            version: d?.version ?? "",
            type: d?.type ?? "feat",
        });
        setApiError(null);
        setCreateOpen(true);
    }, [releaseState]);

    /**
     * Opens the form pre-filled from a Release Control draft (promote / cut /
     * open). The admin reviews + edits, then saves via the normal create flow.
     * @param {{ version: string, type: string, title?: string, message?: string }} d
     */
    const openReleaseDraft = useCallback((d) => {
        if (!d) return;
        setForm({
            ...EMPTY_FORM,
            displayDate: todayStr(),
            version: d.version,
            type: d.type ?? "release",
            title: d.title ?? "",
            message: d.message ?? "",
        });
        setCreateOpen(true);
    }, []);

    // ── Inline API error state (replaces toast for form/modal actions) ─────────
    const [apiError, setApiError] = useState(null);

    const handleCreate = useCallback(async () => {
        setSaving(true);
        setApiError(null);
        try {
            const payload = buildPayload(form);
            const res = await changelogApi.create(payload);
            toast.success(res.data?.message ?? "Entry created.");
            await fetchEntries();
            await fetchReleaseState();
            refreshVersionBadge?.();
            closeCreate();
        } catch (err) {
            setApiError(extractApiError(err, "Failed to create entry."));
        } finally {
            setSaving(false);
        }
    }, [form, fetchEntries, fetchReleaseState, refreshVersionBadge, closeCreate]);

    // ── Edit ──────────────────────────────────────────────────────────────────
    const openEdit = useCallback((entry) => {
        setEditTarget(entry);
        setApiError(null);
        setForm({
            displayDate: entry.displayDate ?? "",
            version: entry.version ?? "",
            title: entry.title ?? "",
            message: entry.message ?? "",
            whatChanged: serializeWhatChanged(entry.whatChanged ?? []),
            type: entry.type ?? "feat",
            authors: (entry.authors ?? []).join(", "),
            coAuthors: (entry.coAuthors ?? []).join(", "),
        });
    }, []);

    const closeEdit = useCallback(() => {
        setEditTarget(null);
        setForm(EMPTY_FORM);
    }, []);

    const handleUpdate = useCallback(async () => {
        if (!editTarget) return;
        setSaving(true);
        try {
            const payload = buildPayload(form);
            const res = await changelogApi.update(editTarget.id, payload);
            toast.success(res.data?.message ?? "Entry updated.");
            await fetchEntries();
            await fetchReleaseState();
            refreshVersionBadge?.();
            closeEdit();
        } catch (err) {
            setApiError(extractApiError(err, "Failed to update entry."));
        } finally {
            setSaving(false);
        }
    }, [editTarget, form, fetchEntries, fetchReleaseState, refreshVersionBadge, closeEdit]);

    // ── Delete ────────────────────────────────────────────────────────────────
    const openDelete = useCallback((entry) => setDeleteTarget(entry), []);
    const closeDelete = useCallback(() => setDeleteTarget(null), []);

    const handleDelete = useCallback(async () => {
        if (!deleteTarget) return;
        setDeleting(true);
        try {
            const res = await changelogApi.delete(deleteTarget.id);
            toast.success(res.data?.message ?? "Entry deleted.");
            await fetchEntries();
            await fetchReleaseState();
            refreshVersionBadge?.();
            closeDelete();
        } catch (err) {
            setApiError(extractApiError(err, "Failed to delete entry."));
        } finally {
            setDeleting(false);
        }
    }, [deleteTarget, fetchEntries, fetchReleaseState, refreshVersionBadge, closeDelete]);

    // ── Form helpers ──────────────────────────────────────────────────────────
    // Stage is no longer chosen here — it is owned by the Release Control and
    // derived from the (pre-filled) version. The version stays freely editable.
    const handleFormChange = useCallback((field, value) => {
        setForm((prev) => ({ ...prev, [field]: value }));
    }, []);

    return {
        entries,
        loading,
        user,
        isSuperAdmin,

        createOpen,
        openCreate,
        closeCreate,
        handleCreate,

        editTarget,
        openEdit,
        closeEdit,
        handleUpdate,

        deleteTarget,
        openDelete,
        closeDelete,
        handleDelete,

        form,
        handleFormChange,
        saving,
        deleting,

        // Release train
        releaseState,
        openReleaseDraft,

        // Inline API error
        apiError,
        setApiError,
    };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Converts form state to a clean API payload.
 * Authors/coAuthors: comma-separated string → trimmed string array.
 * whatChanged: textarea string → structured array.
 *
 * @param {object} form
 * @returns {object}
 */
function buildPayload(form) {
    return {
        displayDate: form.displayDate.trim(),
        version: form.version.trim(),
        title: form.title.trim(),
        message: form.message.trim(),
        whatChanged: parseWhatChanged(form.whatChanged),
        type: form.type,
        authors: form.authors
            ? form.authors
                  .split(",")
                  .map((a) => a.trim())
                  .filter(Boolean)
            : [],
        coAuthors: form.coAuthors
            ? form.coAuthors
                  .split(",")
                  .map((a) => a.trim())
                  .filter(Boolean)
            : [],
    };
}
