/**
 * Link — Styled anchor / NavLink.
 *
 * Props:
 *   href, external, variant ('default'|'primary'|'muted'|'danger'), children
 *   underline — 'always'|'hover'|'none'
 *   icon     — boolean (external link icon)
 */

import { ArrowTopRightOnSquareIcon } from "@heroicons/react/16/solid";
import { NavLink } from "react-router-dom";
import { TRANSITION_COLORS } from "../../../assets/styles/pre-set-styles";

const V = {
    default: "text-orange-400 hover:text-orange-500",
    primary: "text-orange-500 font-aumovio-bold hover:text-orange-600",
    muted: "text-grey-500 hover:text-grey-700 dark:text-grey-400 dark:hover:text-grey-200",
    danger: "text-danger-400 dark:text-danger-300 hover:text-danger-500 dark:hover:text-danger-200",
};

const UL = {
    always: "underline underline-offset-2",
    hover: "no-underline hover:underline underline-offset-2",
    none: "no-underline",
};

export function Link({ href = "#", external = false, variant = "default", underline = "hover", icon = false, children }) {
    const cls = `inline-flex items-center gap-1 font-aumovio ${TRANSITION_COLORS}
    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/50 rounded
    ${V[variant] ?? V.default} ${UL[underline] ?? UL.hover}`;

    if (external)
        return (
            <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
                {children}
                {icon && <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5 shrink-0 opacity-70" />}
            </a>
        );

    return (
        <NavLink to={href} className={cls}>
            {children}
        </NavLink>
    );
}

export default Link;
