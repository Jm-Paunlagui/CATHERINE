/**
 * Spinner — Loading indicator variants.
 *
 * Props:
 *   size    — 'xs'|'sm'|'md'|'lg'|'xl'
 *   variant — 'ring'|'dots'|'pulse'   (unknown values fall back to 'ring')
 *   color   — 'primary'|'white'|'grey'
 *   label   — string, rendered under the spinner for EVERY variant
 *   fullPage — boolean
 *
 * this list used to promise a 'bars' variant that was never
 * implemented, and there was no else-branch — so <Spinner variant="bars" />
 * left `element` undefined and rendered an empty wrapper: a loading state that
 * shows nothing at all, with no error. No caller in src/ ever passed it. The
 * doc now matches the code and unknown variants degrade to the ring rather
 * than vanishing.
 *
 * `label` used to render only inside the 'ring' branch, so
 * <Spinner variant="dots" label="Loading…" /> silently dropped the text. The
 * label is now lifted out and wraps every variant.
 */
const SZ = {
    xs: "w-4 h-4 border-2",
    sm: "w-5 h-5 border-2",
    md: "w-8 h-8 border-[3px]",
    lg: "w-12 h-12 border-4",
    xl: "w-16 h-16 border-[5px]",
};
const COL = {
    primary: "border-(--accent-foreground) border-t-transparent",
    white: "border-white border-t-transparent",
    grey: "border-grey-400 border-t-transparent",
};

export function Spinner({ size = "md", variant = "ring", color = "primary", label, fullPage = false }) {
    let indicator;

    if (variant === "dots") {
        const dotCol = color === "primary" ? "bg-(--accent-foreground)" : color === "white" ? "bg-white" : "bg-grey-400";
        indicator = (
            <div className="flex gap-2 items-center">
                {[0, 1, 2].map((i) => (
                    <div key={i} className={`w-2 h-2 rounded-full ${dotCol} animate-bounce`} style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
            </div>
        );
    } else if (variant === "pulse") {
        const pulseCol = color === "primary" ? "bg-(--accent-foreground)" : color === "white" ? "bg-white" : "bg-grey-400";
        indicator = <div className={`${SZ[size] ?? SZ.md} ${pulseCol} rounded-full animate-ping opacity-75`} />;
    }

    // Fallback, not a variant: an unknown `variant` renders the documented
    // default rather than nothing.
    if (!indicator) {
        indicator = <div className={`${SZ[size] ?? SZ.md} ${COL[color] ?? COL.primary} rounded-full animate-spin`} />;
    }

    // The label belongs to the Spinner, not to one variant.
    const element = (
        <div className="flex flex-col items-center gap-3">
            {indicator}
            {label && <p className="text-sm font-aumovio text-grey-400 animate-pulse">{label}</p>}
        </div>
    );

    if (fullPage) return <div className="flex items-center justify-center min-h-screen bg-(--bg-surface)">{element}</div>;

    return <div className="flex items-center justify-center py-8">{element}</div>;
}

export default Spinner;
