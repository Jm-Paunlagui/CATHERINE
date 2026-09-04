/**
 * Skeleton — Loading placeholder.
 *
 * A skeleton must echo the SHAPE of the content it stands in for so nothing
 * shifts when real data arrives. Prefer the variant that matches the region:
 * `table` for data grids, `card` for card grids, `list` for avatar feeds,
 * `text` for stacked fields/labels, `rect`/`circle` for bespoke blocks.
 *
 * Props:
 *   variant  — 'text'|'rect'|'circle'|'card'|'table'|'list'
 *   width    — string (CSS, default '100%')
 *   height   — string (CSS, default auto). Honoured by 'rect' AND 'card'
 *              (card uses it for the hero block height; omit for the default).
 *   lines    — number of rows INSIDE a single block (text/list/table body).
 *   rows     — alias for `lines` (table/list ergonomics). `lines` wins if both
 *              are given. Historically `rows` was silently ignored — it is now
 *              a first-class alias so `<Skeleton variant="table" rows={8} />`
 *              renders 8 body rows as authors always intended.
 *   columns  — number of columns for the 'table' variant (default 4). Pass the
 *              real table's column count so the skeleton grid matches it.
 *   count    — number (repeat the WHOLE block)
 *   animate  — boolean
 *   className — bespoke block mode. When supplied, the skeleton renders a
 *              SINGLE base block styled entirely by these classes (e.g.
 *              `className="h-5 w-40 rounded"`), ignoring `variant`. This is the
 *              escape hatch for one-off sizes; previously `className` was
 *              silently dropped and such call sites fell back to the default
 *              3-line text block, so those placeholders never matched.
 */
import { SKELETON_SURFACE } from "../../assets/styles/pre-set-styles";
const base = `${SKELETON_SURFACE} rounded`;

// Deterministic per-column width (rem) for the table variant. Cycles a small
// palette so an N-column skeleton reads like a real header row (mix of short
// id/status columns and wider name/label columns) instead of N identical bars.
const TABLE_COL_WIDTHS = [3, 5, 5, 4, 6, 4, 5, 3, 6, 4, 5];
const colWidth = (i) => `${TABLE_COL_WIDTHS[i % TABLE_COL_WIDTHS.length]}rem`;

function SkeletonLine({ w = "100%", h = "0.875rem" }) {
    return <div className={base} style={{ width: w, height: h }} />;
}

export function Skeleton({ variant = "text", width = "100%", height, lines, rows, columns = 4, count = 1, animate = true, className }) {
    // `rows` is an accepted alias for `lines` (see JSDoc). `lines` takes
    // precedence when both are supplied; default to 3 when neither is given.
    const rowCount = lines ?? rows ?? 3;

    // Bespoke block mode: a caller-styled single block. Takes precedence over
    // `variant` so `<Skeleton className="h-5 w-40 rounded" />` renders exactly
    // that box (used for one-off headers, chips, and avatars).
    if (className) {
        const pulseCls = animate ? "" : "!animate-none";
        return <div className={`${base} ${pulseCls} ${className}`} />;
    }

    // `count` repeats the WHOLE skeleton block (e.g. 3 stacked card skeletons
    // while a list loads) — distinct from `lines`/`rows`, which repeat rows
    // INSIDE a single block (text/list/table variants). Stack vertically with
    // the same gap used elsewhere in this file for repeated items.
    if (count > 1) {
        return (
            <div className="space-y-3">
                {Array.from({ length: count }, (_, i) => (
                    <Skeleton key={i} variant={variant} width={width} height={height} lines={rowCount} columns={columns} count={1} animate={animate} />
                ))}
            </div>
        );
    }

    const pulse = animate ? "" : "!animate-none";

    if (variant === "circle") return <div className={`${base} ${pulse} rounded-full`} style={{ width: width, height: width }} />;

    if (variant === "text")
        return (
            <div className="space-y-2" style={{ width }}>
                {Array.from({ length: rowCount }, (_, i) => (
                    <SkeletonLine key={i} w={i === rowCount - 1 && rowCount > 1 ? "70%" : "100%"} />
                ))}
            </div>
        );

    if (variant === "card")
        return (
            <div className="bg-(--bg-surface) dark:bg-(--bg-surface-2) border border-grey-200 dark:border-grey-700 rounded-xl overflow-hidden p-5 space-y-4" style={{ width }}>
                {/* `height` overrides the default hero height so a card standing
                    in for a short tile isn't drawn taller than the real thing. */}
                <div className={`${base} ${pulse} rounded-lg ${height ? "" : "h-36"}`} style={height ? { height } : undefined} />
                <SkeletonLine w="60%" h="1.125rem" />
                <SkeletonLine />
                <SkeletonLine w="80%" />
            </div>
        );

    if (variant === "list")
        return (
            <div className="space-y-3" style={{ width }}>
                {Array.from({ length: rowCount }, (_, i) => (
                    <div key={i} className="flex items-center gap-3">
                        <div className={`${base} ${pulse} rounded-full shrink-0`} style={{ width: 36, height: 36 }} />
                        <div className="flex-1 space-y-2">
                            <SkeletonLine w="50%" />
                            <SkeletonLine w="80%" h="0.75rem" />
                        </div>
                    </div>
                ))}
            </div>
        );

    if (variant === "table") {
        const cols = Math.max(1, columns);
        return (
            <div className="space-y-2" style={{ width }}>
                <div className="flex gap-4">
                    {Array.from({ length: cols }, (_, i) => (
                        <SkeletonLine key={i} w={colWidth(i)} h="1rem" />
                    ))}
                </div>
                {Array.from({ length: rowCount }, (_, i) => (
                    <div key={i} className="flex gap-4">
                        {Array.from({ length: cols }, (_, j) => (
                            <SkeletonLine key={j} w={colWidth(j)} />
                        ))}
                    </div>
                ))}
            </div>
        );
    }

    return <div className={`${base} ${pulse}`} style={{ width, height: height ?? "1rem" }} />;
}

export default Skeleton;
