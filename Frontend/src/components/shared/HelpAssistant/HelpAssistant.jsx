/**
 * HelpAssistant.jsx — Global, platform-wide help launcher (tier-2 shared).
 *
 * WHAT THIS FILE DOES
 * ───────────────────
 * A floating action button that lives on EVERY page — including the
 * unauthenticated /auth screen — opening a searchable panel where a user types
 * a question or keyword and matching Help Center articles surface inline. It
 * reads like a chatbot (ask → answer) but is a deterministic lookup over the
 * same static article corpus the Help Center renders — no model, no network
 * round-trip, no hallucination surface.
 *
 * ARCHITECTURE (React specialisation — three-tier sharing model)
 * ──────────────────────────────────────────────────────────────
 * Tier 2 (src/components/shared/) because it is consumed by the global app
 * shell across all features, not by one feature. It owns its own UX and pulls:
 *   - DATA      from features/support/help/help.data      (HELP_CATEGORIES)
 *   - RENDERING from features/support/help/components      (HelpArticleCard,
 *                                                           AnswerBody)
 *   - STATE     from ./useHelpAssistant                    (search + role gate)
 * The presentational article renderer is reused verbatim so a launcher answer
 * is pixel-identical to the same article in the full Help Center — highlights,
 * detail JSX, and tag chips included.
 *
 * ANIMATION (UI/UX + Design System v3.1)
 * ──────────────────────────────────────
 * FAB uses BUTTON_SPRING. Panel reuses the Modal's ANIMATE_FADE_IN backdrop +
 * ANIMATE_SCALE_IN panel. Result rows enter with ANIMATE_FADE_IN_UP +
 * staggerDelay(i) in index order. No hard-coded durations.
 *
 * DARK MODE (first-class)
 * ───────────────────────
 * Every surface, border, text, and hover state carries a dark: counterpart
 * against the editorial surface tokens.
 *
 * SECURITY (Cybersecurity specialisation)
 * ───────────────────────────────────────
 * - CWE-79: no dangerouslySetInnerHTML anywhere; AnswerBody builds nodes from
 *   plain string slices.
 * - CWE-601: the only navigation targets are hard-coded internal /about/help
 *   paths with param values passed through encodeURIComponent — no open-redirect
 *   surface, no user-controlled destination.
 * - CWE-287/863: role gating is UX-only over public help text; no sensitive
 *   data is indexed or exposed.
 *
 * @module HelpAssistant
 */

import { QuestionMarkCircleIcon, XMarkIcon, ArrowRightIcon, MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ANIMATE_FADE_IN, ANIMATE_FADE_IN_UP, ANIMATE_SCALE_IN, BUTTON_SPRING, TRANSITION_COLORS, staggerDelay } from "../../../assets/styles/pre-set-styles";

import { SearchInput } from "../../forms/SearchInput";
import Button from "../../ui/Button";
import Badge from "../../ui/Badge";
import { KBD } from "../../ui/KBD";

import { HelpArticleCard } from "../../../features/support/help/components/HelpArticleCard";
import { useHelpAssistant } from "./useHelpAssistant";

/** @type {Record<string, string>} category colour → timeline dot bg class (mirrors HelpArticlePanel). */
const DOT_COLORS = {
    blue: "bg-blue-400",
    orange: "bg-orange-400",
    yellow: "bg-warn-400",
    grey: "bg-grey-400",
    purple: "bg-purple-400",
    turquoise: "bg-teal-400",
    red: "bg-danger-400",
};

/**
 * @type {Record<string, string>} category colour key → Badge `variant`.
 * The help data's colour vocabulary (turquoise/yellow/red) differs from the
 * Badge component's variant names (cyan/amber/red), so map explicitly rather
 * than let unmapped keys fall through to an undefined variant style.
 */
const BADGE_VARIANTS = {
    blue: "blue",
    orange: "orange",
    yellow: "amber",
    grey: "grey",
    purple: "purple",
    turquoise: "cyan",
    red: "red",
};

/** Curated starter prompts shown before the user types — pure UX affordance. */
const STARTER_PROMPTS = ["How do password lockouts work?", "What is a session timeout?", "How do I read the metrics dashboard?", "How does audit logging work?"];

/**
 * How long the FAB comet keeps orbiting after the last pointer interaction
 * before it fades out and settles. Mirrors SearchInput's COMET_IDLE_MS exactly
 * so both surfaces share the same "run while engaged, settle on idle" cadence —
 * the FAB no longer snaps off the instant the mouse leaves.
 */
const COMET_IDLE_MS = 900;

/**
 * The global Help Assistant. Mounted once in the app shell; renders its own
 * portal so it escapes the shell's overflow-hidden clip.
 *
 * @returns {JSX.Element}
 */
export function HelpAssistant() {
    const hook = useHelpAssistant();
    const { open, openAssistant, closeAssistant, query, setQuery, clearQuery, results, totalMatches, capped, suggestion, applySuggestion, hasQuery, hidden, showHint, dismissHint, expandedArticleId, toggleArticle, goToHelpCenter } = hook;

    const searchRef = useRef(null);
    // The launcher element, so focus can be RESTORED to it when the panel closes
    // (accessibility: keyboard/AT users are returned to the control they invoked
    // instead of being dropped at the top of the document — mirrors Modal.jsx).
    const fabRef = useRef(null);
    const restoreFocusRef = useRef(false);

    // ── FAB comet: hover-sustained, idle-settling (mirrors SearchInput) ─────────
    // The search comet runs WHILE typing and settles ~COMET_IDLE_MS after the
    // user pauses. The FAB mirrors that cadence with one refinement that matches
    // hover semantics: the orbit runs for the ENTIRE time the pointer is over the
    // FAB (a still cursor still counts as engaged, unlike a paused keyboard), and
    // only when the pointer LEAVES do we start the idle-settle — the comet lingers
    // ~COMET_IDLE_MS then fades out smoothly instead of snapping off.
    //   • `hovering` — true from mouseEnter/focus until mouseLeave/blur; keeps the
    //     orbit lit the whole hover, no matter how long the cursor rests.
    //   • `settling` — a short post-leave grace window; the idle timer flips it
    //     off after COMET_IDLE_MS so the fade-out matches the search's settle.
    // The shared `.ai-typing` class is applied while (hovering || settling).
    const [hovering, setHovering] = useState(false);
    const [settling, setSettling] = useState(false);
    const idleTimer = useRef(null);
    const startHover = useCallback(() => {
        // Any deliberate engagement with the FAB (hover or keyboard focus) means
        // the user has DISCOVERED it — retire the one-time hint immediately so it
        // never nags again. Idempotent in the hook, so calling it every hover is
        // free after the first.
        dismissHint();
        clearTimeout(idleTimer.current);
        setHovering(true);
        setSettling(false);
    }, [dismissHint]);
    const endHover = useCallback(() => {
        setHovering(false);
        setSettling(true);
        clearTimeout(idleTimer.current);
        idleTimer.current = setTimeout(() => setSettling(false), COMET_IDLE_MS);
    }, []);
    const cometActive = hovering || settling;
    // Clear the idle timer on unmount so it can't setState on a gone component.
    useEffect(() => () => clearTimeout(idleTimer.current), []);

    // While the panel is open, replicate the base Modal's open behaviour so this
    // bespoke panel is INDISTINGUISHABLE from every other modal:
    //   • lock body scroll
    //   • close on Escape
    //   • move focus into the search box (accessibility)
    //   • frost the app behind it by adding `blur-sm` (filter: blur) to #root
    //
    // The #root blur is the platform's canonical modal-backdrop mechanism (see
    // Modal.jsx). Reusing it means the Help Assistant automatically honours the
    // "Transparency effects" personalization toggle for free: when the user
    // turns it OFF, `html[data-transparency="off"] #root { filter: none }` in
    // index.css neutralises the blur here exactly as it does for Modal — no
    // per-component flag read required.
    useEffect(() => {
        if (!open) {
            // Panel just closed (and was previously open): return focus to the FAB
            // so keyboard/AT users land back on the control they opened, not at the
            // top of the document. Guarded by a ref so it fires only after a real
            // open→close, never on the initial mount.
            if (restoreFocusRef.current) {
                restoreFocusRef.current = false;
                fabRef.current?.focus();
            }
            return;
        }
        restoreFocusRef.current = true;

        const onKeyDown = (e) => {
            if (e.key === "Escape") closeAssistant();
        };
        document.addEventListener("keydown", onKeyDown);
        document.body.style.overflow = "hidden";

        const root = document.getElementById("root");
        if (root) root.classList.add("blur-sm");

        const focusTimer = setTimeout(() => {
            searchRef.current?.querySelector("input")?.focus();
        }, 50);

        return () => {
            document.removeEventListener("keydown", onKeyDown);
            document.body.style.overflow = "";
            if (root) root.classList.remove("blur-sm");
            clearTimeout(focusTimer);
        };
    }, [open, closeAssistant]);

    // Suppress the launcher entirely for automation roles (e.g. ROBOT) and on
    // routes that already ARE the help surface (/about/help). Placed AFTER all
    // hooks so the Rules of Hooks are honoured (hooks run every render; only the
    // render OUTPUT is gated). Renders nothing — no FAB and no Ctrl+K-triggered
    // panel. The hook force-closes `open` alongside this, because returning
    // null does not unmount and would otherwise strand the body scroll lock.
    if (hidden) return null;

    return (
        <>
            {/* ── Floating launcher button (visible on every route) ──
                Circular by default; on hover/focus it expands into a pill and
                reveals a "Need Help?" label (see .fab-label in index.css) rather
                than a native title tooltip. It stays rounded-full so the .ai-ring
                comet orbit follows the pill edge and stays visible throughout.

                POSITIONING: sits at bottom-6/right-6 and adds the iOS safe-area
                inset so it clears the home indicator on notched phones, and the
                extra gap keeps it clear of bottom-right toasts which stack above.

                DISCOVERABILITY: on a viewer's first ever visit `showHint` drives a
                one-time auto-peek of the label plus a soft attention pulse
                (.fab-hint — see index.css), retired permanently the instant the
                user hovers/focuses/opens it or after the hook's peek timeout. */}
            {!open && (
                <button
                    ref={fabRef}
                    type="button"
                    onClick={openAssistant}
                    onMouseEnter={startHover}
                    onMouseLeave={endHover}
                    onFocus={startHover}
                    onBlur={endHover}
                    aria-label="Open Help Assistant (Ctrl+K)"
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    aria-controls="help-assistant-panel"
                    className={`group ai-ring ai-ring-fab${cometActive ? " ai-typing" : ""}${showHint ? " fab-hint" : ""} fixed bottom-6 right-6 z-40 flex items-center justify-center h-14 rounded-full
                        bg-orange-400 text-white shadow-lg shadow-orange-400/30
                        hover:bg-orange-500 focus-visible:bg-orange-500 ${BUTTON_SPRING}
                        dark:shadow-black/40 font-aumovio`}
                    style={{ marginBottom: "env(safe-area-inset-bottom, 0px)", marginRight: "env(safe-area-inset-right, 0px)" }}
                >
                    {/* Icon box is a full 3.5rem circle while collapsed (icon
                        centred) and shrinks on hover so the expanded pill spaces
                        the icon and label evenly — see .fab-icon-box / .fab-label
                        in index.css. The comet orbit follows the pill edge. */}
                    <span className="fab-icon-box flex items-center justify-center h-14 shrink-0">
                        <QuestionMarkCircleIcon className="w-7 h-7 shrink-0" />
                    </span>
                    <span className="fab-label text-sm font-semibold leading-none">Need Help?</span>
                </button>
            )}

            {/* ── Assistant panel (portalled, chatbot-like) ── */}
            {open &&
                createPortal(
                    <div className={`fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/50 ${ANIMATE_FADE_IN}`} role="dialog" aria-modal="true" aria-labelledby="help-assistant-title" aria-describedby="help-assistant-subtitle" onClick={closeAssistant}>
                        <div
                            id="help-assistant-panel"
                            className={`relative flex flex-col w-full sm:max-w-2xl max-h-[92vh] sm:max-h-[80vh]
                                bg-(--bg-surface) dark:bg-(--bg-surface-2)
                                rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden font-aumovio
                                ${ANIMATE_SCALE_IN}`}
                            onClick={(e) => e.stopPropagation()}
                        >
                            {/* Header: identity + search */}
                            <div className="flex-none px-5 pt-4 pb-3 border-b border-grey-200 dark:border-grey-700">
                                <div className="flex items-center justify-between gap-3 mb-3">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <span className="flex items-center justify-center w-8 h-8 rounded-full bg-orange-400/10 text-(--accent-icon) shrink-0">
                                            <QuestionMarkCircleIcon className="w-5 h-5" />
                                        </span>
                                        <div className="min-w-0">
                                            <h2 id="help-assistant-title" className="text-sm font-aumovio-bold text-black/85 dark:text-white/90 leading-tight">Help Assistant</h2>
                                            <p id="help-assistant-subtitle" className="text-[11px] text-grey-500 dark:text-white/45 leading-tight">Ask a question — the matching article appears here.</p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={closeAssistant}
                                        aria-label="Close"
                                        className={`flex items-center justify-center rounded-lg w-7 h-7 shrink-0 text-grey-400 hover:text-grey-600 dark:hover:text-grey-300 hover:bg-grey-100 dark:hover:bg-(--bg-surface-3) ${TRANSITION_COLORS}`}
                                    >
                                        <XMarkIcon className="w-4 h-4" />
                                    </button>
                                </div>

                                <div ref={searchRef}>
                                    <SearchInput value={query} onChange={setQuery} placeholder="Search help — e.g. “session timeout”, “logging”, “metrics”…" debounce={120} size="md" />
                                </div>
                            </div>

                            {/* Body: results / starter prompts / empty state */}
                            <div className="flex-1 overflow-y-auto hide-scrollbar px-5 py-4">
                                {/* Idle — no query yet: show starter prompts */}
                                {!hasQuery && (
                                    <div className={ANIMATE_FADE_IN}>
                                        <p className="text-[11px] uppercase tracking-wide font-aumovio-bold text-grey-400 dark:text-white/40 mb-3">Try asking</p>
                                        <div className="flex flex-col gap-2">
                                            {STARTER_PROMPTS.map((prompt, i) => (
                                                <button
                                                    key={prompt}
                                                    type="button"
                                                    onClick={() => setQuery(prompt)}
                                                    className={`flex items-center gap-2 text-left rounded-xl px-3 py-2.5 text-sm
                                                        text-black/75 dark:text-white/80
                                                        bg-grey-50 dark:bg-white/5 hover:bg-grey-100 dark:hover:bg-white/10
                                                        border border-transparent hover:border-grey-200 dark:hover:border-white/10
                                                        ${TRANSITION_COLORS} ${ANIMATE_FADE_IN_UP} ${staggerDelay(i)}`}
                                                >
                                                    <MagnifyingGlassIcon className="w-4 h-4 shrink-0 text-grey-400" />
                                                    <span className="min-w-0">{prompt}</span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Results */}
                                {hasQuery && results.length > 0 && (
                                    <div className="space-y-1">
                                        <div className="flex items-center justify-between mb-3">
                                            <p className="text-[11px] text-grey-500 dark:text-white/45">
                                                {totalMatches} {totalMatches === 1 ? "article" : "articles"} found
                                            </p>
                                        </div>
                                        {results.map((result, i) => (
                                            <div key={`${result.categoryId}-${result.article.id}`} className={`rounded-xl border border-grey-200/70 dark:border-white/10 px-3 py-2 ${ANIMATE_FADE_IN_UP} ${staggerDelay(i)}`}>
                                                <div className="flex items-center gap-2 mb-1">
                                                    <Badge variant={BADGE_VARIANTS[result.categoryColor] ?? "grey"} size="sm" pill>
                                                        {result.categoryLabel}
                                                    </Badge>
                                                </div>
                                                <HelpArticleCard article={result.article} dotColor={DOT_COLORS[result.categoryColor] ?? "bg-grey-400"} showLine={false} expanded={expandedArticleId === result.article.id} onToggle={toggleArticle} />
                                            </div>
                                        ))}
                                        {capped && <p className="pt-2 text-center text-[11px] text-grey-400 dark:text-white/40">Showing the top {results.length} of {totalMatches}. Open the full Help Center to see them all.</p>}
                                    </div>
                                )}

                                {/* Empty — query typed, no matches. Always offers a
                                    way forward: a "did you mean?" correction when a
                                    close corpus word exists, then a clear-search and a
                                    full-Help-Center fallback so the user is never left
                                    at a dead end. */}
                                {hasQuery && results.length === 0 && (
                                    <div className={`flex flex-col items-center text-center py-10 ${ANIMATE_FADE_IN}`}>
                                        <span className="flex items-center justify-center w-12 h-12 rounded-full bg-grey-100 dark:bg-white/5 text-grey-400 mb-3">
                                            <MagnifyingGlassIcon className="w-6 h-6" />
                                        </span>
                                        <p className="text-sm font-aumovio-bold text-black/80 dark:text-white/85">Sorry, I couldn’t find anything for “{query.trim()}”</p>

                                        {suggestion ? (
                                            <p className="text-xs text-grey-500 dark:text-white/45 mt-1 max-w-xs">
                                                Did you mean{" "}
                                                <button
                                                    type="button"
                                                    onClick={applySuggestion}
                                                    className={`font-aumovio-bold text-(--text-accent) hover:text-(--text-accent-hover) underline underline-offset-2 ${TRANSITION_COLORS}`}
                                                >
                                                    {suggestion}
                                                </button>
                                                ?
                                            </p>
                                        ) : (
                                            <p className="text-xs text-grey-500 dark:text-white/45 mt-1 max-w-xs">Try a shorter keyword, or browse everything in the full Help Center.</p>
                                        )}

                                        <div className="flex items-center gap-4 mt-4">
                                            <button type="button" onClick={clearQuery} className={`text-xs font-aumovio-bold text-(--text-accent) hover:text-(--text-accent-hover) ${TRANSITION_COLORS}`}>
                                                Clear search
                                            </button>
                                            <button type="button" onClick={goToHelpCenter} className={`inline-flex items-center gap-1 text-xs font-aumovio-bold text-grey-500 dark:text-white/50 hover:text-grey-700 dark:hover:text-white/80 ${TRANSITION_COLORS}`}>
                                                Browse Help Center <ArrowRightIcon className="w-3.5 h-3.5" />
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Footer: full Help Center CTA + shortcut hint */}
                            <div className="flex-none flex items-center justify-between gap-3 px-5 py-3 border-t border-grey-200 dark:border-grey-700 bg-grey-50 dark:bg-white/5">
                                <span className="hidden sm:flex items-center gap-1.5 text-[11px] text-grey-400 dark:text-white/40">
                                    <KBD keys={["Ctrl", "K"]} size="sm" /> to toggle
                                </span>
                                <Button variant="ghost" size="sm" rightIcon={ArrowRightIcon} onClick={goToHelpCenter}>
                                    Open full Help Center
                                </Button>
                            </div>
                        </div>
                    </div>,
                    document.body,
                )}
        </>
    );
}

export default HelpAssistant;
