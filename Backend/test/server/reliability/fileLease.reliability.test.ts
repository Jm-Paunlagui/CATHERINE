import { promises as fsp } from "fs";
import os from "os";
import path from "path";

import { FileLease } from "../../../src/utils/locks/FileLease";
import { ProgressScope } from "../../../src/utils/progress/ProgressScope";
import { runInScope } from "../../../src/utils/progress/progress";
import { logger } from "../../../src/utils/logger";

let dir: string;
const NAME = "t.lease";
const leasePath = () => path.join(dir, NAME);
const mk = (over: Record<string, unknown> = {}) => new FileLease({ dir, name: NAME, staleMs: 60_000, pollMs: 5, heartbeatMs: 20, ...over } as never);
const readInfo = async () => JSON.parse(await fsp.readFile(leasePath(), "utf8"));
const writeForeign = async (info: Record<string, unknown>, ageMs = 0) => {
    await fsp.writeFile(leasePath(), JSON.stringify(info));
    if (ageMs) { const t = new Date(Date.now() - ageMs); await fsp.utimes(leasePath(), t, t); }
};

beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lease-"));
    for (const lvl of ["info", "notice", "warning", "error"] as const) vi.spyOn(logger, lvl).mockImplementation(() => undefined as never);
});
afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fsp.rm(dir, { recursive: true, force: true });
});

describe("FileLease construction", () => {
    it.each(["", "a/b", "..", "a..b", "a b", 5 as never])("rejects bad name %j", (name) => {
        expect(() => new FileLease({ dir, name, staleMs: 1 })).toThrow(/plain filename/);
    });
    it("rejects an empty dir", () => {
        expect(() => new FileLease({ dir: "", name: "x", staleMs: 1 })).toThrow(/dir is required/);
    });
    it("exposes path and held state", async () => {
        const l = mk();
        expect(l.path).toBe(leasePath());
        expect(l.held).toBe(false);
        await l.acquire();
        expect(l.held).toBe(true);
        await l.release();
        expect(l.held).toBe(false);
    });
});

describe("acquire / release", () => {
    it("writes pid, hostname and token, and release removes the file", async () => {
        const l = mk();
        await l.acquire();
        const info = await readInfo();
        expect(info).toMatchObject({ pid: process.pid, hostname: os.hostname() });
        expect(info.token).toHaveLength(32);
        await l.release();
        await expect(fsp.stat(leasePath())).rejects.toThrow();
    });
    it("release is idempotent and safe before acquire", async () => {
        const l = mk();
        await l.release();
        await l.acquire();
        await l.release();
        await l.release();
    });
    it("release never deletes a lease now owned by someone else", async () => {
        const l = mk();
        await l.acquire();
        await writeForeign({ pid: 1, hostname: "other", token: "foreign" });
        await l.release();
        expect((await readInfo()).token).toBe("foreign");
    });
    it("release tolerates the file already being gone and rethrows other unlink errors", async () => {
        const a = mk();
        await a.acquire();
        const real = fsp.unlink.bind(fsp);
        vi.spyOn(fsp, "unlink").mockImplementationOnce((async (p: string) => { await real(p); throw Object.assign(new Error("gone"), { code: "ENOENT" }); }) as never);
        await a.release();
        const b = mk();
        await b.acquire();
        vi.spyOn(fsp, "unlink").mockRejectedValueOnce(Object.assign(new Error("perm"), { code: "EPERM" }));
        await expect(b.release()).rejects.toThrow("perm");
    });
    it("withLease holds during fn, releases on success and on failure", async () => {
        const seen: boolean[] = [];
        await FileLease.withLease({ dir, name: NAME, staleMs: 1000 }, async (l) => { seen.push(l.held); });
        await expect(FileLease.withLease({ dir, name: NAME, staleMs: 1000 }, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
        expect(seen).toEqual([true]);
        await expect(fsp.stat(leasePath())).rejects.toThrow();
    });
    it("propagates unexpected open errors from acquire", async () => {
        vi.spyOn(fsp, "open").mockRejectedValueOnce(Object.assign(new Error("EACCES"), { code: "EACCES" }));
        await expect(mk().acquire()).rejects.toThrow("EACCES");
    });
    it("cleans up the file if writing the lease body fails", async () => {
        const real = fsp.open.bind(fsp);
        vi.spyOn(fsp, "open").mockImplementationOnce((async (p: string, f: string) => {
            const h = await real(p, f);
            vi.spyOn(h, "writeFile").mockRejectedValueOnce(new Error("ENOSPC"));
            return h;
        }) as never);
        await expect(mk().acquire()).rejects.toThrow("ENOSPC");
        await expect(fsp.stat(leasePath())).rejects.toThrow();
    });
});

describe("contention", () => {
    it("a second acquirer waits for a live holder, logs once, and proceeds after release", async () => {
        const a = mk();
        await a.acquire();
        const b = mk();
        const order: string[] = [];
        const bDone = b.acquire().then(() => order.push("b"));
        await vi.waitFor(() => expect(logger.info).toHaveBeenCalledTimes(1));
        await new Promise((r) => setTimeout(r, 30));
        expect(order).toEqual([]);
        expect(logger.info).toHaveBeenCalledTimes(1);
        await a.release();
        await bDone;
        expect(order).toEqual(["b"]);
        expect(b.held).toBe(true);
        await b.release();
    });

    it("steals a lease whose mtime is older than staleMs", async () => {
        await writeForeign({ pid: 1, hostname: "elsewhere", token: "old" }, 120_000);
        const l = mk();
        await l.acquire();
        expect((await readInfo()).token).not.toBe("old");
        expect(logger.warning).toHaveBeenCalledTimes(1);
        expect((await fsp.readdir(dir)).filter((n) => n.includes(".stale-"))).toEqual([]);
        await l.release();
    });

    it("steals a lease whose same-host holder process is dead", async () => {
        const deadPid = 2_147_483_000;
        await writeForeign({ pid: deadPid, hostname: os.hostname(), token: "dead" });
        const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("no such process"), { code: "ESRCH" }); });
        const l = mk();
        await l.acquire();
        expect(kill).toHaveBeenCalledWith(deadPid, 0);
        expect(logger.warning).toHaveBeenCalledTimes(1);
        await l.release();
    });

    it("does not steal from a same-host holder that is alive but unsignalable (EPERM)", async () => {
        await writeForeign({ pid: 4242, hostname: os.hostname(), token: "alive" });
        vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("eperm"), { code: "EPERM" }); });
        const l = mk();
        const done = l.acquire();
        await vi.waitFor(() => expect(logger.info).toHaveBeenCalled());
        expect(l.held).toBe(false);
        await fsp.unlink(leasePath());
        await done;
        await l.release();
    });

    it("does not steal from a live same-host pid, a foreign host, or a non-integer pid", async () => {
        const l = mk();
        const l2 = mk();
        expect(l._isStale({ mtimeMs: Date.now() } as never, { pid: process.pid, hostname: os.hostname() })).toBe(false);
        expect(l._isStale({ mtimeMs: Date.now() } as never, { pid: 99999999, hostname: "other-host" })).toBe(false);
        expect(l._isStale({ mtimeMs: Date.now() } as never, { pid: 1.5, hostname: os.hostname() })).toBe(false);
        expect(l._isStale({ mtimeMs: Date.now() } as never, { pid: "7", hostname: os.hostname() })).toBe(false);
        expect(l._isStale({ mtimeMs: Date.now() } as never, null)).toBe(false);
        expect(l2._isStale({ mtimeMs: Date.now() - 61_000 } as never, null)).toBe(true);
    });

    it("tolerates the lease disappearing between create attempt and stat", async () => {
        await writeForeign({ pid: 1, hostname: "elsewhere", token: "x" });
        const real = fsp.stat.bind(fsp);
        vi.spyOn(fsp, "stat").mockImplementationOnce((async (p: string) => {
            await fsp.unlink(p);
            return real(p);
        }) as never);
        const l = mk();
        await l.acquire();
        expect(l.held).toBe(true);
        await l.release();
    });

    it("propagates unexpected stat errors while waiting", async () => {
        await writeForeign({ pid: 1, hostname: "elsewhere", token: "x" });
        vi.spyOn(fsp, "stat").mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));
        await expect(mk().acquire()).rejects.toThrow("EIO");
    });

    it("loses a steal race gracefully: if another acquirer renamed it first, keep polling", async () => {
        await writeForeign({ pid: 1, hostname: "elsewhere", token: "old" }, 120_000);
        const l = mk();
        vi.spyOn(fsp, "rename").mockImplementationOnce((async () => { await fsp.unlink(leasePath()); throw Object.assign(new Error("gone"), { code: "ENOENT" }); }) as never);
        expect(await l._steal({ token: "old" })).toBe(false);
        await l.acquire();
        await l.release();
    });

    it("rethrows unexpected rename errors from steal", async () => {
        await writeForeign({ pid: 1, hostname: "x", token: "old" });
        vi.spyOn(fsp, "rename").mockRejectedValueOnce(Object.assign(new Error("EBUSY"), { code: "EBUSY" }));
        await expect(mk()._steal({ token: "old" })).rejects.toThrow("EBUSY");
    });

    it("puts back a lease that changed hands between observation and steal (victim keeps its lock)", async () => {
        await writeForeign({ pid: 1, hostname: "x", token: "newer-owner" });
        const l = mk();
        expect(await l._steal({ token: "stale-observed" })).toBe(false);
        expect((await readInfo()).token).toBe("newer-owner");
        expect((await fsp.readdir(dir)).filter((n) => n.includes(".stale-"))).toEqual([]);
        expect(logger.warning).not.toHaveBeenCalled();
    });

    it("a failed put-back (path re-taken) still cleans the graveyard", async () => {
        await writeForeign({ pid: 1, hostname: "x", token: "newer-owner" });
        const l = mk();
        vi.spyOn(fsp, "link").mockRejectedValueOnce(Object.assign(new Error("EEXIST"), { code: "EEXIST" }));
        expect(await l._steal({ token: "stale-observed" })).toBe(false);
        expect((await fsp.readdir(dir)).filter((n) => n.includes(".stale-"))).toEqual([]);
    });

    it("steals a corrupt lease file once it is stale", async () => {
        await fsp.writeFile(leasePath(), "{{{garbage");
        const t = new Date(Date.now() - 120_000);
        await fsp.utimes(leasePath(), t, t);
        const l = mk();
        await l.acquire();
        expect(l.held).toBe(true);
        expect(logger.warning).toHaveBeenCalledTimes(1);
        await l.release();
    });
});

describe("cancellation while waiting", () => {
    it("an aborted scope stops the wait with its abort error", async () => {
        const a = mk();
        await a.acquire();
        const scope = new ProgressScope({ label: "waiter", idleLimitMs: 1e9 });
        const b = mk({ scope });
        const p = b.acquire().then(() => null, (e) => e);
        await vi.waitFor(() => expect(logger.info).toHaveBeenCalled());
        scope.abort(new Error("cancelled by watchdog"));
        expect(((await p) as Error).message).toBe("cancelled by watchdog");
        expect(b.held).toBe(false);
        await a.release();
    });

    it("uses the ambient scope when none is bound and touches it when the holder heartbeats", async () => {
        const a = mk({ heartbeatMs: 10 });
        await a.acquire();
        const scope = new ProgressScope({ label: "ambient", idleLimitMs: 1e9 });
        const touch = vi.spyOn(scope, "touch");
        const b = mk();
        const p = runInScope(scope, () => b.acquire());
        const t = new Date(Date.now() + 5000);
        await vi.waitFor(() => expect(logger.info).toHaveBeenCalled());
        await fsp.utimes(leasePath(), t, t);
        await vi.waitFor(() => expect(touch).toHaveBeenCalledWith("lease-wait"));
        await a.release();
        await p;
        await b.release();
    });
});

describe("heartbeat", () => {
    it("refreshes the lease mtime while the holder is making progress", async () => {
        const scope = new ProgressScope({ label: "work", idleLimitMs: 1e9 });
        const l = mk({ scope, heartbeatMs: 10_000 });
        await l.acquire();
        const old = new Date(Date.now() - 50_000);
        await fsp.utimes(leasePath(), old, old);
        scope.touch("step");
        await l._beat();
        expect((await fsp.stat(leasePath())).mtimeMs).toBeGreaterThan(old.getTime() + 40_000);
        const afterFirst = (await fsp.stat(leasePath())).mtimeMs;
        await fsp.utimes(leasePath(), old, old);
        await l._beat(); // no new progress -> no refresh: a wedged holder must go stale
        expect((await fsp.stat(leasePath())).mtimeMs).toBeLessThan(afterFirst);
        await l.release();
    });

    it("bindScope resets the progress watermark so the next beat refreshes", async () => {
        const scope = new ProgressScope({ label: "w", idleLimitMs: 1e9 });
        const l = mk({ scope });
        await l.acquire();
        await l._beat();
        const old = new Date(Date.now() - 50_000);
        await fsp.utimes(leasePath(), old, old);
        l.bindScope(scope);
        await l._beat();
        expect((await fsp.stat(leasePath())).mtimeMs).toBeGreaterThan(old.getTime() + 40_000);
        await l.release();
    });

    it("beats without a scope, and never touches a lease it no longer owns or never held", async () => {
        const l = mk();
        await l._beat(); // not held
        await l.acquire();
        const old = new Date(Date.now() - 50_000);
        await fsp.utimes(leasePath(), old, old);
        await l._beat();
        expect((await fsp.stat(leasePath())).mtimeMs).toBeGreaterThan(old.getTime() + 40_000);
        await writeForeign({ pid: 1, hostname: "x", token: "thief" }, 50_000);
        const before = (await fsp.stat(leasePath())).mtimeMs;
        await l._beat();
        expect((await fsp.stat(leasePath())).mtimeMs).toBe(before);
        await l.release();
    });

    it("the interval timer drives beats and swallows beat errors", async () => {
        const l = mk({ heartbeatMs: 5 });
        const beat = vi.spyOn(l, "_beat").mockRejectedValue(new Error("fs hiccup"));
        await l.acquire();
        await vi.waitFor(() => expect(beat.mock.calls.length).toBeGreaterThanOrEqual(2));
        await l.release();
        const calls = beat.mock.calls.length;
        await new Promise((r) => setTimeout(r, 25));
        expect(beat.mock.calls.length).toBe(calls); // heartbeat stopped on release
    });
});
