/**
 * Button — Polymorphic button component.
 *
 * Props:
 *   variant  — 'primary'|'accent'|'danger'|'warning'|'ghost'|'outline'|'link'|'gradient'
 *   size     — 'xs'|'sm'|'md'|'lg'|'xl'
 *   loading  — boolean
 *   disabled — boolean
 *   fullWidth — boolean
 *   leftIcon  — icon component
 *   rightIcon — icon component
 *   rounded  — boolean (pill shape)
 *   onClick, type, className, children
 */
import { RIPPLE_HOST, TRANSITION_BUTTON } from "../../assets/styles/pre-set-styles";

const BASE = [
    "inline-flex items-center justify-center gap-2 font-aumovio-bold tracking-wide",
    TRANSITION_BUTTON,
    "hover:-translate-y-0.5 hover:scale-[1.02] active:scale-[0.98]",
    "backface-hidden border",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-[var(--bg-surface)]",
    "disabled:opacity-60 disabled:cursor-not-allowed disabled:pointer-events-none",
].join(" ");

const VARIANTS = {
    primary: "text-orange-400 bg-orange-400/10 dark:bg-orange-400/20 border-orange-400/25 dark:border-orange-400/40 hover:bg-orange-400 hover:text-white hover:border-transparent hover:shadow-xl hover:shadow-orange-400/30 dark:hover:shadow-orange-400/50 focus-visible:ring-orange-400",
    accent: "text-purple-400 dark:text-purple-300 bg-purple-400/10 dark:bg-purple-400/20 border-purple-400/20 dark:border-purple-400/35 hover:bg-purple-400 hover:text-white hover:border-transparent hover:shadow-xl hover:shadow-purple-400/30 dark:hover:shadow-purple-400/50 focus-visible:ring-purple-400",
    danger: "text-danger-400 dark:text-danger-300 bg-danger-100 dark:bg-danger-400/15 border-danger-400/20 dark:border-danger-400/35 hover:bg-danger-400 hover:text-white hover:border-transparent hover:shadow-xl hover:shadow-danger-400/30 dark:hover:shadow-danger-400/50 focus-visible:ring-danger-400",
    warning: "text-warn-600 dark:text-warn-400 bg-warn-100/30 dark:bg-warn-400/15 border-warn-400/30 hover:bg-warn-400 hover:text-black hover:border-transparent hover:shadow-xl hover:shadow-warn-400/30 dark:hover:shadow-warn-400/50 focus-visible:ring-warn-400",
    ghost: "text-grey-600 dark:text-grey-300 bg-transparent border-grey-200 dark:border-grey-700 hover:bg-grey-100 dark:hover:bg-(--bg-surface-3) hover:text-black dark:hover:text-white focus-visible:ring-grey-400",
    outline: "text-orange-400 bg-transparent border-orange-400 hover:bg-orange-400 hover:text-white hover:shadow-lg hover:shadow-orange-400/30 dark:hover:shadow-orange-400/50 focus-visible:ring-orange-400",
    link: "text-orange-400 bg-transparent border-transparent hover:underline underline-offset-2 hover:translate-y-0 hover:scale-100 focus-visible:ring-orange-400",
    gradient: "text-[var(--color-gradient-text)] bg-linear-to-r from-(--color-gradient-from) to-(--color-gradient-to) border-0 hover:shadow-xl hover:shadow-orange-400/40 dark:hover:shadow-orange-400/60 hover:brightness-110 dark:hover:brightness-125 disabled:grayscale focus-visible:ring-orange-400",
};

const SIZES = {
    xs: "px-2.5 py-1    text-xs rounded-md",
    sm: "px-3   py-1.5  text-xs rounded-lg",
    md: "px-4   py-2    text-sm rounded-lg",
    lg: "px-5   py-2.5  text-base rounded-lg",
    xl: "px-7   py-3.5  text-base rounded-xl",
};

export default function Button({ variant = "primary", size = "md", loading = false, disabled = false, fullWidth = false, leftIcon: LeftIcon, rightIcon: RightIcon, rounded = false, onClick, type = "button", className = "", children }) {
    const handleClick = (e) => {
        onClick?.(e);
        const btn = e.currentTarget;
        const circle = document.createElement("span");
        const diameter = Math.max(btn.clientWidth, btn.clientHeight);
        const radius = diameter / 2;
        const rect = btn.getBoundingClientRect();
        circle.style.cssText = `width:${diameter}px;height:${diameter}px;left:${e.clientX - rect.left - radius}px;top:${e.clientY - rect.top - radius}px`;
        circle.classList.add("ripple");
        btn.querySelector(".ripple")?.remove();
        btn.appendChild(circle);
    };

    return (
        <button
            type={type}
            onClick={handleClick}
            disabled={disabled || loading}
            className={`${BASE} ${RIPPLE_HOST} ${VARIANTS[variant] ?? VARIANTS.primary}
        ${SIZES[size] ?? SIZES.md}
        ${fullWidth ? "w-full" : ""}
        ${rounded ? "rounded-full!" : ""}
        ${className}`}
        >
            {loading ? <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin shrink-0" /> : LeftIcon && <LeftIcon className="w-4 h-4 shrink-0" />}
            {children}
            {!loading && RightIcon && <RightIcon className="w-4 h-4 shrink-0" />}
        </button>
    );
}
