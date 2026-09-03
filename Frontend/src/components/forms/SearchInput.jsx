// (See full SearchBar in SearchBar.jsx — this is the standalone form version)
import { MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useRef, useState } from "react";
import { TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";

/** How long after the last keystroke the AI comet keeps running before it fades
 *  out. Long enough that continuous typing never flickers, short enough that the
 *  effect clearly responds to *typing* and settles once you pause. */
const COMET_IDLE_MS = 900;

export function SearchInput({ value = "", onChange, onSubmit, placeholder = "Search…", disabled = false, loading = false, suggestions = [], onSuggestionSelect, debounce = 0, size = "md", comet = true }) {
    const [local, setLocal] = useState(value);
    const [showSug, setShowSug] = useState(false);
    const timer = useRef(null);

    // ── AI comet "actively typing" state ──────────────────────────────────────
    // The comet should run WHILE typing and stop shortly after the user pauses —
    // not merely whenever the box has text. CSS can't detect "stopped typing", so
    // we track it here: each keystroke sets `typing` true and (re)arms an idle
    // timer; when the timer fires, `typing` flips false and the comet fades out.
    const [typing, setTyping] = useState(false);
    const idleTimer = useRef(null);
    const pokeTyping = useCallback(() => {
        setTyping(true);
        clearTimeout(idleTimer.current);
        idleTimer.current = setTimeout(() => setTyping(false), COMET_IDLE_MS);
    }, []);
    // Clean up the idle timer on unmount so it can't setState on a gone component.
    useEffect(() => () => clearTimeout(idleTimer.current), []);

    // Re-sync `local` when `value` changes for reasons OTHER than this input's
    // own typing (e.g. a parent "Clear filters" action resetting the prop).
    // Adjusted during render — not in a useEffect — per React's documented
    // "adjusting state when a prop changes" pattern: it avoids the extra
    // commit + visible flash of the stale `local` value that a post-render
    // effect setState would cause, while still letting `local` diverge freely
    // from `value` between keystrokes (unlike deriving `local` directly from
    // `value` on every render, which would fight the debounced typing below).
    const [prevValue, setPrevValue] = useState(value);
    if (value !== prevValue) {
        setPrevValue(value);
        setLocal(value);
    }
    const SZ = {
        sm: "py-2 text-xs pl-8 pr-8",
        md: "py-2 text-sm pl-9 pr-9",
        lg: "py-3 text-base pl-10 pr-10",
    };
    const ICON = {
        sm: "w-4 h-4 left-2",
        md: "w-4 h-4 left-3",
        lg: "w-5 h-5 left-3",
    };
    // Right-slot offset mirrors the left icon's per-size inset so the clear
    // button lines up symmetrically with the search icon (matches pr-8/9/10).
    const RIGHT = {
        sm: "right-2",
        md: "right-3",
        lg: "right-3",
    };

    const emit = useCallback(
        (v) => {
            clearTimeout(timer.current);
            if (debounce > 0) timer.current = setTimeout(() => onChange?.(v), debounce);
            else onChange?.(v);
        },
        [onChange, debounce],
    );

    return (
        // `ai-ring ai-ring-focus` adds the AI "comet" sweep on the border. The
        // `ai-typing` class (added only while the user is actively typing) is what
        // actually runs the sweep — it fades in on the first keystroke and fades
        // out ~COMET_IDLE_MS after the user pauses, even if text remains. Effect
        // is theme-aware and honours reduced-motion. Opt out with `comet={false}`.
        <div className={`relative w-full font-aumovio${comet ? " ai-ring ai-ring-focus rounded-xl" : ""}${comet && typing ? " ai-typing" : ""}`}>
            <MagnifyingGlassIcon className={`absolute top-1/2 -translate-y-1/2 ${ICON[size]} text-grey-400 pointer-events-none`} />
            <input
                type="search"
                value={local}
                onChange={(e) => {
                    setLocal(e.target.value);
                    emit(e.target.value);
                    setShowSug(true);
                    pokeTyping();
                }}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        // Cancel the pending debounce — otherwise it fires after submit
                        // with the pre-submit value, re-populating the box via onChange
                        // and firing a redundant request.
                        clearTimeout(timer.current);
                        onSubmit?.(local);
                        setShowSug(false);
                    }
                }}
                onBlur={() => setTimeout(() => setShowSug(false), 150)}
                placeholder={placeholder}
                disabled={disabled}
                className={`w-full rounded-xl border font-aumovio
          bg-white dark:bg-(--bg-surface-2) text-black/85 dark:text-(--text-primary) placeholder-grey-400
          border-grey-300 dark:border-grey-700
          focus:outline-none focus:ring-2 focus:ring-orange-400/30 focus:border-orange-400
          ${TRANSITION_COLORS} disabled:opacity-50
          [&::-webkit-search-cancel-button]:appearance-none
          [&::-webkit-search-decoration]:appearance-none
          [&::-ms-clear]:hidden
          ${SZ[size] ?? SZ.md}`}
            />
            <span className={`absolute top-1/2 -translate-y-1/2 flex items-center justify-center ${RIGHT[size] ?? RIGHT.md}`}>
                {loading ? (
                    <span className="w-3.5 h-3.5 border-2 border-orange-400 border-t-transparent rounded-full animate-spin block" />
                ) : (
                    local && (
                        <button
                            type="button"
                            aria-label="Clear search"
                            onClick={() => {
                                setLocal("");
                                onChange?.("");
                            }}
                            className="flex items-center justify-center"
                        >
                            <XMarkIcon className={`w-4 h-4 ${TRANSITION_COLORS} text-grey-400 hover:text-(--accent-foreground)`} />
                        </button>
                    )
                )}
            </span>
            {showSug && suggestions.length > 0 && (
                <ul
                    className="absolute top-full left-0 right-0 mt-1 z-50 bg-white dark:bg-(--bg-surface-2)
          border border-grey-200 dark:border-grey-700 rounded-xl shadow-2xl overflow-hidden"
                >
                    {suggestions.map((s, i) => (
                        <li
                            key={i}
                            onMouseDown={() => {
                                onSuggestionSelect?.(s);
                                setLocal(s);
                                setShowSug(false);
                            }}
                            className="px-4 py-3 text-sm cursor-pointer hover:bg-orange-50 dark:hover:bg-orange-400/5
                hover:text-(--accent-foreground) flex items-center gap-2"
                        >
                            <MagnifyingGlassIcon className="w-3.5 h-3.5 text-grey-400 shrink-0" />
                            {s}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

export default SearchInput;
