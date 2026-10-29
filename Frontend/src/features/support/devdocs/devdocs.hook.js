/**
 * devdocs.hook.js — state for the developer documentation viewer.
 *
 * Business-logic layer. Imports devDocsApi; the view imports this and never
 * the API file directly.
 *
 * Three reads, each independently gated so none of them fires before it can
 * return anything useful:
 *   - tree     — always, once a session exists
 *   - document — only when one is selected
 *   - search   — only when the debounced query clears the server's minimum
 *
 * Everything derivable is DERIVED, not stored. `toc` and `apiError` were
 * briefly useState written from effects; both are pure functions of data this
 * hook already has, and an effect that calls setState synchronously is a
 * cascading render the linter is right to refuse. The TOC shares its slugify
 * with the renderer (devdocsToc.js), so the nav cannot point at anchors the
 * document does not contain.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { extractApiError } from "../../../components/ui/toast.utils";
import { buildToc } from "./devdocsToc";
import useDebounce from "../../../hooks/useDebounce";
import { useRequest } from "../../../hooks/useRequest";
import { devDocsApi } from "./devdocs.api";

/** Server rejects anything shorter; mirrored so we do not spend a 400 to learn it. */
const MIN_QUERY_LENGTH = 2;

/**
 * Core hook for the dev-docs feature.
 * @returns {object} state and handlers consumed by DevDocs.view.jsx
 */
export const useDevDocs = () => {
    const [searchParams, setSearchParams] = useSearchParams();

    // ── Section tree ─────────────────────────────────────────────────────────
    const {
        data: treeData,
        loading: treeLoading,
        error: treeError,
    } = useRequest("devdocs/tree", () => devDocsApi.getTree().then((r) => r.data?.data ?? {}), {
        staleTime: 300_000,
    });

    // Memoised: a fresh [] each render would re-key every downstream useMemo
    // and effect that depends on it.
    const sections = useMemo(() => treeData?.sections ?? [], [treeData]);

    /** Flat id → doc metadata, for resolving the selection without re-walking. */
    const docsById = useMemo(() => {
        const map = new Map();
        for (const section of sections) {
            for (const doc of section.docs ?? []) map.set(doc.id, { ...doc, section: section.name });
        }
        return map;
    }, [sections]);

    // ── Selection ────────────────────────────────────────────────────────────
    // Held in the URL, not in state. These are reference documents an admin
    // will link a colleague to, and a selection that lives only in memory
    // cannot be shared or reloaded onto.
    const selectedId = searchParams.get("doc") ?? null;

    const setSelectedId = useCallback(
        (id) => {
            setSearchParams(
                (prev) => {
                    const next = new URLSearchParams(prev);
                    if (id) next.set("doc", id);
                    else next.delete("doc");
                    return next;
                },
                { replace: true },
            );
        },
        [setSearchParams],
    );

    // Land on something readable rather than an empty pane, but only once the
    // tree has arrived and only when the URL did not already name a document.
    useEffect(() => {
        if (selectedId || !sections.length) return;
        const first = sections[0]?.docs?.[0]?.id;
        if (first) setSelectedId(first);
    }, [selectedId, sections, setSelectedId]);

    // ── Document ─────────────────────────────────────────────────────────────
    const {
        data: docData,
        loading: docLoading,
        error: docError,
    } = useRequest(
        selectedId ? `devdocs/doc/${selectedId}` : null,
        () => devDocsApi.getDoc(selectedId).then((r) => r.data?.data ?? null),
        { staleTime: 300_000, enabled: !!selectedId },
    );

    const doc = docData ?? null;
    const selectedMeta = selectedId ? docsById.get(selectedId) ?? null : null;

    // ── Search ───────────────────────────────────────────────────────────────
    const [searchRaw, setSearchRaw] = useState("");
    const { value: debouncedSearch } = useDebounce(searchRaw, 400);
    const searchActive = debouncedSearch.trim().length >= MIN_QUERY_LENGTH;

    const { data: searchData, loading: searchLoading } = useRequest(
        searchActive ? `devdocs/search/${debouncedSearch}` : null,
        () => devDocsApi.search(debouncedSearch).then((r) => r.data?.data ?? null),
        { staleTime: 60_000, enabled: searchActive },
    );

    const searchResults = searchData?.results ?? [];
    const searchTotal = searchData?.total ?? 0;
    const searchTruncated = searchData?.truncated ?? false;

    // ── Table of contents ────────────────────────────────────────────────────
    // Derived from the markdown, sharing its slugify with the renderer. Nothing
    // to reset between documents: a new markdown yields a new TOC.
    const toc = useMemo(() => buildToc(doc?.markdown), [doc?.markdown]);

    // ── Errors ───────────────────────────────────────────────────────────────
    const apiError = useMemo(() => {
        const err = treeError ?? docError;
        if (!err) return null;
        // A 403 means the session is not admin. Say that plainly rather than
        // letting a generic message imply the page is broken — the server is
        // working exactly as intended.
        const fallback =
            err?.response?.status === 403
                ? "Developer documentation is available to administrators only."
                : "Failed to load developer documentation.";
        return extractApiError(err, fallback);
    }, [treeError, docError]);

    return {
        // tree
        sections,
        treeLoading,
        docsById,

        // selection
        selectedId,
        setSelectedId,
        selectedMeta,

        // document
        doc,
        docLoading,

        // toc
        toc,

        // search
        searchRaw,
        setSearchRaw,
        searchActive,
        searchResults,
        searchTotal,
        searchTruncated,
        searchLoading,

        // errors
        apiError,
    };
};

export default useDevDocs;
