/**
 * Text — Inline text span with semantic variants.
 *
 * Props:
 *   variant — 'bold'|'italic'|'code'|'mark'|'del'|'sub'|'sup'|'kbd'|'small'|'lead'
 *   color   — any Tailwind color string
 *   children
 */
export function Text({ variant = "bold", color, className = "", children }) {
    const col = color ?? "";

    if (variant === "code")
        return (
            <code
                className={`font-mono text-[0.875em] px-1.5 py-0.5 rounded
      bg-grey-100 dark:bg-(--bg-surface-3) text-(--accent-foreground)
      border border-grey-200 dark:border-grey-700 ${col} ${className}`}
            >
                {children}
            </code>
        );
    if (variant === "mark") return <mark className={`bg-warn-100 dark:bg-warn-400/20 text-black dark:text-warn-100 px-0.5 rounded ${col} ${className}`}>{children}</mark>;
    if (variant === "del") return <del className={`line-through text-grey-400 dark:text-white/70 ${col} ${className}`}>{children}</del>;
    if (variant === "bold") return <strong className={`font-aumovio-bold dark:text-white/70 ${col} ${className}`}>{children}</strong>;
    if (variant === "italic") return <em className={`italic dark:text-white/70 ${col} ${className}`}>{children}</em>;
    if (variant === "small") return <small className={`text-xs text-grey-500 dark:text-white/70 ${col} ${className}`}>{children}</small>;
    if (variant === "lead") return <span className={`text-lg text-black/60 dark:text-white/70 leading-loose ${col} ${className}`}>{children}</span>;
    if (variant === "sub") return <sub className={`text-xs dark:text-white/70 ${col} ${className}`}>{children}</sub>;
    if (variant === "sup") return <sup className={`text-xs dark:text-white/70 ${col} ${className}`}>{children}</sup>;

    return <span className={`${col} ${className}`}>{children}</span>;
}

export default Text;
