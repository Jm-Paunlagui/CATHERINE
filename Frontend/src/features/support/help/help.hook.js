/**
 * help.hook.js — State, search, category filter, and URL sync for the Help Center.
 *
 * No API layer — content is static. Role-based visibility is resolved from
 * the user object returned by AuthMiddleware.isAuth().
 *
 * URL sync:
 *   ?category=account-login  ↔  selectedCategoryId
 *   ?q=search+term           ↔  searchQuery (set by SearchInput's debounce)
 *
 * @module help.hook
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AuthMiddleware } from "../../../middleware/authentication/AuthMiddleware";
import { HELP_CATEGORIES, ROLE_TIERS } from "./help.data";
import { articleMatches, buildVocabulary, expandSynonyms, findSuggestion, tokenize } from "./helpSearch";
import { reportHelpMiss } from "./helpTelemetry";

/** Idle time (ms) after the query settles before a zero-result is reported. */
const MISS_REPORT_DEBOUNCE_MS = 1200;

/**
 * @returns {object} hook — Help Center state and actions
 */
export function useHelp() {
    const [user, setUser] = useState(null);
    const [isLoading, setIsLoading] = useState(true);

    // ── URL sync ──────────────────────────────────────────────────────────────
    const [searchParams, setSearchParams] = useSearchParams();
    const urlCategory = searchParams.get("category");
    const urlQuery = searchParams.get("q") ?? "";

    // ── Input state ───────────────────────────────────────────────────────────
    const [selectedCategoryId, setSelectedCategoryId] = useState(urlCategory);
    const [searchQuery, setSearchQuery] = useState(urlQuery);
    const [expandedArticleId, setExpandedArticleId] = useState(null);

    /** Mobile-only disclosure for the category rail. */
    const [navOpen, setNavOpen] = useState(false);

    // ── Auth ──────────────────────────────────────────────────────────────────
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const u = await AuthMiddleware.isAuth();
            if (!cancelled) {
                setUser(u || null);
                setIsLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const userTier = ROLE_TIERS[user?.role] ?? 0;
    const userRole = user?.role ?? null;

    // ── Derived: visible categories ───────────────────────────────────────────
    // Two visibility models, in priority order:
    //   1. `roles` — an exact allow-list. Authoritative when present, because a
    //      numeric tier cannot express "signed-in-only, exactly this role":
    //      several roles share tier 0 (see help.data.jsx header).
    //   2. `minRole` — the tier ladder, for everything else.
    const visibleCategories = useMemo(() => {
        return HELP_CATEGORIES.filter((cat) => {
            if (Array.isArray(cat.roles)) return userRole != null && cat.roles.includes(userRole);
            const catTier = ROLE_TIERS[cat.minRole] ?? 0;
            return userTier >= catTier;
        });
    }, [userTier, userRole]);

    // ── Derived: filtered articles ────────────────────────────────────────────
    const query = searchQuery.trim().toLowerCase();

    // Tokenize + synonym-expand ONCE per query (not per article). The shared
    // engine gives the Help Center the same intelligence as the launcher:
    // curated synonyms ("logs" → "logging") and bounded typo tolerance.
    // `null` short-circuits the no-query path so browsing shows everything.
    const searchTokens = useMemo(() => (query ? expandSynonyms(tokenize(query)) : null), [query]);

    // Deduped corpus word set, rebuilt only on role change. Fuels the
    // "did you mean?" suggestion on the zero-match path. O(1) membership.
    const corpusVocabulary = useMemo(() => buildVocabulary(visibleCategories), [visibleCategories]);

    const { filteredCategories, matchCount, categoryMatchCounts } = useMemo(() => {
        const counts = {};

        const filtered = visibleCategories
            .map((cat) => {
                // Category filter
                if (selectedCategoryId && cat.id !== selectedCategoryId) {
                    counts[cat.id] = 0;
                    return null;
                }

                // Search filter — shared engine (synonyms + fuzzy) via articleMatches
                const articles = searchTokens ? cat.articles.filter((a) => articleMatches(a, searchTokens)) : cat.articles;

                counts[cat.id] = articles.length;

                if (articles.length === 0) return null;
                return { ...cat, articles };
            })
            .filter(Boolean);

        // Summed from the kept categories rather than accumulated inside the
        // map callback — identical value (a dropped category contributes 0),
        // without a render-phase reassignment (react-hooks/immutability).
        const total = filtered.reduce((sum, cat) => sum + cat.articles.length, 0);

        return { filteredCategories: filtered, matchCount: total, categoryMatchCounts: counts };
    }, [visibleCategories, selectedCategoryId, searchTokens]);

    // Count for the "All Categories" option in the rail
    const totalArticleCount = useMemo(() => {
        if (!searchTokens) return visibleCategories.reduce((sum, cat) => sum + cat.articles.length, 0);
        // When searching, count matches across all visible categories (ignoring category filter)
        return visibleCategories.reduce((sum, cat) => {
            return sum + cat.articles.filter((a) => articleMatches(a, searchTokens)).length;
        }, 0);
    }, [visibleCategories, searchTokens]);

    // ── Derived: "did you mean?" suggestion ─────────────────────────────────────
    // Only computed on the zero-match path — the closest real corpus word to
    // what the user typed, so the empty state offers a recovery instead of a
    // dead end. Mirrors the launcher's behavior exactly.
    const suggestion = useMemo(() => {
        if (!query || matchCount > 0) return null;
        return findSuggestion(tokenize(query), corpusVocabulary);
    }, [query, matchCount, corpusVocabulary]);

    // ── Zero-result telemetry (data-driven synonym growth) ──────────────
    // Report a miss ONLY after the query has settled (debounced), so a user
    // typing "loggin" reports the finished word once — not every keystroke.
    // Fire-and-forget + per-session dedupe live in reportHelpMiss. Guarded by
    // matchCount === 0 so a search that DID find something is never reported.
    useEffect(() => {
        if (!query || matchCount > 0) return undefined;
        const t = setTimeout(() => reportHelpMiss(query, "center"), MISS_REPORT_DEBOUNCE_MS);
        return () => clearTimeout(t);
    }, [query, matchCount]);

    // ── URL sync (state → URL) ────────────────────────────────────────────────
    useEffect(() => {
        setSearchParams(
            (prev) => {
                const next = new URLSearchParams(prev);
                if (selectedCategoryId) next.set("category", selectedCategoryId);
                else next.delete("category");
                if (searchQuery.trim()) next.set("q", searchQuery.trim());
                else next.delete("q");
                return next;
            },
            { replace: true },
        );
    }, [selectedCategoryId, searchQuery, setSearchParams]);

    // ── Actions ───────────────────────────────────────────────────────────────

    const selectCategory = useCallback((id) => {
        setSelectedCategoryId(id);
        setExpandedArticleId(null);
        setNavOpen(false);
    }, []);

    const handleSearch = useCallback((q) => {
        setSearchQuery(q);
        setExpandedArticleId(null);
    }, []);

    /**
     * Replace the current query with the suggested word and clear any category
     * filter so the recovered search spans the whole visible corpus. Wired to
     * the "Did you mean X?" button in the empty state.
     */
    const applySuggestion = useCallback(() => {
        if (!suggestion) return;
        setSearchQuery(suggestion);
        setSelectedCategoryId(null);
        setExpandedArticleId(null);
    }, [suggestion]);

    const toggleArticle = useCallback((id) => {
        setExpandedArticleId((prev) => (prev === id ? null : id));
    }, []);

    const clearFilters = useCallback(() => {
        setSelectedCategoryId(null);
        setSearchQuery("");
        setExpandedArticleId(null);
    }, []);

    return {
        // Auth
        user,
        isLoading,
        userTier,

        // Categories
        visibleCategories,
        filteredCategories,
        totalArticleCount,

        // Search
        searchQuery,
        setSearchQuery: handleSearch,
        matchCount,
        categoryMatchCounts,
        suggestion,
        applySuggestion,

        // Selection
        selectedCategoryId,
        selectCategory,
        expandedArticleId,
        toggleArticle,

        // Mobile nav
        navOpen,
        setNavOpen,

        // Actions
        clearFilters,
    };
}
