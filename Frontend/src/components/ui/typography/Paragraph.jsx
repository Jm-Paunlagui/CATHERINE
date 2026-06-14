/**
 * Paragraph — Body text with size and color variants.
 *
 * size  — 'xs'|'sm'|'base'|'lg'|'xl'
 * color — 'default'|'muted'|'primary'|'inverse'
 * lead  — boolean (intro paragraph style)
 */
const SZ = {
    xs: "text-xs",
    sm: "text-sm",
    base: "text-base",
    lg: "text-lg",
    xl: "text-xl",
};
const COL = {
    default: "text-black/75 dark:text-white/75",
    muted: "text-grey-500 dark:text-grey-400",
    primary: "text-orange-500",
    inverse: "text-white",
};

export function Paragraph({ size = "base", color = "default", lead = false, className = "", children }) {
    return (
        <p
            className={`font-aumovio leading-relaxed ${SZ[size] ?? SZ.base} ${COL[color] ?? COL.default}
      ${lead ? "text-lg md:text-xl text-black/60 dark:text-white/60 leading-loose" : ""}
      ${className}`}
        >
            {children}
        </p>
    );
}

export default Paragraph;
