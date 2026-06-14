/**
 * Spinner — Loading indicator variants.
 *
 * Props:
 *   size    — 'xs'|'sm'|'md'|'lg'|'xl'
 *   variant — 'ring'|'dots'|'bars'|'pulse'
 *   color   — 'primary'|'white'|'grey'
 *   label   — string
 *   fullPage — boolean
 */
const SZ = {
    xs: "w-4 h-4 border-2",
    sm: "w-5 h-5 border-2",
    md: "w-8 h-8 border-[3px]",
    lg: "w-12 h-12 border-4",
    xl: "w-16 h-16 border-[5px]",
};
const COL = {
    primary: "border-orange-400 border-t-transparent",
    white: "border-white border-t-transparent",
    grey: "border-grey-400 border-t-transparent",
};

export function Spinner({ size = "md", variant = "ring", color = "primary", label, fullPage = false }) {
    let element;

    if (variant === "ring") {
        element = (
            <div className="flex flex-col items-center gap-3">
                <div className={`${SZ[size] ?? SZ.md} ${COL[color] ?? COL.primary} rounded-full animate-spin`} />
                {label && <p className={`text-sm font-aumovio text-grey-400 animate-pulse`}>{label}</p>}
            </div>
        );
    } else if (variant === "dots") {
        const dotCol = color === "primary" ? "bg-orange-400" : color === "white" ? "bg-white" : "bg-grey-400";
        element = (
            <div className="flex gap-1.5 items-center">
                {[0, 1, 2].map((i) => (
                    <div key={i} className={`w-2 h-2 rounded-full ${dotCol} animate-bounce`} style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
            </div>
        );
    } else if (variant === "pulse") {
        const pulseCol = color === "primary" ? "bg-orange-400" : color === "white" ? "bg-white" : "bg-grey-400";
        element = <div className={`${SZ[size] ?? SZ.md} ${pulseCol} rounded-full animate-ping opacity-75`} />;
    }

    if (fullPage) return <div className="flex items-center justify-center min-h-screen bg-(--bg-surface)">{element}</div>;

    return <div className="flex items-center justify-center py-8">{element}</div>;
}

export default Spinner;
