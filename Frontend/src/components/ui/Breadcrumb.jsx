/**
 * Breadcrumb — Page hierarchy navigation.
 *
 * Supports two modes:
 *
 * 1. **Manual** — pass `items` array explicitly.
 *    items     — [{ label, href?, icon? }]  (last item = current, no link)
 *
 * 2. **Auto** — set `auto` prop. Reads the current URL and builds
 *    breadcrumb segments automatically (Home / Admin / Analytics).
 *
 * Common props:
 *   separator — 'slash' | 'chevron' | 'dot'
 *   size      — 'sm' | 'md'
 *   homeIcon  — boolean (show home icon on first item)
 *   variant   — 'inline' | 'bar'
 *               'inline' = transparent, embeds anywhere (default)
 *               'bar'    = orange banner strip with white text
 *   labels    — { [segment]: string } custom display names for URL segments
 *               e.g. { "admin": "Administration", "qa": "Quality Assurance" }
 *   exclude   — string[] segments to hide (e.g. ['api', 'v1'])
 */
import { ChevronRightIcon, HomeIcon } from "@heroicons/react/24/outline";
import { NavLink, useLocation } from "react-router-dom";
import { MAIN_OVERLAY_COLOR_TEXT, MAIN_STRONG_COLOR_BG } from "../../assets/styles/pre-set-styles";

const SEPARATORS = {
    slash: <span className="select-none text-grey-400 dark:text-grey-500">/</span>,
    chevron: <ChevronRightIcon className="w-3.5 h-3.5 text-grey-400 dark:text-grey-500 shrink-0" />,
    dot: <span className="w-1 h-1 rounded-full bg-grey-400 dark:bg-grey-500 shrink-0" />,
};

const BAR_SEPARATORS = {
    slash: <span className="select-none text-white/60 dark:text-grey-500">/</span>,
    chevron: <ChevronRightIcon className="w-3.5 h-3.5 text-white/60 dark:text-grey-500 shrink-0" />,
    dot: <span className="w-1 h-1 rounded-full bg-white/60 dark:bg-grey-500 shrink-0" />,
};

/**
 * Capitalise a URL segment into a human-friendly label.
 * Handles kebab-case and camelCase: "user-settings" → "USER Settings"
 */
function humanise(segment) {
    return segment
        .replace(/[-_]/g, " ")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Build items array from the current pathname.
 */
function buildAutoItems(pathname, labels = {}, exclude = []) {
    const segments = pathname.split("/").filter((s) => s && !exclude.includes(s.toLowerCase()));

    if (segments.length === 0) {
        return [{ label: "Home" }];
    }

    const items = [{ label: "Home", href: "/" }];

    segments.forEach((seg, i) => {
        const href = "/" + segments.slice(0, i + 1).join("/");
        const label = labels[seg.toLowerCase()] ?? labels[seg] ?? humanise(seg);
        const isLast = i === segments.length - 1;
        items.push({ label, href: isLast ? undefined : href });
    });

    return items;
}

export function Breadcrumb({ items, auto = false, separator = "chevron", size = "md", homeIcon = true, variant = "inline", labels = {}, exclude = [] }) {
    // Hooks must be called unconditionally — call useLocation always and only
    // consume the pathname when auto-derivation is requested.
    const location = useLocation();
    const resolvedItems = auto ? buildAutoItems(location.pathname, labels, exclude) : (items ?? []);

    const textSz = size === "sm" ? "text-sm" : "text-base";
    const isBar = variant === "bar";

    const crumbs = (
        <nav aria-label="Breadcrumb" className={`flex items-center gap-1.5 flex-wrap font-aumovio ${textSz}`}>
            {resolvedItems.map((item, i) => {
                const isLast = i === resolvedItems.length - 1;
                const seps = isBar ? BAR_SEPARATORS : SEPARATORS;

                return (
                    <div key={`${item.label}-${i}`} className="flex items-center gap-1.5">
                        {i > 0 && (seps[separator] ?? seps.chevron)}

                        {isLast ? (
                            <span className={`flex items-center gap-1 font-aumovio-bold ${isBar ? `${MAIN_OVERLAY_COLOR_TEXT} dark:text-(--text-accent) dark:drop-shadow-none rounded px-2 py-0.5` : "text-(--text-accent)"}`} aria-current="page">
                                {item.icon && <item.icon className="w-3.5 h-3.5" />}
                                {item.label}
                            </span>
                        ) : item.href ? (
                            <NavLink to={item.href} className={`flex items-center gap-1 transition-colors duration-200 ${isBar ? "text-white/70 hover:text-white dark:text-grey-400 dark:hover:text-(--text-accent)" : "text-grey-500 dark:text-grey-400 hover:text-(--text-accent)"}`}>
                                {i === 0 && homeIcon ? <HomeIcon className="w-3.5 h-3.5" /> : item.icon && <item.icon className="w-3.5 h-3.5" />}
                                {item.label}
                            </NavLink>
                        ) : (
                            <span className={`flex items-center gap-1 ${isBar ? "text-white/70 dark:text-grey-400" : "text-grey-500 dark:text-grey-400"}`}>
                                {i === 0 && homeIcon ? <HomeIcon className="w-3.5 h-3.5" /> : item.icon && <item.icon className="w-3.5 h-3.5" />}
                                {item.label}
                            </span>
                        )}
                    </div>
                );
            })}
        </nav>
    );

    if (isBar) {
        return (
            <div className={`${MAIN_STRONG_COLOR_BG} dark:bg-(--surface-1) dark:shadow-none dark:border-b dark:border-(--border-elevation) shadow`}>
                <div className="px-4  mx-auto">
                    <div className="flex items-center w-full py-3">{crumbs}</div>
                </div>
            </div>
        );
    }

    return crumbs;
}

export default Breadcrumb;
