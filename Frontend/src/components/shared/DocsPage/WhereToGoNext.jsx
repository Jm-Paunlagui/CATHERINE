/**
 * WhereToGoNext.jsx — "Where to Go Next" link grid for documentation pages.
 *
 * Two item shapes:
 *   { label, desc, to }   → an in-app route → renders a React Router <Link> (clickable)
 *   { code, desc }        → a repo file path → renders plain, non-clickable reference text
 *
 * Shared (tier 3) by docs-style views.
 */

import { faArrowRight } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Link } from "react-router-dom";
import { BASE_COLOR_BG, BASE_COLOR_TEXT, STANDARD_BORDER, TITLE_COLOR_TEXT, TRANSITION_SMOOTH } from "../../../assets/styles/pre-set-styles";

/**
 * @param {object} props
 * @param {Array<{label?: string, code?: string, desc: string, to?: string}>} props.items
 *        `to` set → in-app link; otherwise a plain repo-file reference (use `code`).
 * @returns {JSX.Element}
 */
export function WhereToGoNext({ items }) {
    return (
        <div className="grid gap-3 sm:grid-cols-2">
            {items.map((item) =>
                item.to ? (
                    <Link key={item.to} to={item.to} className={`group block p-4 rounded-xl ${BASE_COLOR_BG} ${STANDARD_BORDER} ${TRANSITION_SMOOTH} hover:border-orange-400/30`}>
                        <div className="flex items-center justify-between gap-2">
                            <span className={`text-sm font-aumovio-bold ${TITLE_COLOR_TEXT}`}>{item.label}</span>
                            <FontAwesomeIcon icon={faArrowRight} className={`w-3.5 h-3.5 text-(--accent-icon) ${TRANSITION_SMOOTH} group-hover:translate-x-0.5`} />
                        </div>
                        <p className={`text-xs mt-1 ${BASE_COLOR_TEXT} opacity-70`}>{item.desc}</p>
                    </Link>
                ) : (
                    <div key={item.code} className={`p-4 rounded-xl ${BASE_COLOR_BG} ${STANDARD_BORDER}`}>
                        <code className="text-xs font-mono text-orange-400 dark:text-orange-300">{item.code}</code>
                        <p className={`text-xs mt-1 ${BASE_COLOR_TEXT} opacity-70`}>{item.desc}</p>
                    </div>
                ),
            )}
        </div>
    );
}

export default WhereToGoNext;
