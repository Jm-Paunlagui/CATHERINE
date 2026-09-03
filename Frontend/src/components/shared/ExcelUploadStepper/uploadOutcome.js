/**
 * uploadOutcome.js — Canonical Step 3 result model for every Excel upload
 * stepper.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Each feature's Step 3 screen used to read a differently-shaped `uploadResult`
 * straight from its own backend and render a differently-shaped stats grid
 * (3, 4, 4 and 5 cells with different labels). Because `total` meant a
 * different thing per feature and some outcomes were never counted, the RPA
 * team saw screens like "total 18, inserted 7" with no account of the other 11,
 * and "total 1302, inserted 0, updated 0, skipped 0" printed directly above a
 * table listing 1302 skipped rows.
 *
 * This module collapses all four into one shape with one invariant, so a
 * scraper (or a human) reads the same five numbers in the same order every
 * time, and those five numbers always add up.
 *
 * ── The two-tier ledger ──────────────────────────────────────────────────────
 *   file.parsed                                     — rows read from the .xlsx
 *     ├─ file.excluded                              — rows the operator excluded in Step 2
 *     └─ file.submitted  (= counts.total)           — rows POSTed to the server
 *          ├─ counts.inserted                       — new DB rows written
 *          ├─ counts.updated                        — existing DB rows modified
 *          ├─ counts.skipped                        — deliberately not written (not an error)
 *          ├─ counts.failed                         — write attempted and rejected
 *          └─ counts.pending                        — outcome unknown, needs re-upload
 *
 * Invariant: inserted + updated + skipped + failed + pending === total.
 * The remainder is surfaced as `counts.unaccounted`; it is never hidden or
 * clamped, because a non-zero remainder is exactly the confusion this module
 * was written to eliminate.
 *
 * Pure module — no React, no imports, no side effects. Safe to unit test.
 */

// ─── Vocabulary (mirrors Backend/src/utils/uploadOutcome.js) ─────────────────

/**
 * The five terminal buckets, in the fixed order every consumer renders them.
 * `tone` keys into STATUS_BG_COLORS / STATUS_TEXT_COLORS / STATUS_BORDER_COLORS.
 * @type {ReadonlyArray<{ key: string, label: string, tone: string }>}
 */
export const OUTCOME_BUCKETS = Object.freeze([
    { key: "inserted", label: "Inserted", tone: "green" },
    { key: "updated", label: "Updated", tone: "orange" },
    { key: "skipped", label: "Skipped", tone: "grey" },
    { key: "failed", label: "Failed", tone: "red" },
    { key: "pending", label: "Pending", tone: "blue" },
]);

/** Buckets that carry a per-row detail table. */
export const DETAIL_BUCKETS = Object.freeze(["skipped", "failed", "pending"]);

/** Human labels for the machine-readable `category` field on a detail row. */
export const CATEGORY_LABELS = Object.freeze({
    // skip
    NOT_ACTIONABLE: "Not actionable",
    ALREADY_EXISTS: "Already exists",
    EXCLUDED: "Excluded",
    BLOCKED: "Blocked",
    // fail
    CONSTRAINT: "Constraint",
    VALIDATION: "Validation",
    INTEGRITY: "Integrity",
    DATABASE: "Database",
    // pending
    RETRY_EXHAUSTED: "Retries exhausted",
    COMMIT_ACK_LOST: "Commit ack lost",
});

/**
 * Field names a legacy backend might have used for a detail row's business key
 * and human label, most specific first. Used only on the legacy fallback path.
 */
const LEGACY_KEY_FIELDS = ["key", "EMP_ID", "empId", "GID", "gid", "PAY_PERIOD", "payPeriod", "eSignNo", "E_SIGN_NO"];
const LEGACY_LABEL_FIELDS = ["label", "EMP_NAME", "empName", "fullName", "eSignNo", "E_SIGN_NO", "poRef", "PO_REF"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Coerces any value to a finite non-negative-safe integer count.
 * Non-numeric input becomes 0 rather than NaN — a NaN in a stats cell is the
 * kind of ambiguity this module exists to remove.
 *
 * @param {*} value
 * @returns {number}
 */
function toCount(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Length of `value` when it is an array, otherwise its numeric coercion.
 * Legacy responses expressed `failed` and `pending` as arrays; the canonical
 * contract expresses them as counts plus a separate `rows` object.
 *
 * @param {*} value
 * @returns {number}
 */
function countOrLength(value) {
    return Array.isArray(value) ? value.length : toCount(value);
}

/**
 * Picks the first present, non-blank field from `candidates` on `row`.
 *
 * @param {object} row
 * @param {string[]} candidates
 * @returns {string|null}
 */
function pickField(row, candidates) {
    for (const field of candidates) {
        const v = row?.[field];
        if (v !== undefined && v !== null && v !== "") return String(v);
    }
    return null;
}

/**
 * Normalises one detail row from any of the four legacy shapes into the
 * canonical `{ key, label, reason, category, ...extra }`.
 *
 * @param {object} row
 * @param {string} fallbackReason
 * @param {string} fallbackCategory
 * @returns {{ key: string, label: string|null, reason: string, category: string }}
 */
function normalizeDetailRow(row, fallbackReason, fallbackCategory) {
    const source = row && typeof row === "object" ? row : {};
    return {
        ...source,
        key: pickField(source, LEGACY_KEY_FIELDS) ?? "—",
        label: pickField(source, LEGACY_LABEL_FIELDS),
        reason: source.reason ? String(source.reason) : fallbackReason,
        category: source.category ? String(source.category) : fallbackCategory,
    };
}

/**
 * Normalises a detail array, tolerating `undefined` and non-array input.
 *
 * @param {*} rows
 * @param {string} fallbackReason
 * @param {string} fallbackCategory
 * @returns {Array<object>}
 */
function normalizeDetailRows(rows, fallbackReason, fallbackCategory) {
    if (!Array.isArray(rows)) return [];
    return rows.map((r) => normalizeDetailRow(r, fallbackReason, fallbackCategory));
}

// ─── Normalizer ───────────────────────────────────────────────────────────────

/**
 * Converts a raw save response into the canonical Step 3 model.
 *
 * Accepts both the canonical backend contract (`{ counts, rows, balanced }`)
 * and every legacy shape (`{ inserted, updated, skipped, total, failed: [],
 * pending: [] }`). When `counts` is absent the buckets are derived from the
 * legacy keys and `unaccounted` is computed the same way — so an older backend
 * still produces an honest, self-checking screen instead of a silent gap.
 *
 * @param {object|null} result - `res.data.data` from the save endpoint.
 * @param {object} [context]
 * @param {number} [context.parsedRows=0]   - Rows parsed from the .xlsx in Step 1.
 * @param {number} [context.excludedRows=0] - Rows the operator excluded in Step 2.
 * @param {string} [context.feature]        - Feature slug, when the result omits it.
 * @returns {{
 *   feature: string,
 *   file: { parsed: number, excluded: number, submitted: number },
 *   counts: { total: number, inserted: number, updated: number, skipped: number, failed: number, pending: number, unaccounted: number },
 *   rows: { skipped: Array<object>, failed: Array<object>, pending: Array<object> },
 *   written: number,
 *   balanced: boolean,
 *   fileBalanced: boolean,
 *   severity: 'success'|'warning'|'danger',
 *   hasIssues: boolean,
 *   ready: boolean,
 * }}
 */
export function normalizeUploadOutcome(result, context = {}) {
    const src = result && typeof result === "object" ? result : {};
    const { parsedRows = 0, excludedRows = 0, feature } = context;

    const canonical = src.counts && typeof src.counts === "object" ? src.counts : null;
    const legacy = !canonical;

    const total = toCount(canonical ? canonical.total : src.total);
    const inserted = toCount(canonical ? canonical.inserted : src.inserted);
    const updated = toCount(canonical ? canonical.updated : src.updated);
    const skipped = toCount(canonical ? canonical.skipped : src.skipped);
    const failed = canonical ? toCount(canonical.failed) : countOrLength(src.failed);
    const pending = canonical ? toCount(canonical.pending) : countOrLength(src.pending);

    // Always recomputed from the buckets, never trusted from the wire — a
    // backend that miscounts its own remainder must still be caught here.
    const unaccounted = total - (inserted + updated + skipped + failed + pending);

    const counts = { total, inserted, updated, skipped, failed, pending, unaccounted };

    const rows = {
        skipped: normalizeDetailRows(
            src.rows?.skipped ?? (legacy ? src.skippedRows : undefined),
            "Not applicable for this upload.",
            "NOT_ACTIONABLE",
        ),
        failed: normalizeDetailRows(
            src.rows?.failed ?? (legacy && Array.isArray(src.failed) ? src.failed : undefined),
            "Row could not be saved.",
            "DATABASE",
        ),
        pending: normalizeDetailRows(
            src.rows?.pending ?? (legacy && Array.isArray(src.pending) ? src.pending : undefined),
            "Outcome unknown — re-upload this row.",
            "RETRY_EXHAUSTED",
        ),
    };

    const parsed = toCount(parsedRows);
    const excluded = toCount(excludedRows);
    // Trust the server's own count of what it received over any client-side
    // arithmetic; fall back to parsed − excluded only when there is no result.
    const submitted = total || Math.max(parsed - excluded, 0);

    const written = inserted + updated;
    const balanced = unaccounted === 0;
    // Only meaningful when the client actually supplied a parsed-row count.
    const fileBalanced = parsed === 0 || parsed === excluded + submitted;

    let severity;
    if (failed > 0 || !balanced || !fileBalanced) severity = "danger";
    else if (pending > 0 || written === 0) severity = "warning";
    else severity = "success";

    return {
        feature: String(src.feature ?? feature ?? "upload"),
        file: { parsed, excluded, submitted },
        counts,
        rows,
        written,
        balanced,
        fileBalanced,
        severity,
        hasIssues: severity !== "success",
        ready: Boolean(result),
    };
}

// ─── Presentation helpers ─────────────────────────────────────────────────────

/**
 * Builds the single deterministic sentence shown under the Step 3 title.
 *
 * Always names every non-zero bucket in the same order and never omits one, so
 * the sentence is safe to assert against in an RPA script. Zero-valued buckets
 * are dropped only when at least one bucket is non-zero; an all-zero batch
 * still gets an explicit sentence rather than an empty line.
 *
 * @param {ReturnType<typeof normalizeUploadOutcome>} outcome
 * @returns {string}
 */
export function summarySentence(outcome) {
    const { counts, file } = outcome;
    const parts = OUTCOME_BUCKETS.filter((b) => counts[b.key] > 0).map(
        (b) => `${counts[b.key]} ${b.label.toLowerCase()}`,
    );

    if (counts.unaccounted !== 0) {
        parts.push(`${counts.unaccounted} unaccounted for`);
    }

    const head =
        parts.length > 0
            ? `${parts.join(", ")} out of ${counts.total} submitted row${counts.total !== 1 ? "s" : ""}.`
            : `No rows were processed out of ${counts.total} submitted.`;

    return file.excluded > 0
        ? `${head} ${file.excluded} row${file.excluded !== 1 ? "s were" : " was"} excluded before submission.`
        : head;
}

/**
 * Serialises the outcome for the "machine-readable result" block and the
 * `data-upload-json` DOM node that RPA scripts read.
 *
 * Key order is fixed and the payload carries only the ledger — never row-level
 * PII beyond the business key already visible in the detail tables.
 *
 * @param {ReturnType<typeof normalizeUploadOutcome>} outcome
 * @returns {string} Pretty-printed JSON.
 */
export function outcomeToJson(outcome) {
    return JSON.stringify(
        {
            feature: outcome.feature,
            file: outcome.file,
            counts: outcome.counts,
            balanced: outcome.balanced,
            fileBalanced: outcome.fileBalanced,
            severity: outcome.severity,
            rows: {
                skipped: outcome.rows.skipped.map(toJsonRow),
                failed: outcome.rows.failed.map(toJsonRow),
                pending: outcome.rows.pending.map(toJsonRow),
            },
        },
        null,
        2,
    );
}

/**
 * Reduces a detail row to the four canonical fields for the JSON payload.
 * @param {object} row
 * @returns {{ key: string, label: string|null, reason: string, category: string }}
 */
function toJsonRow(row) {
    return { key: row.key, label: row.label ?? null, reason: row.reason, category: row.category };
}

export default normalizeUploadOutcome;
