/**
 * useHelpAssistant.js — State + search for the global Help Assistant launcher.
 *
 * WHAT THIS FILE DOES
 * ───────────────────
 * Powers the platform-wide help launcher that floats on every page (including
 * the unauthenticated /auth screen). The user types a question or keyword and
 * matching Help Center articles surface inline — chatbot-like, but purely a
 * ranked lookup over the same static article corpus the Help Center renders.
 *
 * WHY NOT REUSE useHelp()
 * ───────────────────────
 * The Help Center hook (features/support/help/help.hook.js) writes ?q= and
 * ?category= to the URL via useSearchParams. A GLOBAL launcher must not mutate
 * the address bar of whatever page the user is on — a search from the login
 * screen should never rewrite /auth?q=…. So this hook re-implements only the
 * two pieces it needs — the O(n) substring matcher and the role-visibility
 * filter — and leaves routing untouched. The presentational layer (AnswerBody,
 * HelpArticleCard) is still reused verbatim.
 *
 * ROLE VISIBILITY
 * ───────────────
 * Identical model to the Help Center: a `roles` allow-list is authoritative
 * when present; otherwise the `minRole` tier ladder applies. On /auth the
 * viewer resolves to tier 0 (general articles only) — the intended behaviour.
 *
 * SECURITY (Cybersecurity specialisation)
 * ───────────────────────────────────────
 * - CWE-79: no dangerouslySetInnerHTML — rendering flows through AnswerBody,
 *   which builds React nodes from plain string slices.
 * - CWE-287/863: role gating is a UX convenience only; the article corpus is
 *   public, non-sensitive help text. No secrets, tokens, or PII are indexed.
 * - CWE-200: nothing about the auth state is logged; isAuth() failure resolves
 *   silently to tier 0.
 *
 * COMPLEXITY (Performance specialisation)
 * ───────────────────────────────────────
 * Search is O(n) over the article corpus (n = total visible articles),
 * recomputed only when the debounced query or the resolved role changes. No
 * index is warranted at this scale; a Map/Set would add invalidation cost for
 * no measurable gain on a bounded, static dataset.
 *
 * @module useHelpAssistant
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AuthMiddleware } from "../../../middleware/authentication/AuthMiddleware";
import { HELP_CATEGORIES, ROLE_TIERS } from "../../../features/support/help/help.data";
import { buildVocabulary, expandSynonyms, findSuggestion, scoreArticle, tokenize } from "../../../features/support/help/helpSearch";
import { reportHelpMiss } from "../../../features/support/help/helpTelemetry";
import { storage } from "../../../utils/storage";

/** Max articles surfaced in the launcher before prompting "open full Help Center". */
const RESULT_CAP = 8;

/** Idle time (ms) after the query settles before a zero-result is reported. */
const MISS_REPORT_DEBOUNCE_MS = 1200;

/**
 * localStorage key recording that the viewer has already discovered the Help
 * Assistant (hovered it or opened the panel at least once). Persisted via the
 * SSR-safe `storage` wrapper so the one-time discoverability hint — a gentle
 * attention pulse plus a brief auto-peek of the "Need Help?" label — never
 * replays for a returning user. Namespaced under the app's convention so it
 * cannot collide with unrelated keys.
 * @type {string}
 */
const HINT_SEEN_KEY = "help_assistant_hint_seen";

/**
 * How long the first-visit auto-peek keeps the label revealed before it settles
 * back to the collapsed circle, in milliseconds. Long enough to read the two
 * words, short enough not to nag. Purely a UX affordance; the pulse fades with
 * it. Honoured under prefers-reduced-motion by the CSS (the peek is a class the
 * media query neutralises).
 * @type {number}
 */
const HINT_PEEK_MS = 4200;

/**
 * Roles for which the Help Assistant launcher is suppressed entirely. ROBOT is
 * an automation account with no human operator to read help articles, so the
 * floating launcher is noise. Matches the role string returned in the session
 * payload as `user.role` (see App.jsx ROLES). Defined here as a local constant
 * so the tier-2 shared hook stays decoupled from App.jsx. Exported so tests can
 * lock the suppression decision to a single source.
 * @type {Set<string>}
 */
export const HIDDEN_ROLES = new Set(["ROBOT"]);

/**
 * Routes on which the launcher is suppressed entirely.
 *
 * `/about/help` IS the Help Center — it renders the same article corpus the
 * launcher searches, over its own always-visible search box and category rail.
 * A floating button whose only two actions are "search these articles" and "go
 * to this page" is pure redundancy there, and it overlaps the bottom-right of
 * the category panel.
 *
 * Matched by prefix so nested article deep-links (`/about/help?category=…`, and
 * any future `/about/help/<slug>`) are covered by the one entry.
 * @type {ReadonlyArray<string>}
 */
export const HIDDEN_PATHS = Object.freeze(["/about/help"]);

/**
 * True when `pathname` is a route the launcher must not render on.
 *
 * Prefix match is boundary-aware: `/about/helpdesk` is a different page and must
 * still get the launcher, so a bare `startsWith("/about/help")` would be wrong.
 * O(n) in HIDDEN_PATHS (1 entry), O(1) space.
 *
 * @param {string} pathname
 * @returns {boolean}
 * @example isHiddenPath("/about/help")          // true
 * @example isHiddenPath("/about/help/articles") // true
 * @example isHiddenPath("/about/helpdesk")      // false
 */
export function isHiddenPath(pathname) {
    if (!pathname) return false;
    return HIDDEN_PATHS.some((base) => pathname === base || pathname.startsWith(`${base}/`));
}

/**
 * Search helpers — tokenize, synonym expansion, bounded fuzzy matching,
 * relevance scoring, vocabulary building, and "did you mean?" suggestions —
 * live in the shared features/support/help/helpSearch module so the Help
 * Center and this launcher behave identically. See that file for the full
 * documentation of the algorithm, complexity, and security posture.
 */


/**
 * A flat, ranked article result with its owning category metadata attached so
 * the panel can render the timeline dot colour and category label.
 *
 * @typedef {object} HelpResult
 * @property {import("../../../features/support/help/help.data").HelpArticle} article
 * @property {string} categoryId
 * @property {string} categoryLabel
 * @property {string} categoryColor
 */

/**
 * Global Help Assistant hook.
 *
 * @returns {{
 *   open: boolean,
 *   openAssistant: () => void,
 *   closeAssistant: () => void,
 *   toggleAssistant: () => void,
 *   query: string,
 *   setQuery: (v: string) => void,
 *   clearQuery: () => void,
 *   results: HelpResult[],
 *   totalMatches: number,
 *   capped: boolean,
 *   suggestion: string|null,
 *   applySuggestion: () => void,
 *   hasQuery: boolean,
 *   isReady: boolean,
 *   hidden: boolean,
 *   showHint: boolean,
 *   dismissHint: () => void,
 *   expandedArticleId: string|null,
 *   toggleArticle: (id: string) => void,
 *   goToHelpCenter: () => void,
 *   goToArticle: (categoryId: string) => void,
 * }}
 */
export function useHelpAssistant() {
    const navigate = useNavigate();
    const { pathname } = useLocation();

    const [open, setOpen] = useState(false);
    const [query, setQueryState] = useState("");
    const [expandedArticleId, setExpandedArticleId] = useState(null);

    // ── First-visit discoverability hint ─────────────────────────────────────────
    // A one-time attention affordance: on a viewer's FIRST ever render of the
    // launcher we briefly auto-peek the "Need Help?" label and pulse the button
    // so the FAB is noticed instead of blending into the corner. It is dismissed
    // PERMANENTLY the moment the user acknowledges it (hovers, focuses, or opens
    // the panel) OR after HINT_PEEK_MS elapses — whichever comes first — and the
    // acknowledgement is persisted so it never replays on a return visit.
    //
    // Initialised straight from storage (lazy initialiser, runs once) so there is
    // no first-paint flash of the hint for a user who has already seen it.
    const [showHint, setShowHint] = useState(() => storage.get(HINT_SEEN_KEY) !== true);
    const hintTimer = useRef(null);

    // Resolved viewer role (null on /auth or when unauthenticated → tier 0).
    const [userRole, setUserRole] = useState(null);
    const [isReady, setIsReady] = useState(false);

    // ── Auth resolution ────────────────────────────────────────────────────────
    // Resolved EAGERLY so the role is known before the launcher paints — this
    // lets us HIDE the FAB for suppressed roles (e.g. ROBOT) with no flash of
    // the button.
    //
    // RE-RESOLVED ON EVERY NAVIGATION (keyed on `pathname`), NOT once on mount.
    // <HelpAssistant /> is mounted once at the App root and PERSISTS across the
    // login → app navigation (it is never remounted). A one-shot mount effect
    // therefore resolved the role while still on /auth (logged-out → null) and
    // NEVER re-ran after login, so a freshly-logged-in ROBOT stayed `userRole:
    // null → hidden:false` and kept seeing the FAB. Re-running on pathname
    // change catches the post-login role the moment the user lands on their
    // first authenticated route.
    //
    // Cost (CWE-400 — no needless work): AuthMiddleware.isAuth() short-circuits
    // to `false` with NO network request when there is no session hint in
    // localStorage (the /auth case), and otherwise serves from an in-memory
    // cache. So per-navigation resolution adds zero requests for logged-out
    // users and reuses the already-cached payload for logged-in ones.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const u = await AuthMiddleware.isAuth();
            if (!cancelled) {
                setUserRole(u && u.role ? u.role : null);
                setIsReady(true);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [pathname]);

    const userTier = ROLE_TIERS[userRole] ?? 0;

    // Suppress the launcher entirely for automation roles (ROBOT). Until the
    // role resolves (isReady === false) we do NOT hide, so human users never
    // see the button flicker in on load; a ROBOT session flips this to true the
    // moment auth resolves, removing the FAB.
    // Two independent suppressions, OR'd:
    //   • ROLE  — resolved async, so gated on isReady to avoid the FAB
    //             flickering in for a human before auth answers.
    //   • ROUTE — known synchronously from the router, so it needs no isReady
    //             gate; waiting on auth would flash the button onto /about/help
    //             for the one render before the role resolves.
    const hidden = (isReady && userRole != null && HIDDEN_ROLES.has(userRole)) || isHiddenPath(pathname);

    // ── Effective open state ────────────────────────────────────────────────────
    // DERIVED, not synced with an effect. `hidden` makes <HelpAssistant /> render
    // null, but rendering null does NOT unmount it, so its open-panel effect
    // never runs its cleanup — and that cleanup is what releases
    // `document.body.style.overflow` and the #root blur. Reporting `open: true`
    // while hidden would therefore strand the Help Center blurred and
    // unscrollable with no visible panel to close.
    //
    // Folding `hidden` in here instead means the consumer's effect sees `open`
    // flip to false on the very render suppression kicks in, so its cleanup
    // fires on schedule. An effect calling setOpen(false) would achieve the same
    // end state one cascading render later, and trips react-hooks/set-state-in-effect.
    //
    // `goToHelpCenter`/`goToArticle` already setOpen(false) before navigating,
    // so the common path never depends on this. Browser Back/Forward into
    // /about/help with the panel open does.
    const effectiveOpen = open && !hidden;

    // ── Global keyboard shortcut: Ctrl/Cmd + K toggles the launcher ──────────────
    // Also gated by `hidden`: a suppressed role (ROBOT) and a suppressed route
    // (/about/help) get no shortcut either, so the (unrendered) panel can never
    // be opened via keyboard.
    useEffect(() => {
        if (hidden) return;
        const onKeyDown = (e) => {
            if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
                e.preventDefault();
                setOpen((prev) => !prev);
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [hidden]);

    // ── Visible categories (role-gated) ─────────────────────────────────────────
    const visibleCategories = useMemo(() => {
        return HELP_CATEGORIES.filter((cat) => {
            if (Array.isArray(cat.roles)) return userRole != null && cat.roles.includes(userRole);
            const catTier = ROLE_TIERS[cat.minRole] ?? 0;
            return userTier >= catTier;
        });
    }, [userTier, userRole]);

    // ── Corpus vocabulary (for "did you mean" suggestions) ──────────────────────
    // A deduped set of every meaningful word across the visible article corpus,
    // built once per role change (not per keystroke) via the shared helper. Used
    // only on the zero-match path to find the closest real word to what the user
    // typed. Bounded by the corpus size; a Set keeps membership O(1).
    const corpusVocabulary = useMemo(() => buildVocabulary(visibleCategories), [visibleCategories]);

    // ── Ranked, flattened search results ────────────────────────────────────────
    const q = query.trim().toLowerCase();
    const hasQuery = q.length > 0;

    const { results, totalMatches, capped, suggestion } = useMemo(() => {
        if (!hasQuery) return { results: [], totalMatches: 0, capped: false, suggestion: null };

        // Expand the raw tokens with curated synonyms so a user's word ("logs")
        // matches the corpus's word ("logging"). Additive — originals are kept.
        const tokens = expandSynonyms(tokenize(q));

        /** @type {(HelpResult & { _score: number, _order: number })[]} */
        const scored = [];
        let order = 0;
        for (const cat of visibleCategories) {
            for (const article of cat.articles) {
                // Field-weighted, phrase-aware relevance via the shared engine:
                // a tag hit outranks a question hit outranks an answer hit, and
                // adjacent query tokens in the title earn a phrase bonus. Score
                // 0 means no match, so off-topic articles are skipped.
                const total = scoreArticle(article, tokens);
                if (total === 0) continue;

                scored.push({ article, categoryId: cat.id, categoryLabel: cat.label, categoryColor: cat.color, _score: total, _order: order });
                order += 1;
            }
        }

        // Sort by score desc; ties keep corpus order (stable via _order). O(n log n)
        // over the matched subset, which is small (bounded by the corpus).
        scored.sort((a, b) => b._score - a._score || a._order - b._order);

        const ranked = scored.map(({ _score, _order, ...rest }) => rest);

        // Zero matches: compute the single closest real corpus word to the
        // longest query token, so the empty state can offer "Did you mean X?"
        // instead of a dead end. Skipped entirely when there ARE results.
        let didYouMean = null;
        if (ranked.length === 0) {
            didYouMean = findSuggestion(tokenize(q), corpusVocabulary);
        }

        return {
            results: ranked.slice(0, RESULT_CAP),
            totalMatches: ranked.length,
            capped: ranked.length > RESULT_CAP,
            suggestion: didYouMean,
        };
    }, [visibleCategories, corpusVocabulary, q, hasQuery]);

    // ── Zero-result telemetry (data-driven synonym growth) ──────────────
    // Report a miss ONLY after the query settles (debounced) so a user typing
    // "loggin" reports the finished word once, not every keystroke. Guarded by
    // totalMatches === 0. Fire-and-forget + per-session dedupe in reportHelpMiss.
    useEffect(() => {
        if (!hasQuery || totalMatches > 0) return undefined;
        const t = setTimeout(() => reportHelpMiss(q, "assistant"), MISS_REPORT_DEBOUNCE_MS);
        return () => clearTimeout(t);
    }, [q, hasQuery, totalMatches]);

    // ── Actions ─────────────────────────────────────────────────────────────────
    /**
     * Permanently retire the first-visit discoverability hint. Idempotent: safe
     * to call on every hover/focus/open — it no-ops once the flag is already set,
     * so there is no wasted render or repeated storage write.
     */
    const dismissHint = useCallback(() => {
        setShowHint((cur) => {
            if (!cur) return cur; // already dismissed — no state change, no write
            storage.set(HINT_SEEN_KEY, true);
            return false;
        });
    }, []);

    const openAssistant = useCallback(() => {
        dismissHint();
        setOpen(true);
    }, [dismissHint]);
    // Reset the transient expanded-answer state as part of the close action
    // itself (event handler), rather than reacting to `open` flipping false in
    // an effect — a setState inside an effect body trips
    // react-hooks/set-state-in-effect and cascades an extra render. Every path
    // that closes the panel routes through here or navigates away.
    const closeAssistant = useCallback(() => {
        setOpen(false);
        setExpandedArticleId(null);
    }, []);
    const toggleAssistant = useCallback(() => {
        dismissHint();
        setOpen((p) => {
            const next = !p;
            if (!next) setExpandedArticleId(null);
            return next;
        });
    }, [dismissHint]);

    const setQuery = useCallback((v) => {
        setQueryState(v);
        setExpandedArticleId(null); // collapse any open answer when the query changes
    }, []);

    const clearQuery = useCallback(() => {
        setQueryState("");
        setExpandedArticleId(null);
    }, []);

    /**
     * Accept the "did you mean?" correction: replace the query with the
     * suggested word so the empty-state recovers into real results in one tap.
     * No-op when there is no active suggestion.
     */
    const applySuggestion = useCallback(() => {
        if (!suggestion) return;
        setQueryState(suggestion);
        setExpandedArticleId(null);
    }, [suggestion]);

    const toggleArticle = useCallback((id) => {
        setExpandedArticleId((cur) => (cur === id ? null : id));
    }, []);

    const goToHelpCenter = useCallback(() => {
        setOpen(false);
        setExpandedArticleId(null);
        const dest = q ? `/about/help?q=${encodeURIComponent(query.trim())}` : "/about/help";
        navigate(dest);
    }, [navigate, q, query]);

    const goToArticle = useCallback(
        (categoryId) => {
            setOpen(false);
            setExpandedArticleId(null);
            navigate(`/about/help?category=${encodeURIComponent(categoryId)}`);
        },
        [navigate],
    );

    // Auto-retire the first-visit hint after HINT_PEEK_MS even if the user never
    // interacts, so the peek/pulse is a brief nudge — not a permanent fixture.
    // Only armed while the hint is live AND the launcher will actually paint
    // (isReady + not hidden), so a suppressed ROBOT session never persists the
    // "seen" flag on the user's behalf. The timer is cleared on unmount and on
    // any earlier dismissal (showHint flips false → effect re-runs → cleanup).
    useEffect(() => {
        if (!showHint || !isReady || hidden) return;
        hintTimer.current = setTimeout(dismissHint, HINT_PEEK_MS);
        return () => clearTimeout(hintTimer.current);
    }, [showHint, isReady, hidden, dismissHint]);

    return {
        open: effectiveOpen,
        openAssistant,
        closeAssistant,
        toggleAssistant,
        query,
        setQuery,
        clearQuery,
        results,
        totalMatches,
        capped,
        suggestion,
        applySuggestion,
        hasQuery,
        isReady,
        hidden,
        showHint,
        dismissHint,
        expandedArticleId,
        toggleArticle,
        goToHelpCenter,
        goToArticle,
    };
}

export default useHelpAssistant;
