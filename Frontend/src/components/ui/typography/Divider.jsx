/**
 * Divider — Horizontal rule with optional label.
 *
 * Props:
 *   label   — center text
 *   variant — 'solid'|'dashed'|'gradient'|'dot'
 *   spacing — 'sm'|'md'|'lg'
 */
const SP = { sm: "my-4", md: "my-6", lg: "my-10" };

export function Divider({ label, variant = "solid", spacing = "md" }) {
    const line = {
        solid: "border-grey-200 dark:border-grey-700",
        dashed: "border-dashed border-grey-200 dark:border-grey-700",
        gradient: "border-0",
    };

    if (label)
        return (
            <div className={`flex items-center gap-4 font-aumovio ${SP[spacing] ?? SP.md}`}>
                <div className={`flex-1 ${variant !== "gradient" ? `border-t ${line[variant]}` : "h-px bg-linear-to-r from-transparent to-grey-200 dark:to-grey-700"}`} />
                <span className="text-xs tracking-wider uppercase font-aumovio-bold text-grey-400 whitespace-nowrap">{label}</span>
                <div className={`flex-1 ${variant !== "gradient" ? `border-t ${line[variant]}` : "h-px bg-linear-to-l from-transparent to-grey-200 dark:to-grey-700"}`} />
            </div>
        );

    if (variant === "gradient") return <div className={`${SP[spacing] ?? SP.md} h-px bg-linear-to-r from-transparent via-grey-300 dark:via-grey-600 to-transparent`} />;

    if (variant === "dot")
        return (
            <div className={`${SP[spacing] ?? SP.md} flex items-center justify-center gap-1.5`}>
                {[0, 1, 2].map((i) => (
                    <span key={i} className="w-1 h-1 rounded-full bg-grey-300 dark:bg-grey-500" />
                ))}
            </div>
        );

    return <hr className={`${SP[spacing] ?? SP.md} ${line[variant] ?? line.solid} border-t`} />;
}

export default Divider;
