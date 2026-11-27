/**
 * @fileoverview Unit tests for src/utils/sse/SseConnectionRegistry.ts.
 *
 * The registry is the single control point that lets a shutdown (endAll) or a
 * session revocation (endFamilies) terminate live SSE streams. Its contract:
 *   - SYNCHRONOUS and NEVER throws, even when a socket or a surface teardown does;
 *   - every ended stream gets one terminal event frame and is ended exactly once;
 *   - the surface's own teardown runs after the socket is ended;
 *   - endFamilies touches ONLY streams whose req.user.fid is in the set.
 *
 * The registry is a process singleton; every test drains it in afterEach.
 */

import registry from "../../../../src/utils/sse/SseConnectionRegistry";
import { logger } from "../../../../src/utils/logger";
import { sseMessages } from "../../../../src/constants/messages";

type FakeRes = {
    req?: { user?: { fid?: string } };
    frames: string[];
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    flush?: ReturnType<typeof vi.fn>;
};

function fakeRes({ fid, withFlush = true, writeThrows = false }: { fid?: string | null; withFlush?: boolean; writeThrows?: boolean } = {}): FakeRes {
    const res: FakeRes = {
        frames: [],
        write: vi.fn((chunk: string) => {
            if (writeThrows) throw new Error("socket destroyed");
            res.frames.push(chunk);
            return true;
        }),
        end: vi.fn(),
    };
    if (fid !== null) res.req = fid === undefined ? {} : { user: { fid } };
    if (withFlush) res.flush = vi.fn();
    return res;
}

const asRes = (r: FakeRes) => r as never;

let notice: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    notice = vi.spyOn(logger, "notice").mockImplementation(() => undefined as never);
});

afterEach(() => {
    registry.endAll("test_cleanup");
    notice.mockRestore();
});

describe("register / unregister / size", () => {
    it("register returns an idempotent unregister function", () => {
        const res = fakeRes();
        const unregister = registry.register(asRes(res));
        expect(registry.size()).toBe(1);
        unregister();
        unregister();
        expect(registry.size()).toBe(0);
    });

    it("re-registering the same res replaces its teardown instead of duplicating the entry", () => {
        const res = fakeRes();
        const first = vi.fn();
        const second = vi.fn();
        registry.register(asRes(res), first);
        registry.register(asRes(res), second);
        expect(registry.size()).toBe(1);
        registry.endAll();
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
    });
});

describe("endFamilies", () => {
    it("returns 0 and logs nothing for an empty family set", () => {
        const res = fakeRes({ fid: "fam-1" });
        registry.register(asRes(res));
        expect(registry.endFamilies([])).toBe(0);
        expect(res.end).not.toHaveBeenCalled();
        expect(registry.size()).toBe(1);
        expect(notice).not.toHaveBeenCalled();
    });

    it("returns 0 without scanning when no stream is registered", () => {
        expect(registry.size()).toBe(0);
        expect(registry.endFamilies(["fam-1"])).toBe(0);
        expect(notice).not.toHaveBeenCalled();
    });

    it("returns 0 and logs nothing when no registered stream matches", () => {
        const res = fakeRes({ fid: "fam-other" });
        registry.register(asRes(res));
        expect(registry.endFamilies(["fam-1"])).toBe(0);
        expect(res.write).not.toHaveBeenCalled();
        expect(notice).not.toHaveBeenCalled();
    });

    it("ends ONLY the matching families with a session-ended frame, runs their teardown, and keeps the rest", () => {
        const hitA = fakeRes({ fid: "fam-1" });
        const hitB = fakeRes({ fid: "fam-2" });
        const keep = fakeRes({ fid: "fam-3" });
        const anonymous = fakeRes({ fid: undefined }); // req present, no user
        const noReq = fakeRes({ fid: null }); // no req at all
        const teardownA = vi.fn();
        const teardownKeep = vi.fn();
        registry.register(asRes(hitA), teardownA);
        registry.register(asRes(hitB)); // no teardown → null
        registry.register(asRes(keep), teardownKeep);
        registry.register(asRes(anonymous));
        registry.register(asRes(noReq));

        const ended = registry.endFamilies(new Set(["fam-1", "fam-2"]));

        expect(ended).toBe(2);
        expect(registry.size()).toBe(3);
        for (const r of [hitA, hitB]) {
            expect(r.frames).toEqual([
                "event: session-ended\n",
                `data: ${JSON.stringify({ reason: "session_ended" })}\n\n`,
            ]);
            expect(r.flush).toHaveBeenCalledTimes(1);
            expect(r.end).toHaveBeenCalledTimes(1);
        }
        expect(teardownA).toHaveBeenCalledTimes(1);
        expect(teardownA.mock.invocationCallOrder[0]).toBeGreaterThan(hitA.end.mock.invocationCallOrder[0]);
        for (const r of [keep, anonymous, noReq]) expect(r.write).not.toHaveBeenCalled();
        expect(teardownKeep).not.toHaveBeenCalled();
        expect(notice).toHaveBeenCalledWith(sseMessages.SSE_SESSION_ENDED(2));
    });

    it("a stream without res.flush (no compression middleware) is still ended", () => {
        const res = fakeRes({ fid: "fam-1", withFlush: false });
        registry.register(asRes(res));
        expect(registry.endFamilies(["fam-1"])).toBe(1);
        expect(res.end).toHaveBeenCalledTimes(1);
    });

    it("never throws: a dead socket and a throwing teardown are swallowed and the next stream is still ended", () => {
        const dead = fakeRes({ fid: "fam-1", writeThrows: true });
        const badTeardown = vi.fn(() => {
            throw new Error("teardown broke");
        });
        const healthy = fakeRes({ fid: "fam-1" });
        registry.register(asRes(dead), badTeardown);
        registry.register(asRes(healthy));

        let ended = -1;
        expect(() => {
            ended = registry.endFamilies(["fam-1"]);
        }).not.toThrow();

        expect(ended).toBe(2);
        expect(dead.end).not.toHaveBeenCalled(); // write threw before end
        expect(badTeardown).toHaveBeenCalledTimes(1); // teardown still attempted
        expect(healthy.end).toHaveBeenCalledTimes(1);
        expect(registry.size()).toBe(0);
    });

    it("an ended stream is removed, so a second revocation of the same family is a no-op", () => {
        const res = fakeRes({ fid: "fam-1" });
        registry.register(asRes(res));
        registry.endFamilies(["fam-1"]);
        expect(registry.endFamilies(["fam-1"])).toBe(0);
        expect(res.end).toHaveBeenCalledTimes(1);
    });
});

describe("endAll", () => {
    it("defaults the reason to server_shutdown and logs the broadcast count", () => {
        const res = fakeRes();
        registry.register(asRes(res));
        registry.endAll();
        expect(res.frames).toEqual([
            "event: shutdown\n",
            `data: ${JSON.stringify({ reason: "server_shutdown" })}\n\n`,
        ]);
        expect(notice).toHaveBeenCalledWith(sseMessages.SSE_SHUTDOWN_BROADCAST(1));
        expect(registry.size()).toBe(0);
    });

    it("echoes a custom reason, works without res.flush, and survives a throwing socket and teardown", () => {
        const dead = fakeRes({ writeThrows: true });
        const noFlush = fakeRes({ withFlush: false });
        const teardown = vi.fn(() => {
            throw new Error("poller teardown broke");
        });
        registry.register(asRes(dead), teardown);
        registry.register(asRes(noFlush));
        expect(() => registry.endAll("planned_restart")).not.toThrow();
        expect(teardown).toHaveBeenCalledTimes(1);
        expect(noFlush.frames[1]).toBe(`data: ${JSON.stringify({ reason: "planned_restart" })}\n\n`);
        expect(noFlush.end).toHaveBeenCalledTimes(1);
        expect(notice).toHaveBeenCalledWith(sseMessages.SSE_SHUTDOWN_BROADCAST(2));
    });

    it("a teardown that calls back into unregister() does not disturb the iteration", () => {
        const a = fakeRes();
        const b = fakeRes();
        let unregisterA: () => void = () => undefined;
        unregisterA = registry.register(asRes(a), () => unregisterA());
        registry.register(asRes(b));
        registry.endAll();
        expect(a.end).toHaveBeenCalledTimes(1);
        expect(b.end).toHaveBeenCalledTimes(1);
        expect(registry.size()).toBe(0);
    });
});
