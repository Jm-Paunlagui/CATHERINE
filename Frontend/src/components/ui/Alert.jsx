/**
 * Alert — Feedback message with optional dismiss and actions.
 *
 * Props:
 *   variant   — 'info' | 'success' | 'warning' | 'danger'
 *   title     — string (optional bold heading)
 *   children  — message content
 *   icon      — custom icon component (defaults to variant icon)
 *   dismissible — boolean
 *   onDismiss — () => void
 *   actions   — [{ label, onClick }]
 *   bordered  — boolean
 *   size      — 'sm' | 'md'
 */

import { CheckCircleIcon, ExclamationTriangleIcon, InformationCircleIcon, XCircleIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { ANIMATE_FADE_IN, TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";

const CONFIG = {
    info: {
        bg:     "bg-[var(--status-info-bg)]",
        border: "border-[var(--status-info-base)]/20",
        text:   "text-[var(--status-info-text)]",
        icon:   InformationCircleIcon,
    },
    success: {
        bg:     "bg-[var(--status-success-bg)]",
        border: "border-[var(--status-success-base)]/20",
        text:   "text-[var(--status-success-text)]",
        icon:   CheckCircleIcon,
    },
    warning: {
        bg:     "bg-[var(--status-warning-bg)]",
        border: "border-[var(--status-warning-base)]/20",
        text:   "text-[var(--status-warning-text)]",
        icon:   ExclamationTriangleIcon,
    },
    danger: {
        bg:     "bg-[var(--status-danger-bg)]",
        border: "border-[var(--status-danger-base)]/20",
        text:   "text-[var(--status-danger-text)]",
        icon:   XCircleIcon,
    },
};

export function Alert({ variant = "info", title, children, icon: CustomIcon, dismissible = false, onDismiss, actions = [], bordered = true, size = "md", className = "" }) {
    const [visible, setVisible] = useState(true);
    const cfg = CONFIG[variant] ?? CONFIG.info;
    const Icon = CustomIcon ?? cfg.icon;

    const dismiss = () => {
        setVisible(false);
        onDismiss?.();
    };

    if (!visible) return null;

    return (
        <div
            role="alert"
            className={`
      flex gap-3 rounded-xl font-aumovio ${ANIMATE_FADE_IN}
      ${size === "sm" ? "p-3 text-xs" : "p-4 text-sm"}
      ${cfg.bg} ${bordered ? `border ${cfg.border}` : ""}
      ${className}
    `}
        >
            <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${cfg.text}`} />
            <div className="flex-1 min-w-0">
                {title && <p className={`font-aumovio-bold mb-0.5 ${cfg.text}`}>{title}</p>}
                <div className={`text-black/75 dark:text-white/70 leading-relaxed`}>{children}</div>
                {actions.length > 0 && (
                    <div className="flex gap-2 mt-3">
                        {actions.map((a, i) => (
                            <button key={i} onClick={a.onClick} className={`text-xs font-aumovio-bold ${cfg.text} hover:underline`}>
                                {a.label}
                            </button>
                        ))}
                    </div>
                )}
            </div>
            {dismissible && (
                <button onClick={dismiss} aria-label="Dismiss" className={`${TRANSITION_COLORS} shrink-0 text-grey-400 hover:text-grey-600 dark:hover:text-grey-300`}>
                    <XMarkIcon className="w-4 h-4" />
                </button>
            )}
        </div>
    );
}

export default Alert;
