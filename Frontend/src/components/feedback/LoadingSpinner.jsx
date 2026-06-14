/**
 * LoadingSpinner.jsx — Centered loading indicator.
 *
 * Props:
 *   size     — 'sm' | 'md' | 'lg'  (default: 'md')
 *   fullPage — boolean — fills the viewport  (default: false)
 *   label    — optional text shown below the spinner
 */

import { TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";

const SIZES = {
    sm: "w-5 h-5 border-2",
    md: "w-8 h-8 border-[3px]",
    lg: "w-12 h-12 border-4",
};

export function LoadingSpinner({ size = "md", fullPage = false, label }) {
    const spinner = (
        <div className="flex flex-col items-center gap-3">
            <div
                className={`${SIZES[size] ?? SIZES.md} rounded-full
                    border-orange-400 border-t-transparent animate-spin`}
            />
            {label && <p className="text-sm font-aumovio text-grey-400 animate-pulse">{label}</p>}
        </div>
    );

    if (fullPage) {
        return <div className={`flex items-center justify-center min-h-screen bg-(--bg-surface) ${TRANSITION_COLORS}`}>{spinner}</div>;
    }

    return <div className="flex items-center justify-center py-12">{spinner}</div>;
}

export default LoadingSpinner;
