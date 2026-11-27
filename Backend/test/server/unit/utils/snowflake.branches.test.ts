/**
 * @fileoverview Branch tests for src/utils/snowflake.ts that the main suite
 * (snowflake.test.ts) leaves unproven: machine-ID resolution fallbacks, the
 * sequence-exhaustion spin-wait, and deconstruct()'s rejection of bad input.
 *
 * Deliberately ONE module instance (static import, no vi.resetModules): machine-ID
 * resolution runs on every `new Snowflake()` without `machineId`, so env and
 * `os.networkInterfaces` can be varied per test without a fresh module. (Under
 * `bun --bun vitest`, coverage from module instances dropped by
 * `vi.resetModules()` is not reliably retained — see the report for the file.)
 */

import os from "os";
import { Snowflake, snowflake } from "../../../../src/utils/snowflake";

const EPOCH_2024 = Date.UTC(2024, 0, 1);

/** FNV-1a 32-bit of a string, mod 1024 — the documented derivation, re-stated. */
function fnv1aMod1024(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h * 0x01000193) >>> 0;
    }
    return h % 1024;
}

const iface = (address: string, family: "IPv4" | "IPv6", internal: boolean) =>
    ({ address, family, internal, netmask: "", mac: "00:00:00:00:00:00", cidr: null }) as os.NetworkInterfaceInfo;

describe("Snowflake machine-ID resolution (branches)", () => {
    const originalEnv = process.env.SNOWFLAKE_MACHINE_ID;

    beforeEach(() => {
        delete process.env.SNOWFLAKE_MACHINE_ID;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (originalEnv === undefined) delete process.env.SNOWFLAKE_MACHINE_ID;
        else process.env.SNOWFLAKE_MACHINE_ID = originalEnv;
    });

    it("an explicit SNOWFLAKE_MACHINE_ID wins and the network is never consulted", () => {
        const spy = vi.spyOn(os, "networkInterfaces");
        process.env.SNOWFLAKE_MACHINE_ID = "0";
        expect(new Snowflake().machineId).toBe(0);
        process.env.SNOWFLAKE_MACHINE_ID = "1023";
        expect(new Snowflake().machineId).toBe(1023);
        expect(spy).not.toHaveBeenCalled();
    });

    it.each([
        ["empty string", ""],
        ["negative", "-1"],
        ["above 1023", "1024"],
        ["non-numeric", "abc"],
    ])("an invalid SNOWFLAKE_MACHINE_ID (%s) falls through to the IPv4 hash", (_label, value) => {
        process.env.SNOWFLAKE_MACHINE_ID = value;
        vi.spyOn(os, "networkInterfaces").mockReturnValue({ eth0: [iface("10.1.2.3", "IPv4", false)] });
        expect(new Snowflake().machineId).toBe(fnv1aMod1024("10.1.2.3"));
    });

    it("hashes the FIRST non-internal IPv4, skipping loopback and IPv6 entries", () => {
        vi.spyOn(os, "networkInterfaces").mockReturnValue({
            lo: [iface("127.0.0.1", "IPv4", true)],
            eth0: [iface("fe80::1", "IPv6", false), iface("192.168.100.92", "IPv4", false)],
            eth1: [iface("10.0.0.7", "IPv4", false)],
        });
        const id = new Snowflake().machineId;
        expect(id).toBe(fnv1aMod1024("192.168.100.92"));
        expect(id).toBeGreaterThanOrEqual(0);
        expect(id).toBeLessThanOrEqual(1023);
    });

    it("the IPv4 hash is stable per host: two instances agree", () => {
        vi.spyOn(os, "networkInterfaces").mockReturnValue({ eth0: [iface("172.16.5.9", "IPv4", false)] });
        expect(new Snowflake().machineId).toBe(new Snowflake().machineId);
    });

    it("falls back to pid % 1024 when only internal / IPv6 interfaces exist (or an entry is undefined)", () => {
        vi.spyOn(os, "networkInterfaces").mockReturnValue({
            lo: [iface("127.0.0.1", "IPv4", true)],
            v6: [iface("::1", "IPv6", false)],
            ghost: undefined,
        });
        expect(new Snowflake().machineId).toBe(process.pid % 1024);
    });

    it("falls back to pid % 1024 when os.networkInterfaces throws (sandboxed host)", () => {
        vi.spyOn(os, "networkInterfaces").mockImplementation(() => {
            throw new Error("uv_interface_addresses EPERM");
        });
        expect(() => new Snowflake()).not.toThrow();
        expect(new Snowflake().machineId).toBe(process.pid % 1024);
    });

    it("an explicit options.machineId bypasses resolution entirely and is truncated to an integer", () => {
        const spy = vi.spyOn(os, "networkInterfaces");
        expect(new Snowflake({ machineId: 12.9 }).machineId).toBe(12);
        expect(spy).not.toHaveBeenCalled();
    });
});

describe("Snowflake.nextId sequence exhaustion", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("after 4096 IDs in one millisecond, spin-waits to the next millisecond instead of colliding", () => {
        const sf = new Snowflake({ machineId: 7, epoch: 0 });
        let now = 5_000;
        let reads = 0;
        vi.spyOn(Date, "now").mockImplementation(() => {
            reads++;
            return now;
        });

        const ids = new Set<string>();
        for (let i = 0; i < 4096; i++) ids.add(sf.nextId());
        expect(ids.size).toBe(4096);
        expect([...ids].every((id) => id.startsWith("0000000005000-0007-"))).toBe(true);

        // The 4097th call wraps the sequence to 0; the clock is still on 5000 for
        // the first two reads and then advances — the generator must keep polling.
        reads = 0;
        vi.mocked(Date.now).mockImplementation(() => {
            reads++;
            return reads <= 3 ? now : (now = 5_001);
        });
        const next = sf.nextId();

        expect(reads).toBeGreaterThanOrEqual(4); // polled through the stalled ms
        expect(next.startsWith("0000000005001-0007-")).toBe(true);
        expect(ids.has(next)).toBe(false);
        expect(sf.deconstruct(next).timestamp).toBe(5_001);
    });

    it("a new millisecond resets the sequence (tail returns to the fresh nonce, not seq+1)", () => {
        const sf = new Snowflake({ machineId: 1, epoch: 0 });
        let now = 100;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const a = sf.deconstruct(sf.nextId()).tail;
        const b = sf.deconstruct(sf.nextId()).tail;
        expect(b).toBe((a + 1) % 10000); // same ms → sequence +1 over the same nonce
        now = 101;
        sf.nextId();
        expect(sf._sequence).toBe(0);
    });
});

describe("Snowflake.deconstruct", () => {
    it.each([
        ["empty string", ""],
        ["wrong segment widths", "123-0001-0001"],
        ["non-digits", "000000000000a-0001-0001"],
        ["extra suffix (anchored regex)", "0000000000001-0001-0001x"],
        ["legacy nanoid request id", "req_V1StGXR8_Z5jdHi6B-myT"],
    ])("throws a descriptive error for %s", (_label, bad) => {
        expect(() => snowflake.deconstruct(bad)).toThrow(`Invalid Snowflake ID format: "${bad}"`);
    });

    it("round-trips timestamp, machine ID and date against the instance epoch", () => {
        const sf = new Snowflake({ machineId: 448, epoch: EPOCH_2024 });
        const parts = sf.deconstruct("0078812966528-0448-7293");
        expect(parts).toEqual({
            timestamp: EPOCH_2024 + 78812966528,
            machineId: 448,
            tail: 7293,
            date: new Date(EPOCH_2024 + 78812966528),
        });
    });

    it("exposes machineId and epoch getters; the singleton uses the 2024-01-01 epoch", () => {
        const sf = new Snowflake({ machineId: 3, epoch: 42 });
        expect(sf.machineId).toBe(3);
        expect(sf.epoch).toBe(42);
        expect(snowflake.epoch).toBe(EPOCH_2024);
    });
});
