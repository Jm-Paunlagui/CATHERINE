/**
 * StatusFilterPills.jsx — inline pill row for filtering a list by status.
 *
 * Deliberately dumb: no state, no data fetching, no page reset. The caller
 * owns `value` and decides what a change means — one list may filter
 * client-side over rows it already holds, while a server-paged panel sends
 * `status` to the server and must also reset paging. Baking either
 * behaviour in here would break the other.
 *
 * The "all" option is just an entry in `options` whose value is whatever the
 * caller uses for it (e.g. `"ALL"` or `""` when it goes straight onto the
 * query string). No sentinel is assumed.
 */

/**
 * @param {object} props
 * @param {Array<{ value: string, label: string }>} props.options
 * @param {string}   props.value      - Currently selected option value
 * @param {Function} props.onChange   - (value: string) => void
 * @param {string}   [props.ariaLabel] - Group label for screen readers
 * @param {string}   [props.className] - Extra classes on the wrapper
 */
export default function StatusFilterPills({ options = [], value, onChange, ariaLabel = "Filter by status", className = "" }) {
    return (
        <div className={`flex gap-2 flex-wrap ${className}`} role="group" aria-label={ariaLabel}>
            {options.map((opt) => {
                const active = opt.value === value;
                return (
                    <button
                        key={opt.value}
                        type="button"
                        aria-pressed={active}
                        onClick={() => onChange(opt.value)}
                        className={`px-3 py-1 rounded-full text-[11.5px] font-aumovio-bold transition-colors duration-150 ${active ? "bg-(--accent) text-(--on-accent-text)" : "bg-grey-100 dark:bg-white/10 text-grey-500 dark:text-white/40 hover:bg-grey-200 dark:hover:bg-white/15"}`}
                    >
                        {opt.label}
                    </button>
                );
            })}
        </div>
    );
}
