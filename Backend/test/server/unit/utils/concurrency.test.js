"use strict";

/**
 * @fileoverview Unit tests for mapWithConcurrency — the bounded-concurrency
 * mapper that drives the Excel bulk-upload save paths.
 *
 * Contract under test:
 *   - Results are returned in INPUT order regardless of completion order.
 *   - At most `limit` invocations run concurrently.
 *   - Every item is processed exactly once.
 *   - Empty input → empty result, fn never called.
 *   - limit is clamped to >= 1.
 *   - A throw in fn rejects the whole map (callers isolate per-item errors).
 */

const { expect } = require("chai");
const { mapWithConcurrency } = require("../../../../src/utils/concurrency");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

describe("mapWithConcurrency", function () {
    it("returns results in input order despite out-of-order completion", async function () {
        const input = [50, 10, 30, 5, 40];
        const out = await mapWithConcurrency(input, 2, async (ms) => {
            await delay(ms);
            return ms * 2;
        });
        expect(out).to.deep.equal([100, 20, 60, 10, 80]);
    });

    it("processes every item exactly once", async function () {
        const input = Array.from({ length: 100 }, (_, i) => i);
        const seen = new Set();
        const out = await mapWithConcurrency(input, 8, async (x) => {
            seen.add(x);
            return x;
        });
        expect(out).to.deep.equal(input);
        expect(seen.size).to.equal(100);
    });

    it("never exceeds the concurrency limit", async function () {
        let inFlight = 0;
        let peak = 0;
        const input = Array.from({ length: 30 }, (_, i) => i);
        await mapWithConcurrency(input, 5, async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await delay(5);
            inFlight--;
        });
        expect(peak).to.be.at.most(5);
        expect(peak).to.be.greaterThan(1); // proves it actually parallelises
    });

    it("empty input → empty array, fn never called", async function () {
        let called = false;
        const out = await mapWithConcurrency([], 4, async () => {
            called = true;
        });
        expect(out).to.deep.equal([]);
        expect(called).to.be.false;
    });

    it("non-array input → empty array", async function () {
        expect(await mapWithConcurrency(null, 4, async () => 1)).to.deep.equal(
            [],
        );
        expect(
            await mapWithConcurrency(undefined, 4, async () => 1),
        ).to.deep.equal([]);
    });

    it("limit < 1 is clamped to serial (still correct)", async function () {
        const out = await mapWithConcurrency([1, 2, 3], 0, async (x) => x + 1);
        expect(out).to.deep.equal([2, 3, 4]);
    });

    it("limit larger than item count does not over-spawn", async function () {
        let peak = 0;
        let inFlight = 0;
        const out = await mapWithConcurrency([1, 2, 3], 100, async (x) => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await delay(2);
            inFlight--;
            return x;
        });
        expect(out).to.deep.equal([1, 2, 3]);
        expect(peak).to.be.at.most(3);
    });

    it("passes the index as the second argument", async function () {
        const out = await mapWithConcurrency(["a", "b", "c"], 2, async (v, i) => `${v}${i}`);
        expect(out).to.deep.equal(["a0", "b1", "c2"]);
    });

    it("a throw in fn rejects the whole map", async function () {
        let err;
        try {
            await mapWithConcurrency([1, 2, 3], 2, async (x) => {
                if (x === 2) throw new Error("boom");
                return x;
            });
        } catch (e) {
            err = e;
        }
        expect(err).to.be.instanceOf(Error);
        expect(err.message).to.equal("boom");
    });
});
