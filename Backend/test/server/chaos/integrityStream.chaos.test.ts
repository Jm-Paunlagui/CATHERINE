/**
 * @fileoverview Chaos/reliability tests for the Integrity SSE live-tail: shared
 * poller lifecycle, delta fan-out, repeated poll failure shutdown, pre-flight
 * rejection and write failures on a dead socket. Fake timers, stubbed service.
 */
import "../../../src/config/cacheStores";
import { EventEmitter } from "events";
import IntegrityStreamController from "../../../src/controllers/IntegrityStreamController";
import IntegrityService from "../../../src/services/IntegrityService";
import IntegrityModel from "../../../src/models/integrity.model";

const liveCfg = { key: "orders", live: true };

class FakeRes {
    statusCode = 200;
    body: unknown;
    headers: Record<string, string> = {};
    written: string[] = [];
    flushed = 0;
    failWrites = false;
    status(c: number) {
        this.statusCode = c;
        return this;
    }
    json(b: unknown) {
        this.body = b;
        return this;
    }
    setHeader(k: string, v: string) {
        this.headers[k] = v;
    }
    flushHeaders() {}
    flush() {
        this.flushed++;
    }
    write(s: string) {
        if (this.failWrites) throw new Error("EPIPE");
        this.written.push(s);
        return true;
    }
    events(): string[] {
        return this.written.filter((w) => w.startsWith("event: ")).map((w) => w.slice(7).trim());
    }
}

function makeReq(query: Record<string, unknown> = { table: "orders" }, user: unknown = { userId: "SA1" }) {
    const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
    req.user = user;
    req.query = query;
    req.id = "rid";
    return req;
}

const open: Array<EventEmitter> = [];
async function connect(query?: Record<string, unknown>) {
    const req = makeReq(query);
    const res = new FakeRes();
    await IntegrityStreamController.stream(req as never, res as never);
    open.push(req);
    return { req, res };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(IntegrityModel, "getTableConfig").mockImplementation((k: string) => (k === "orders" ? (liveCfg as never) : null));
    vi.spyOn(IntegrityService, "getMaxPk").mockResolvedValue(10);
});

afterEach(async () => {
    for (const r of open.splice(0)) r.emit("close");
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("IntegrityStreamController pre-flight", () => {
    it("401 when unauthenticated", async () => {
        const res = new FakeRes();
        await IntegrityStreamController.stream(makeReq({ table: "orders" }, null) as never, res as never);
        expect(res.statusCode).toBe(401);
    });

    it.each([["unknown", "nope"], ["missing", undefined], ["proto", "__proto__"]])("400 for %s table", async (_n, table) => {
        const res = new FakeRes();
        await IntegrityStreamController.stream(makeReq({ table }) as never, res as never);
        expect(res.statusCode).toBe(400);
    });

    it("400 for a table that is not live", async () => {
        vi.spyOn(IntegrityModel, "getTableConfig").mockReturnValue({ key: "orders", live: false } as never);
        const res = new FakeRes();
        await IntegrityStreamController.stream(makeReq() as never, res as never);
        expect(res.statusCode).toBe(400);
    });

    it("400 with the validation message for a bad date scope", async () => {
        const res = new FakeRes();
        await IntegrityStreamController.stream(makeReq({ table: "orders", from: "garbage" }) as never, res as never);
        expect(res.statusCode).toBe(400);
        expect(IntegrityService.getMaxPk).not.toHaveBeenCalled();
    });

    it("generic 500 without driver text when the baseline query fails", async () => {
        vi.spyOn(IntegrityService, "getMaxPk").mockRejectedValue(new Error("ORA-00942 SECRET_TABLE"));
        const res = new FakeRes();
        await IntegrityStreamController.stream(makeReq() as never, res as never);
        expect(res.statusCode).toBe(500);
        expect(JSON.stringify(res.body)).not.toContain("SECRET_TABLE");
    });

    it("generic 500 when the baseline failure is a non-Error throw", async () => {
        vi.spyOn(IntegrityService, "getMaxPk").mockRejectedValue("boom");
        const res = new FakeRes();
        await IntegrityStreamController.stream(makeReq() as never, res as never);
        expect(res.statusCode).toBe(500);
    });
});

describe("IntegrityStreamController live fan-out", () => {
    it("sends SSE headers and a connected event carrying the baseline", async () => {
        const { res } = await connect();
        expect(res.headers["Content-Type"]).toBe("text/event-stream");
        expect(res.headers["X-Accel-Buffering"]).toBe("no");
        expect(res.events()).toEqual(["connected"]);
        expect(res.written[1]).toContain('"baselineMaxPk":10');
        expect(res.flushed).toBeGreaterThan(0);
    });

    it("sends heartbeats when idle and a single shared poll serves identical scopes", async () => {
        const delta = vi.spyOn(IntegrityService, "getLiveDelta").mockResolvedValue({ newCount: 0, maxPk: 10, tampered: [] });
        const a = await connect();
        const b = await connect();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(delta).toHaveBeenCalledTimes(1);
        expect(a.res.events()).toEqual(["connected", "heartbeat"]);
        expect(b.res.events()).toEqual(["connected", "heartbeat"]);
    });

    it("different scopes get independent subscriptions", async () => {
        const delta = vi.spyOn(IntegrityService, "getLiveDelta").mockResolvedValue({ newCount: 0, maxPk: 10, tampered: [] });
        await connect();
        await connect({ table: "orders", customer: "9", from: "2026-01-01T00:00:00Z" });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(delta).toHaveBeenCalledTimes(2);
    });

    it("pushes an update with tampered rows and advances the cursor", async () => {
        const delta = vi
            .spyOn(IntegrityService, "getLiveDelta")
            .mockResolvedValueOnce({ newCount: 2, maxPk: 12, tampered: [{ id: 12 }] })
            .mockResolvedValue({ newCount: 0, maxPk: 12, tampered: [] });
        const { res } = await connect();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(res.events()).toEqual(["connected", "update"]);
        expect(res.written.join("")).toContain('"tampered":[{"id":12}]');
        await vi.advanceTimersByTimeAsync(5_000);
        expect(delta.mock.calls[1][2]).toBe(12);
    });

    it("an update with only clean rows is still delivered", async () => {
        vi.spyOn(IntegrityService, "getLiveDelta").mockResolvedValue({ newCount: 1, maxPk: 11, tampered: [] });
        const { res } = await connect();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(res.events()).toContain("update");
    });

    it("starts from cursor 0 when the table was empty at connect time", async () => {
        vi.spyOn(IntegrityService, "getMaxPk").mockResolvedValue(null);
        const delta = vi.spyOn(IntegrityService, "getLiveDelta").mockResolvedValue({ newCount: 0, maxPk: 0, tampered: [] });
        await connect();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(delta.mock.calls[0][2]).toBe(0);
    });

    it("a dead socket (write throws) does not break delivery to other clients", async () => {
        vi.spyOn(IntegrityService, "getLiveDelta").mockResolvedValue({ newCount: 0, maxPk: 10, tampered: [] });
        const dead = await connect();
        const live = await connect();
        dead.res.failWrites = true;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(live.res.events()).toContain("heartbeat");
    });

    it("stops polling once the last client disconnects, and a disconnect of one keeps the rest", async () => {
        const delta = vi.spyOn(IntegrityService, "getLiveDelta").mockResolvedValue({ newCount: 0, maxPk: 10, tampered: [] });
        const a = await connect();
        const b = await connect();
        a.req.emit("close");
        await vi.advanceTimersByTimeAsync(5_000);
        expect(delta).toHaveBeenCalledTimes(1);
        b.req.emit("close");
        await vi.advanceTimersByTimeAsync(20_000);
        expect(delta).toHaveBeenCalledTimes(1);
    });

    it("skips an overlapping tick while a slow poll is still running", async () => {
        let release: (v: { newCount: number; maxPk: number; tampered: [] }) => void = () => {};
        const delta = vi.spyOn(IntegrityService, "getLiveDelta").mockReturnValue(new Promise((r) => (release = r)));
        await connect();
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(delta).toHaveBeenCalledTimes(1);
        release({ newCount: 0, maxPk: 10, tampered: [] });
        await vi.advanceTimersByTimeAsync(0);
    });
});

describe("IntegrityStreamController repeated poll failure", () => {
    it("tells clients to refresh and tears the poller down after 5 consecutive errors", async () => {
        const delta = vi.spyOn(IntegrityService, "getLiveDelta").mockRejectedValue(new Error("ORA-03113"));
        const { res } = await connect();
        for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(5_000);
        expect(res.events()).not.toContain("error");
        await vi.advanceTimersByTimeAsync(5_000);
        expect(res.events()).toContain("error");
        expect(res.written.join("")).toContain("POLL_FAILED");
        expect(delta).toHaveBeenCalledTimes(5);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(delta).toHaveBeenCalledTimes(5);
    });

    it("a successful tick resets the error streak", async () => {
        const delta = vi.spyOn(IntegrityService, "getLiveDelta");
        delta.mockRejectedValue(new Error("x"));
        const { res } = await connect();
        for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(5_000);
        delta.mockResolvedValue({ newCount: 0, maxPk: 10, tampered: [] });
        await vi.advanceTimersByTimeAsync(5_000);
        delta.mockRejectedValue("non-error");
        for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(5_000);
        expect(res.events()).not.toContain("error");
    });
});
