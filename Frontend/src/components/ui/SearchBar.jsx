/**
 * SearchBar.jsx — Debounce-aware search input.
 *
 * Props:
 *   value        — controlled string value
 *   onChange     — (value: string) => void
 *   placeholder  — string  (default: 'Search…')
 *   disabled     — boolean
 *   isDebouncing — boolean — shows spinner when input !== debounced value
 *   onClear      — () => void  (optional, ✕ button shown when value is set)
 *   className    — extra wrapper classes
 *
 * Usage with useDebounce:
 *   const [input, setInput] = useState('');
 *   const debounced = useDebounce(input, 300);
 *   <SearchBar value={input} onChange={setInput} isDebouncing={input !== debounced} />
 */

export function SearchBar({ value = "", onChange, placeholder = "Search…", disabled = false, isDebouncing = false, onClear, className = "" }) {
    return (
        <div
            className={`relative flex items-center bg-(--bg-surface) dark:bg-(--bg-surface-2) border border-grey-200 dark:border-grey-700 rounded-lg
                shadow-sm focus-within:ring-2 focus-within:ring-orange-400/40
                focus-within:border-orange-400/50 focus-within:shadow-md
                focus-within:shadow-orange-400/10 transition-all duration-300 ${className}`}
        >
            {/* Search icon */}
            <span className="absolute left-3 text-grey-400 pointer-events-none shrink-0">
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                    <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
            </span>

            <input
                type="text"
                value={value}
                onChange={(e) => onChange?.(e.target.value)}
                placeholder={placeholder}
                disabled={disabled}
                className="w-full pl-9 pr-9 py-2 text-sm font-aumovio tracking-wide
                    text-black/85 dark:text-white/85 bg-transparent outline-none
                    placeholder-grey-400 disabled:opacity-50 disabled:cursor-not-allowed"
            />

            {/* Right slot: spinner or clear button */}
            <span className="absolute right-3 flex items-center">
                {isDebouncing ? (
                    <span
                        className="w-3.5 h-3.5 border-2 border-orange-400
                            border-t-transparent rounded-full animate-spin"
                    />
                ) : value ? (
                    <button type="button" onClick={() => (onClear ? onClear() : onChange?.(""))} aria-label="Clear search" className="text-grey-400 hover:text-(--accent-foreground) transition-colors">
                        <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                            <path d="M13 1L1 13M1 1l12 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                        </svg>
                    </button>
                ) : null}
            </span>
        </div>
    );
}

export default SearchBar;
