// (See full SearchBar in SearchBar.jsx — this is the standalone form version)
import { MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useRef, useState } from "react";
import { TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";

export function SearchInput({ value = "", onChange, onSubmit, placeholder = "Search…", disabled = false, loading = false, suggestions = [], onSuggestionSelect, debounce = 0, size = "md" }) {
    const [local, setLocal] = useState(value);
    const [showSug, setShowSug] = useState(false);
    const timer = useRef(null);
    const SZ = {
        sm: "py-1.5 text-xs pl-8 pr-8",
        md: "py-2 text-sm pl-9 pr-9",
        lg: "py-3 text-base pl-10 pr-10",
    };
    const ICON = {
        sm: "w-4 h-4 left-2",
        md: "w-4 h-4 left-3",
        lg: "w-5 h-5 left-3",
    };

    const emit = useCallback(
        (v) => {
            clearTimeout(timer.current);
            if (debounce > 0) timer.current = setTimeout(() => onChange?.(v), debounce);
            else onChange?.(v);
        },
        [onChange, debounce],
    );

    useEffect(() => setLocal(value), [value]);

    return (
        <div className="relative w-full font-aumovio">
            <MagnifyingGlassIcon className={`absolute top-1/2 -translate-y-1/2 ${ICON[size]} text-grey-400 pointer-events-none`} />
            <input
                type="search"
                value={local}
                onChange={(e) => {
                    setLocal(e.target.value);
                    emit(e.target.value);
                    setShowSug(true);
                }}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
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
          ${SZ[size] ?? SZ.md}`}
            />
            <span className="absolute -translate-y-1/2 right-3 top-1/2">
                {loading ? (
                    <span className="w-3.5 h-3.5 border-2 border-orange-400 border-t-transparent rounded-full animate-spin block" />
                ) : (
                    local && (
                        <button
                            onClick={() => {
                                setLocal("");
                                onChange?.("");
                            }}
                        >
                            <XMarkIcon className={`w-4 h-4 ${TRANSITION_COLORS} text-grey-400 hover:text-orange-400`} />
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
                            className="px-4 py-2.5 text-sm cursor-pointer hover:bg-orange-50 dark:hover:bg-orange-400/5
                hover:text-orange-400 flex items-center gap-2"
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
