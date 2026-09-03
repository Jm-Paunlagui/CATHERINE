/**
 * pagination.js — Shared page-size constants + adaptive option builder.
 *
 * Every paginated table in the app renders the same `Pagination` component and
 * must offer the same per-page vocabulary. Centralising the option list here
 * keeps tables consistent instead of each feature growing its own divergent set
 * (some offering [25,50,100,200], some a magnitude-tier list, some none at all).
 *
 * Usage — server-paged table (hook owns page + pageSize):
 *   const pageSizeOptions = useMemo(() => buildPageSizeOptions(total), [total]);
 *   <Pagination page={page} totalPages={totalPages} onChange={setPage}
 *               pageSize={pageSize} pageSizeOptions={pageSizeOptions}
 *               onPageSizeChange={setPageSize} />
 */

/** Default rows-per-page for any newly paginated table. */
export const DEFAULT_PAGE_SIZE = 20;

/** Fallback options used when the row total is unknown or zero. */
export const DEFAULT_PAGE_SIZE_OPTIONS = [20, 50, 100];

/**
 * Hard client-side ceiling on a requested page size. Mirrors the server-side
 * clamp; the server remains the security boundary (a client can send anything),
 * this only keeps the selector from offering a self-inflicted DoS.
 */
export const MAX_PAGE_SIZE = 10_000;

// ─── Divisor helper ───────────────────────────────────────────────────────────

/** Module-level cache — bounded by the number of distinct totals seen in a session. */
const _divisorCache = new Map();

/**
 * Integer divisors of `total` that are >= 20 and useful as page sizes, so a
 * 4 500-row set can be split into exact pages instead of a ragged last page.
 * Memoised for the lifetime of the app session.
 *
 * @param {number} total
 * @returns {number[]}
 */
export function getPageSizeDivisors(total) {
    if (_divisorCache.has(total)) return _divisorCache.get(total);
    const result = [];
    const sqrt = Math.sqrt(total);
    for (let i = 20; i <= sqrt; i++) {
        if (total % i === 0) {
            result.push(i);
            const complement = total / i;
            if (complement !== i && complement >= 20) result.push(complement);
        }
    }
    _divisorCache.set(total, result);
    return result;
}

// ─── Option builder ───────────────────────────────────────────────────────────

const TIERS_100K = [20, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const TIERS_10K = [20, 50, 100, 250, 500, 1000, 2500];
const TIERS_1K = [20, 50, 100, 250, 500];

/**
 * Builds the per-page options for a table holding `total` rows.
 *
 * The list scales with the dataset so a 12-row table does not offer "10 000 per
 * page" and a 200 000-row table is not stuck at 100:
 *
 *   total unknown / 0 → [20, 50, 100]                (safe default)
 *   total < 1 000     → tiers <= total, plus `total` itself ("show all")
 *   total < 10 000    → tiers up to 500 + exact divisors of total
 *   total < 100 000   → tiers up to 2 500
 *   total >= 100 000  → tiers up to 10 000
 *
 * Always returns at least one option (20) so the selector never renders empty.
 *
 * @param {number} total - total rows in scope (server `total` / `totalRows`)
 * @returns {number[]} ascending, de-duplicated page sizes
 */
export function buildPageSizeOptions(total) {
    const t = Number(total);
    if (!Number.isFinite(t) || t <= 0) return [...DEFAULT_PAGE_SIZE_OPTIONS];

    const opts = new Set();
    if (t >= 100_000) {
        TIERS_100K.forEach((n) => n <= t && opts.add(n));
    } else if (t >= 10_000) {
        TIERS_10K.forEach((n) => n <= t && opts.add(n));
    } else if (t >= 1_000) {
        TIERS_1K.forEach((n) => n <= t && opts.add(n));
        getPageSizeDivisors(t).forEach((n) => opts.add(n));
    } else {
        DEFAULT_PAGE_SIZE_OPTIONS.forEach((n) => n <= t && opts.add(n));
        // "Show all" for small sets — below 20 rows a selector is pointless, so
        // 20 stays the floor and doubles as the show-all entry.
        if (t >= DEFAULT_PAGE_SIZE) opts.add(t);
    }

    if (opts.size === 0) opts.add(DEFAULT_PAGE_SIZE);
    return Array.from(opts)
        .filter((n) => n <= MAX_PAGE_SIZE)
        .sort((a, b) => a - b);
}

export default buildPageSizeOptions;
