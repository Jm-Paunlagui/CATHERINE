

/**
 * @fileoverview Log message templates for the shared upload-outcome ledger
 * (`src/utils/uploadOutcome.ts`). Used ONLY in logger calls — never thrown,
 * never sent to clients.
 */

const uploadMessages = {
    /**
     * Emitted at CRIT when a save batch's terminal buckets do not sum to the
     * number of submitted rows. An unbalanced ledger means at least one row
     * silently disappeared between the request and the response — the exact
     * class of defect this module exists to make impossible.
     */
    LEDGER_UNBALANCED: (feature: unknown, counts: { total: number; inserted: number; updated: number; skipped: number; failed: number; pending: number; unaccounted?: number }) =>
        `[UploadOutcome:${feature}] LEDGER UNBALANCED — ${counts.unaccounted} row(s) unaccounted for. ` +
        `total=${counts.total} inserted=${counts.inserted} updated=${counts.updated} ` +
        `skipped=${counts.skipped} failed=${counts.failed} pending=${counts.pending}`,

    /** Routine per-batch ledger trace. */
    LEDGER_BALANCED: (feature: unknown, counts: { total: number; inserted: number; updated: number; skipped: number; failed: number; pending: number; unaccounted?: number }) =>
        `[UploadOutcome:${feature}] ledger balanced — ` +
        `total=${counts.total} inserted=${counts.inserted} updated=${counts.updated} ` +
        `skipped=${counts.skipped} failed=${counts.failed} pending=${counts.pending}`,

    /**
     * Emitted at WARNING when a caller records more terminal outcomes than the
     * declared total (double-counting — e.g. a row pushed into both the skipped
     * and the failed bucket).
     */
    LEDGER_OVERCOUNT: (feature: unknown, recorded: unknown, total: unknown) =>
        `[UploadOutcome:${feature}] LEDGER OVERCOUNT — ${recorded} outcome(s) recorded for ${total} submitted row(s). ` +
        `A row was bucketed more than once.`,

    /** Emitted at WARNING when the same row key is bucketed twice. */
    LEDGER_DUPLICATE_KEY: (feature: unknown, key: unknown, first: unknown, second: unknown) =>
        `[UploadOutcome:${feature}] row "${key}" bucketed twice — first as "${first}", again as "${second}".`,
};

export { uploadMessages };
