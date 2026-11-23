import { CLUSTER_IPC } from "../../../../src/constants/clusterIpc";
import { buildRelayMessage, sanitizeMeta, subscribeCriticalRelay, RELAY_MESSAGE_MAX, RELAY_META_MAX } from "../../../../src/utils/cluster/critRelay";

describe("critRelay.sanitizeMeta", () => {
    it("returns {} for non-objects", () => {
        expect(sanitizeMeta(undefined)).toEqual({});
        expect(sanitizeMeta(null)).toEqual({});
        expect(sanitizeMeta("x")).toEqual({});
    });

    it("serialises Errors to name/message/stack", () => {
        const out = sanitizeMeta({ err: new TypeError("boom") }) as any;
        expect(out.err.name).toBe("TypeError");
        expect(out.err.message).toBe("boom");
        expect(typeof out.err.stack).toBe("string");
    });

    it("drops circular refs, functions and stringifies BigInt", () => {
        const a: any = { n: 1, fn: () => 1, big: 10n };
        a.self = a;
        const out = sanitizeMeta(a);
        expect(out).toEqual({ n: 1, big: "10" });
    });

    it("replaces oversized meta with a marker", () => {
        expect(sanitizeMeta({ s: "x".repeat(RELAY_META_MAX + 1) })).toEqual({ truncated: true });
    });

    it("returns {} when serialisation throws", () => {
        expect(sanitizeMeta({ toJSON() { throw new Error("x"); } })).toEqual({});
    });
});

describe("critRelay.buildRelayMessage", () => {
    it("builds the IPC envelope", () => {
        const m = buildRelayMessage({ level: "ALERT", message: "m", meta: { a: 1 }, requestId: "r1", timestamp: "t" }, 42);
        expect(m).toEqual({ cmd: CLUSTER_IPC.CRIT_RELAY, record: { level: "ALERT", message: "m", meta: { a: 1 }, requestId: "r1", timestamp: "t", pid: 42 } });
    });

    it("applies defaults and caps the message length", () => {
        const m = buildRelayMessage({ level: undefined as any, message: "x".repeat(RELAY_MESSAGE_MAX + 50) }, 1);
        expect(m.record.level).toBe("CRITICAL");
        expect(m.record.message).toHaveLength(RELAY_MESSAGE_MAX);
        expect(m.record.requestId).toBeNull();
        expect(m.record.meta).toEqual({});
        expect(Number.isNaN(Date.parse(m.record.timestamp))).toBe(false);
    });

    it("coerces a missing message to an empty string", () => {
        expect(buildRelayMessage({ level: "EMERG", message: undefined }, 1).record.message).toBe("");
    });
});

describe("critRelay.subscribeCriticalRelay", () => {
    function setup(proc: any) {
        let cb: (r: any) => void = () => undefined;
        const unsub = vi.fn();
        const logger = { onLevel: vi.fn((_max: number, fn: any) => { cb = fn; return unsub; }) };
        const returned = subscribeCriticalRelay(logger, proc);
        return { logger, unsub, returned, emit: (r: any) => cb(r) };
    }

    it("subscribes at level 2 and returns the unsubscribe fn", () => {
        const { logger, unsub, returned } = setup({ pid: 1, send: vi.fn() });
        expect(logger.onLevel).toHaveBeenCalledWith(2, expect.any(Function));
        expect(returned).toBe(unsub);
    });

    it("sends a relay message for a record", () => {
        const send = vi.fn();
        const { emit } = setup({ pid: 7, send, connected: true });
        emit({ level: "CRITICAL", message: "bad" });
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0][0].cmd).toBe(CLUSTER_IPC.CRIT_RELAY);
        expect(send.mock.calls[0][0].record.pid).toBe(7);
    });

    it("skips _noNotify records, missing send and disconnected channels", () => {
        const send = vi.fn();
        setup({ pid: 1, send, connected: true }).emit({ level: "CRITICAL", message: "x", meta: { _noNotify: true } });
        setup({ pid: 1, send, connected: false }).emit({ level: "CRITICAL", message: "x" });
        setup({ pid: 1 }).emit({ level: "CRITICAL", message: "x" });
        expect(send).not.toHaveBeenCalled();
    });

    it("swallows a send failure", () => {
        const { emit } = setup({ pid: 1, send: () => { throw new Error("EPIPE"); } });
        expect(() => emit({ level: "CRITICAL", message: "x" })).not.toThrow();
    });
});
