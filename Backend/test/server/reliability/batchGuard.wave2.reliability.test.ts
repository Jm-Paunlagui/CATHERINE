import { BatchGuard } from "../../../src/utils/resilience/BatchGuard";
import { RetryPolicy } from "../../../src/utils/resilience/RetryPolicy";
import { ProgressScope } from "../../../src/utils/progress/ProgressScope";
import { runInScope } from "../../../src/utils/progress/progress";

function policy() {
    return new RetryPolicy({
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 2,
        classifier: RetryPolicy.classifyDbError,
        label: "bg-wave2",
    });
}

describe("BatchGuard reliability (wave2)", () => {
    it("rejects an invalid retryBudget", () => {
        for (const bad of [0, -1, 1.5, NaN]) {
            expect(() => new BatchGuard({ retryPolicy: policy(), retryBudget: bad })).toThrow(TypeError);
        }
        expect(() => new BatchGuard({ retryPolicy: policy(), retryBudget: 3 })).not.toThrow();
    });

    it("treats a non-array items argument as an empty batch", async () => {
        const g = new BatchGuard({ retryPolicy: policy() });
        const r = await g.run(undefined as never, async () => 1);
        expect(r).toEqual({ succeeded: [], failed: [], pending: [] });
    });

    it("marks every item pending when the surrounding request scope is already aborted", async () => {
        const scope = new ProgressScope({ label: "req", idleLimitMs: 1000 });
        scope.abort(new Error("client gone"));
        const worker = vi.fn(async () => 1);
        const g = new BatchGuard({ retryPolicy: policy(), label: "lbl" });
        const r = await runInScope(scope, () => g.run([1, 2], worker));
        expect(worker).not.toHaveBeenCalled();
        expect(r.pending).toHaveLength(2);
        expect(r.pending[0].reason).toContain("lbl");
        expect(r.succeeded).toHaveLength(0);
    });

    it("touches the active scope for each finished item (success and failure)", async () => {
        const scope = new ProgressScope({ label: "req", idleLimitMs: 1000 });
        const touch = vi.spyOn(scope, "touch");
        const g = new BatchGuard({ retryPolicy: policy(), concurrency: 1 });
        const r = await runInScope(scope, () =>
            g.run([1, 2], async (n) => {
                if (n === 2) throw new Error("ORA-00904: bad col");
                return n;
            }),
        );
        expect(r.succeeded).toHaveLength(1);
        expect(r.failed).toHaveLength(1);
        expect(touch.mock.calls.filter((c) => c[0] === "batch-item")).toHaveLength(2);
    });

    it("aborts remaining items as pending once the shared retry budget is exhausted", async () => {
        const g = new BatchGuard({
            retryPolicy: {
                execute: async (fn: () => Promise<unknown>) => {
                    try {
                        return await fn();
                    } catch (err) {
                        Object.assign(err as Error, { classification: "TRANSIENT", attempts: 3 });
                        throw err;
                    }
                },
            } as never,
            concurrency: 1,
            retryBudget: 1,
            label: "budget",
        });
        const calls: number[] = [];
        const r = await g.run([1, 2, 3], async (n) => {
            calls.push(n);
            throw new Error("transient");
        });
        expect(calls).toEqual([1]);
        expect(r.failed).toHaveLength(1);
        expect(r.failed[0].attempts).toBe(3);
        expect(r.failed[0].classification).toBe("TRANSIENT");
        expect(r.pending).toHaveLength(2);
        expect(r.pending[0].reason).toContain("budget");
    });

    it("records classification null and attempts 1 for errors lacking metadata, keeping the batch going", async () => {
        const g = new BatchGuard({ retryPolicy: { execute: (fn: () => Promise<unknown>) => fn() } as never, concurrency: 1 });
        const r = await g.run([1, 2], async (n) => {
            if (n === 1) throw new Error("plain");
            return n;
        });
        expect(r.failed[0]).toMatchObject({ attempts: 1, classification: null });
        expect(r.succeeded).toHaveLength(1);
    });

    it("httpStatusFor tolerates a missing report", () => {
        expect(BatchGuard.httpStatusFor(undefined as never)).toBeNull();
        expect(BatchGuard.httpStatusFor({ succeeded: [1], failed: [], pending: [] })).toBe(200);
        expect(BatchGuard.httpStatusFor({ succeeded: [1], failed: [], pending: [2] })).toBe(207);
    });
});
