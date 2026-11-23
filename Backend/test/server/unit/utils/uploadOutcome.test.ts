import { UploadOutcome, UploadOutcomeBuilder, OUTCOME, SKIP_REASON, FAIL_REASON, PENDING_REASON, BUCKET_ORDER } from "../../../../src/utils/uploadOutcome";
import { logger } from "../../../../src/utils/logger";

let crit: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    crit = vi.spyOn(logger, "critical").mockImplementation(() => undefined as never);
    warn = vi.spyOn(logger, "warning").mockImplementation(() => undefined as never);
    info = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
});
afterEach(() => vi.restoreAllMocks());

describe("UploadOutcome ledger", () => {
    it("exposes the bucket vocabulary in a stable order", () => {
        expect(BUCKET_ORDER).toEqual([OUTCOME.INSERTED, OUTCOME.UPDATED, OUTCOME.SKIPPED, OUTCOME.FAILED, OUTCOME.PENDING]);
        expect(SKIP_REASON.BLOCKED).toBe("BLOCKED");
        expect(FAIL_REASON.INTEGRITY).toBe("INTEGRITY");
        expect(PENDING_REASON.COMMIT_ACK_LOST).toBe("COMMIT_ACK_LOST");
    });

    it("a balanced batch reports counts, empty detail rows, balanced=true and the legacy mirror", () => {
        const l = UploadOutcome.for("records", 2);
        expect(l).toBeInstanceOf(UploadOutcomeBuilder);
        l.insert("1", "A").update("2", "B");
        expect(l.recorded).toBe(2);
        const r = l.build({ archived: 3 });
        expect(r).toMatchObject({ feature: "records", balanced: true, archived: 3, total: 2, inserted: 1, updated: 1, skipped: 0, failed: [], pending: [] });
        expect(r.counts).toEqual({ total: 2, inserted: 1, updated: 1, skipped: 0, failed: 0, pending: 0, unaccounted: 0 });
        expect(info).toHaveBeenCalledTimes(1);
        expect(crit).not.toHaveBeenCalled();
    });

    it("extra fields cannot override the canonical contract", () => {
        const r = UploadOutcome.for("f", 0).build({ feature: "evil", balanced: false, counts: {}, rows: {} });
        expect(r.feature).toBe("f");
        expect(r.balanced).toBe(true);
        expect((r.counts as { total: number }).total).toBe(0);
    });

    it("skip / fail / pend normalise identity, default reasons and categories, and let extra ride along without overriding", () => {
        const l = UploadOutcome.for("f", 3);
        l.skip(null, undefined, "");
        l.fail("", "", "", undefined, { code: "X", key: "hijack", reason: "hijack" });
        l.pend(7, 8, "", undefined);
        const r = l.build();
        expect(r.rows.skipped[0]).toEqual({ key: "—", label: null, reason: "Not applicable for this upload.", category: SKIP_REASON.NOT_ACTIONABLE });
        expect(r.rows.failed[0]).toEqual({ code: "X", key: "—", label: null, reason: "Row could not be saved.", category: FAIL_REASON.DATABASE });
        expect(r.rows.pending[0]).toEqual({ key: "7", label: "8", reason: "Outcome unknown — re-upload this row.", category: PENDING_REASON.RETRY_EXHAUSTED });
        expect(r.balanced).toBe(true);
    });

    it("custom reasons and categories are kept", () => {
        const l = UploadOutcome.for("f", 3);
        l.skip("a", "A", "dup", SKIP_REASON.ALREADY_EXISTS).fail("b", "B", "bad", FAIL_REASON.CONSTRAINT).pend("c", "C", "lost", PENDING_REASON.COMMIT_ACK_LOST);
        const r = l.build();
        expect([r.rows.skipped[0].category, r.rows.failed[0].category, r.rows.pending[0].category]).toEqual(["ALREADY_EXISTS", "CONSTRAINT", "COMMIT_ACK_LOST"]);
    });

    it("a missing row is reported (unaccounted > 0) and logged CRITICAL, not clamped", () => {
        const l = UploadOutcome.for("f", 3).insert("1", "A");
        const r = l.build();
        expect(r.balanced).toBe(false);
        expect(r.counts.unaccounted).toBe(2);
        expect(crit).toHaveBeenCalledTimes(1);
        expect(warn).not.toHaveBeenCalled();
    });

    it("an over-count is negative unaccounted: CRITICAL plus a WARNING", () => {
        const r = UploadOutcome.for("f", 1).insert("1", "A").insert("2", "B").build();
        expect(r.counts.unaccounted).toBe(-1);
        expect(r.balanced).toBe(false);
        expect(crit).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it("the same key landing in two buckets warns; unidentifiable keys are not de-duplicated", () => {
        const l = UploadOutcome.for("f", 4);
        l.skip("k", "x", "r").fail("k", "x", "r");
        expect(warn).toHaveBeenCalledTimes(1);
        l.insert(null, null).insert(undefined, null);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it("a non-numeric total is treated as 0 and feature is stringified", () => {
        const r = UploadOutcome.for(42 as never, "abc" as never).build();
        expect(r.feature).toBe("42");
        expect(r.counts.total).toBe(0);
    });
});

describe("UploadOutcome.isPartial / isNoop", () => {
    it("partial when anything failed or is pending or the ledger is unbalanced; skipped alone is normal", () => {
        expect(UploadOutcome.isPartial({ counts: { failed: 1 } })).toBe(true);
        expect(UploadOutcome.isPartial({ counts: { pending: "2" } })).toBe(true);
        expect(UploadOutcome.isPartial({ counts: { skipped: 9 }, balanced: false })).toBe(true);
        expect(UploadOutcome.isPartial({ counts: { skipped: 9 }, balanced: true })).toBe(false);
        expect(UploadOutcome.isPartial({})).toBe(false);
        expect(UploadOutcome.isPartial(undefined as never)).toBe(false);
    });
    it("noop when nothing was inserted or updated", () => {
        expect(UploadOutcome.isNoop({ counts: { inserted: 0, updated: 0, skipped: 5 } })).toBe(true);
        expect(UploadOutcome.isNoop({ counts: { inserted: 1 } })).toBe(false);
        expect(UploadOutcome.isNoop({ counts: { updated: 1 } })).toBe(false);
        expect(UploadOutcome.isNoop({})).toBe(true);
        expect(UploadOutcome.isNoop(undefined as never)).toBe(true);
    });
});
