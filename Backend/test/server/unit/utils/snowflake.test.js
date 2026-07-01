"use strict";

/**
 * @fileoverview Unit tests for the zero-dependency Snowflake ID generator.
 *
 * Coverage targets (per Aumovio test standards):
 *   - Utils/helpers: 95% line
 *   - All branches: constructor options, env var, fallback paths
 *   - Concurrency: monotonic ordering under burst generation
 *   - Deconstruction: round-trip fidelity
 *   - Edge cases: sequence exhaustion, clock rollback safety
 *
 * ID format: "{timestamp 13}-{machineId 4}-{sequence 4}"
 * Example:   "0078812966528-0448-0000" (fixed 23 chars)
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// ─── Helpers ────────────────────────────────────────────────────────────────────

/** Regex matching the segmented Snowflake format. */
const SNOWFLAKE_RE = /^\d{13}-\d{4}-\d{4}$/;

/**
 * Import a fresh module instance with isolated state (sequence counter, etc.).
 * Vitest's module cache is reset between dynamic imports when using vi.resetModules().
 */
async function freshImport() {
    vi.resetModules();
    return await import("../../../../src/utils/snowflake.js");
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe("Snowflake ID Generator", () => {
    // ── Basic generation ────────────────────────────────────────────────────

    describe("nextId()", () => {
        it("returns a non-empty string", async () => {
            const { snowflake } = await freshImport();
            const id = snowflake.nextId();
            expect(typeof id).toBe("string");
            expect(id.length).toBeGreaterThan(0);
        });

        it("returns the segmented format: 13-4-4 digits separated by hyphens", async () => {
            const { snowflake } = await freshImport();
            const id = snowflake.nextId();
            expect(id).toMatch(SNOWFLAKE_RE);
        });

        it("has a fixed length of 23 characters", async () => {
            const { snowflake } = await freshImport();
            for (let i = 0; i < 100; i++) {
                expect(snowflake.nextId()).toHaveLength(23);
            }
        });

        it("fits within VARCHAR2(64) column limit", async () => {
            const { snowflake } = await freshImport();
            const id = snowflake.nextId();
            expect(id.length).toBeLessThanOrEqual(64);
        });
    });

    // ── Uniqueness ──────────────────────────────────────────────────────────

    describe("uniqueness", () => {
        it("generates 10,000 unique IDs with no collisions", async () => {
            const { snowflake } = await freshImport();
            const ids = new Set();
            for (let i = 0; i < 10_000; i++) {
                ids.add(snowflake.nextId());
            }
            expect(ids.size).toBe(10_000);
        });

        it("generates unique IDs across two separate instances with different machineIds", async () => {
            const { Snowflake } = await freshImport();
            const a = new Snowflake({ machineId: 1 });
            const b = new Snowflake({ machineId: 2 });

            const idsA = new Set();
            const idsB = new Set();
            for (let i = 0; i < 1_000; i++) {
                idsA.add(a.nextId());
                idsB.add(b.nextId());
            }

            // No overlap between the two machines
            const intersection = [...idsA].filter((id) => idsB.has(id));
            expect(intersection).toHaveLength(0);
        });
    });

    // ── Monotonic ordering ──────────────────────────────────────────────────

    describe("ordering", () => {
        it("IDs generated across different milliseconds sort by timestamp", async () => {
            const { snowflake } = await freshImport();
            const ids = [];
            for (let i = 0; i < 5; i++) {
                await new Promise((r) => setTimeout(r, 2));
                ids.push(snowflake.nextId());
            }
            // Timestamp is the leading segment — cross-ms IDs always sort correctly
            const sorted = [...ids].sort();
            expect(ids).toEqual(sorted);
        });

        it("all IDs in a rapid burst are unique (same-ms collision-free)", async () => {
            const { snowflake } = await freshImport();
            const ids = new Set();
            for (let i = 0; i < 5_000; i++) {
                ids.add(snowflake.nextId());
            }
            expect(ids.size).toBe(5_000);
        });
    });

    // ── Deconstruction ──────────────────────────────────────────────────────

    describe("deconstruct()", () => {
        it("round-trips the machine ID", async () => {
            const { Snowflake } = await freshImport();
            const sf = new Snowflake({ machineId: 42 });
            const id = sf.nextId();
            const info = sf.deconstruct(id);
            expect(info.machineId).toBe(42);
        });

        it("returns a tail value in 0–9999 range", async () => {
            const { Snowflake } = await freshImport();
            const sf = new Snowflake({ machineId: 0 });

            await new Promise((r) => setTimeout(r, 2));
            const id = sf.nextId();
            const info = sf.deconstruct(id);
            expect(info.tail).toBeGreaterThanOrEqual(0);
            expect(info.tail).toBeLessThan(10000);
        });

        it("extracts a timestamp within 100ms of Date.now()", async () => {
            const { snowflake } = await freshImport();
            const before = Date.now();
            const id = snowflake.nextId();
            const after = Date.now();
            const info = snowflake.deconstruct(id);
            expect(info.timestamp).toBeGreaterThanOrEqual(before);
            expect(info.timestamp).toBeLessThanOrEqual(after + 1); // +1ms tolerance
        });

        it("returns a valid Date object", async () => {
            const { snowflake } = await freshImport();
            const id = snowflake.nextId();
            const info = snowflake.deconstruct(id);
            expect(info.date).toBeInstanceOf(Date);
            expect(Number.isNaN(info.date.getTime())).toBe(false);
        });

        it("throws on invalid format", async () => {
            const { snowflake } = await freshImport();
            expect(() => snowflake.deconstruct("not-a-snowflake")).toThrow(
                /Invalid Snowflake ID format/,
            );
        });

        it("machine ID is visible in the middle segment", async () => {
            const { Snowflake } = await freshImport();
            const sf = new Snowflake({ machineId: 7 });
            const id = sf.nextId();
            const segments = id.split("-");
            expect(segments[1]).toBe("0007");
        });
    });

    // ── Constructor options ─────────────────────────────────────────────────

    describe("constructor", () => {
        it("uses the provided machineId", async () => {
            const { Snowflake } = await freshImport();
            const sf = new Snowflake({ machineId: 999 });
            expect(sf.machineId).toBe(999);
        });

        it("clamps machineId to 0-1023", async () => {
            const { Snowflake } = await freshImport();
            const sf = new Snowflake({ machineId: 2048 });
            expect(sf.machineId).toBeLessThanOrEqual(1023);
            expect(sf.machineId).toBeGreaterThanOrEqual(0);
        });

        it("uses the provided custom epoch", async () => {
            const { Snowflake } = await freshImport();
            const customEpoch = new Date("2020-01-01T00:00:00.000Z").getTime();
            const sf = new Snowflake({ epoch: customEpoch });
            expect(sf.epoch).toBe(customEpoch);
        });

        it("auto-resolves machineId when not provided", async () => {
            const { Snowflake } = await freshImport();
            const sf = new Snowflake();
            expect(sf.machineId).toBeGreaterThanOrEqual(0);
            expect(sf.machineId).toBeLessThanOrEqual(1023);
        });
    });

    // ── Machine ID resolution ───────────────────────────────────────────────

    describe("machine ID resolution", () => {
        const originalEnv = process.env.SNOWFLAKE_MACHINE_ID;

        afterEach(() => {
            if (originalEnv === undefined) {
                delete process.env.SNOWFLAKE_MACHINE_ID;
            } else {
                process.env.SNOWFLAKE_MACHINE_ID = originalEnv;
            }
        });

        it("uses SNOWFLAKE_MACHINE_ID env var when set", async () => {
            process.env.SNOWFLAKE_MACHINE_ID = "777";
            const { Snowflake } = await freshImport();
            const sf = new Snowflake();
            expect(sf.machineId).toBe(777);
        });

        it("ignores invalid SNOWFLAKE_MACHINE_ID (out of range)", async () => {
            process.env.SNOWFLAKE_MACHINE_ID = "9999";
            const { Snowflake } = await freshImport();
            const sf = new Snowflake();
            expect(sf.machineId).toBeGreaterThanOrEqual(0);
            expect(sf.machineId).toBeLessThanOrEqual(1023);
        });

        it("ignores non-numeric SNOWFLAKE_MACHINE_ID", async () => {
            process.env.SNOWFLAKE_MACHINE_ID = "abc";
            const { Snowflake } = await freshImport();
            const sf = new Snowflake();
            expect(sf.machineId).toBeGreaterThanOrEqual(0);
            expect(sf.machineId).toBeLessThanOrEqual(1023);
        });
    });

    // ── Tail nonce ────────────────────────────────────────────────────────

    describe("tail nonce", () => {
        it("produces visually distinct tails across spaced requests", async () => {
            const { Snowflake } = await freshImport();
            const sf = new Snowflake({ machineId: 0 });

            // Generate IDs with 3ms gaps — each should get a fresh random nonce
            const tails = new Set();
            for (let i = 0; i < 10; i++) {
                await new Promise((r) => setTimeout(r, 3));
                const id = sf.nextId();
                tails.add(id.split("-")[2]);
            }
            // With random nonces, we expect most tails to be distinct.
            // 10 draws from 0–9999 — collision probability is negligible.
            expect(tails.size).toBeGreaterThanOrEqual(5);
        });

        it("burst IDs within the same millisecond are all unique", async () => {
            const { Snowflake } = await freshImport();
            const sf = new Snowflake({ machineId: 0 });

            const ids = new Set();
            for (let i = 0; i < 100; i++) {
                ids.add(sf.nextId());
            }
            expect(ids.size).toBe(100);
        });

        it("tail values are in 0000–9999 range", async () => {
            const { Snowflake } = await freshImport();
            const sf = new Snowflake({ machineId: 0 });

            for (let i = 0; i < 50; i++) {
                const id = sf.nextId();
                const tail = parseInt(id.split("-")[2], 10);
                expect(tail).toBeGreaterThanOrEqual(0);
                expect(tail).toBeLessThan(10000);
            }
        });
    });

    // ── Singleton export ────────────────────────────────────────────────────

    describe("singleton", () => {
        it("exports a pre-instantiated snowflake instance", async () => {
            const { snowflake, Snowflake } = await freshImport();
            expect(snowflake).toBeInstanceOf(Snowflake);
        });

        it("singleton machineId is in valid range", async () => {
            const { snowflake } = await freshImport();
            expect(snowflake.machineId).toBeGreaterThanOrEqual(0);
            expect(snowflake.machineId).toBeLessThanOrEqual(1023);
        });

        it("singleton epoch is 2024-01-01", async () => {
            const { snowflake } = await freshImport();
            const expected = new Date("2024-01-01T00:00:00.000Z").getTime();
            expect(snowflake.epoch).toBe(expected);
        });
    });

    // ── Performance ─────────────────────────────────────────────────────────

    describe("performance", () => {
        it("generates 100,000 IDs in under 1 second", async () => {
            const { snowflake } = await freshImport();
            const start = performance.now();
            for (let i = 0; i < 100_000; i++) {
                snowflake.nextId();
            }
            const elapsed = performance.now() - start;
            expect(elapsed).toBeLessThan(1000);
        });
    });

    // ── Integration with TraceabilityMiddleware format ──────────────────────

    describe("integration format", () => {
        it("snowflake ID matches the audit log validation regex", async () => {
            const { snowflake } = await freshImport();
            for (let i = 0; i < 100; i++) {
                const id = snowflake.nextId();
                expect(id).toMatch(/^\d{13}-\d{4}-\d{4}$/);
            }
        });

        it("snowflake ID fits VARCHAR2(64)", async () => {
            const { snowflake } = await freshImport();
            for (let i = 0; i < 100; i++) {
                expect(snowflake.nextId().length).toBeLessThanOrEqual(64);
            }
        });

        it("log grep token [<id>] is unique and searchable", async () => {
            const { snowflake } = await freshImport();
            const id = snowflake.nextId();
            const token = `[${id}]`;
            // Token should not contain characters that break log grep
            expect(token).not.toMatch(/[\n\r\t]/);
            expect(token).toMatch(/^\[\d{13}-\d{4}-\d{4}\]$/);
        });

        it("segments are visually readable: Timestamp-MachineID-Sequence", async () => {
            const { Snowflake } = await freshImport();
            const sf = new Snowflake({ machineId: 42 });

            await new Promise((r) => setTimeout(r, 2)); // fresh ms
            const id = sf.nextId();
            const [ts, mid, seq] = id.split("-");

            expect(ts).toHaveLength(13);
            expect(mid).toBe("0042");
            expect(seq).toHaveLength(4); // 4-digit tail nonce
            expect(parseInt(seq, 10)).toBeGreaterThanOrEqual(0);
            expect(parseInt(seq, 10)).toBeLessThan(10000);

            // Timestamp segment should be a reasonable ms-since-epoch value
            const epochMs = parseInt(ts, 10);
            expect(epochMs).toBeGreaterThan(0);
        });
    });
});
