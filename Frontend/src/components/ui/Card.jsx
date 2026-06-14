/**
 * Card — Versatile content container.
 *
 * Props:
 *   variant   — 'default'|'elevated'|'outlined'|'filled'|'glass'
 *   padding   — 'none'|'sm'|'md'|'lg'
 *   hover     — boolean (lift on hover)
 *   clickable — boolean
 *   onClick   — handler
 *   header    — ReactNode
 *   footer    — ReactNode
 *   image     — { src, alt, height? }
 *   children
 */
import { HOVER_LIFT, TRANSITION_SMOOTH, TRANSITION_TRANSFORM_SPRING } from "../../assets/styles/pre-set-styles";

const VARIANTS = {
    default: "bg-(--bg-surface) dark:bg-(--bg-surface-2) border border-grey-200 dark:border-grey-700 shadow-sm",
    elevated: "bg-(--bg-surface) dark:bg-(--bg-surface-2) shadow-xl border border-(--color-card-surface-border) dark:border-grey-800",
    outlined: "bg-transparent border-2 border-orange-400/30 dark:border-orange-400/20",
    filled: "bg-orange-400/5 dark:bg-orange-400/10 border border-(--color-card-surface-border)",
    glass: "bg-white/60 dark:bg-white/5 backdrop-blur-md border border-white/30 dark:border-white/15 shadow-xl dark:shadow-black/40",
};

const PAD = { none: "", sm: "p-4", md: "p-5 md:p-6", lg: "p-6 md:p-8" };

export function Card({ variant = "default", padding = "md", hover = false, clickable = false, onClick, onAnimationEnd, header, footer, image, className = "", children }) {
    const Tag = clickable ? "button" : "div";

    return (
        <Tag
            onClick={onClick}
            onAnimationEnd={onAnimationEnd}
            className={`rounded-xl overflow-hidden font-aumovio
        ${TRANSITION_SMOOTH}
        ${VARIANTS[variant] ?? VARIANTS.default}
        ${hover || clickable ? `${HOVER_LIFT} cursor-pointer` : ""}
        ${clickable ? "text-left w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400" : ""}
        ${className}`}
        >
            {image && (
                <div className={`overflow-hidden ${image.height ?? "h-48"}`}>
                    <img src={image.src} alt={image.alt ?? ""} className={`object-cover w-full h-full ${TRANSITION_TRANSFORM_SPRING} hover:scale-105`} />
                </div>
            )}
            {header && <div className="px-5 py-4 border-b border-grey-200 dark:border-grey-700 font-aumovio-bold text-black/85 dark:text-white/90">{header}</div>}
            <div className={PAD[padding] ?? PAD.md}>{children}</div>
            {footer && <div className="px-5 py-4 border-t border-grey-200 dark:border-grey-700 bg-grey-50/50 dark:bg-white/5">{footer}</div>}
        </Tag>
    );
}

export default Card;
