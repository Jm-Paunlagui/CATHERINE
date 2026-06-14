/**
 * Heading — H1–H6 with consistent Aumovio scale.
 *
 * Props:
 *   as       — 'h1'|'h2'|'h3'|'h4'|'h5'|'h6'
 *   size     — overrides tag size
 *   gradient — boolean
 *   align    — 'left'|'center'|'right'
 *   children
 */
const SCALE = {
    h1: "text-4xl md:text-5xl font-extrabold tracking-tight leading-tight",
    h2: "text-3xl md:text-4xl font-extrabold tracking-tight leading-tight",
    h3: "text-2xl md:text-3xl font-bold tracking-tight",
    h4: "text-xl md:text-2xl font-bold",
    h5: "text-lg md:text-xl font-bold",
    h6: "text-base md:text-lg font-bold",
};

const ALIGNS = {
    left: "text-left",
    center: "text-center",
    right: "text-right",
};

export function Heading({ as: Tag = "h2", size, gradient = false, align = "left", className = "", children }) {
    const sz = SCALE[size ?? Tag] ?? SCALE.h2;
    return (
        <Tag
            className={`font-aumovio-bold text-black dark:text-white ${sz} ${ALIGNS[align]} ${className}
      ${gradient ? "bg-linear-to-r from-orange-400 to-purple-400 bg-clip-text text-transparent" : ""}`}
        >
            {children}
        </Tag>
    );
}

// Convenience exports
export const H1 = (p) => <Heading as="h1" {...p} />;
export const H2 = (p) => <Heading as="h2" {...p} />;
export const H3 = (p) => <Heading as="h3" {...p} />;
export const H4 = (p) => <Heading as="h4" {...p} />;
export const H5 = (p) => <Heading as="h5" {...p} />;
export const H6 = (p) => <Heading as="h6" {...p} />;

export default Heading;
