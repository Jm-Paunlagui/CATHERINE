/**
 * DefRow.jsx — A two-column definition row (<tr>) for docs tables.
 *
 * Left cell = monospace name/key chip; right cell = description. Render inside a
 * <table><tbody> on a docs page. Shared (tier 3) by docs-style views.
 */

import { BASE_COLOR_TEXT } from "../../../assets/styles/pre-set-styles";

/**
 * @param {object} props
 * @param {string} props.name   Key/identifier shown as a monospace chip.
 * @param {React.ReactNode} props.value  Description cell.
 * @returns {JSX.Element}
 */
export function DefRow({ name, value }) {
    return (
        <tr className="border-b border-grey-200/30 dark:border-grey-700/30">
            <td className="py-2.5 pr-4 align-top">
                <code className="text-xs font-mono px-1.5 py-0.5 rounded bg-orange-400/10 text-orange-400 dark:text-orange-300 whitespace-nowrap">{name}</code>
            </td>
            <td className={`py-2.5 text-sm ${BASE_COLOR_TEXT} opacity-80`}>{value}</td>
        </tr>
    );
}

export default DefRow;
