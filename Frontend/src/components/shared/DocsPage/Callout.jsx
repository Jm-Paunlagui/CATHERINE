/**
 * Callout.jsx — Tinted note/warning box for documentation pages.
 *
 * Shared (tier 3) by docs-style views. Three tones map to semantic tokens.
 */

import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { BASE_COLOR_TEXT } from "../../../assets/styles/pre-set-styles";

const TONES = {
    blue: "border-blue-400/30 bg-blue-400/5",
    warn: "border-warn-400/30 bg-warn-400/5",
    danger: "border-danger-400/30 bg-danger-400/5",
    success: "border-success-400/30 bg-success-400/5",
};

const TITLE_TONES = {
    blue: "text-blue-500 dark:text-blue-300",
    warn: "text-warn-500 dark:text-warn-300",
    danger: "text-danger-500 dark:text-danger-300",
    success: "text-success-500 dark:text-success-300",
};

/**
 * @param {object} props
 * @param {"blue"|"warn"|"danger"|"success"} [props.tone="blue"]
 * @param {object} [props.icon]  FontAwesome icon definition.
 * @param {string}  props.title
 * @param {React.ReactNode} props.children
 * @returns {JSX.Element}
 */
export function Callout({ tone = "blue", icon, title, children }) {
    return (
        <div className={`mt-4 p-4 rounded-xl border ${TONES[tone]}`}>
            <p className={`text-sm font-semibold flex items-center gap-2 ${TITLE_TONES[tone]}`}>
                {icon && <FontAwesomeIcon icon={icon} className="w-3.5 h-3.5" />}
                {title}
            </p>
            <div className={`text-sm mt-1 ${BASE_COLOR_TEXT} opacity-80`}>{children}</div>
        </div>
    );
}

export default Callout;
