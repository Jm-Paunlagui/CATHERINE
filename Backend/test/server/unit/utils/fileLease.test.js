"use strict";

/**
 * @fileoverview TC-1 — FileLease: exclusive create, stale by dead pid / mtime,
 * no steal while the holder heartbeat advances, token-checked release, waiter
 * touches its own scope. Real tmp dir, short timings.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { FileLease } = require("../../../../src/utils/locks/FileLease");
const { ProgressScope } = require("../../../../src/utils/progress/ProgressScope");

const NAME = ".t.lease";
let dir;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-lease-test-"));
});
afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

const opts = (extra = {}) => ({ dir, name: NAME, staleMs: 60_000, pollMs: 10, heartbeatMs: 20, ...extra });
const leasePath = () => path.join(dir, NAME);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("FileLease", () => {
    it("is exclusive: second acquire waits until the first releases", async () => {
        const a = new FileLease(opts());
        await a.acquire();
        const b = new FileLease(opts());
        let got = false;
        const pb = b.acquire().then(() => {
            got = true;
        });
        await sleep(80);
        expect(got).toBe(false);
        await a.release();
        await pb;
        expect(got).toBe(true);
        await b.release();
        expect(fs.existsSync(leasePath())).toBe(false);
    });

    it("steals a lease whose holder pid is dead (same host)", async () => {
        fs.writeFileSync(
            leasePath(),
            JSON.stringify({ pid: 2 ** 22 - 3, hostname: os.hostname(), token: "dead", acquiredAt: "x" }),
        );
        const b = new FileLease(opts());
        await b.acquire();
        expect(b.held).toBe(true);
        expect(JSON.parse(fs.readFileSync(leasePath(), "utf8")).token).not.toBe("dead");
        await b.release();
    });

    it("steals a lease whose mtime is older than staleMs (live pid, no progress)", async () => {
        fs.writeFileSync(
            leasePath(),
            JSON.stringify({ pid: process.ppid, hostname: "other-host", token: "old", acquiredAt: "x" }),
        );
        const old = new Date(Date.now() - 5000);
        fs.utimesSync(leasePath(), old, old);
        const b = new FileLease(opts({ staleMs: 1000 }));
        await b.acquire();
        expect(b.held).toBe(true);
        await b.release();
    });

    it("does NOT steal while the holder heartbeat keeps advancing", async () => {
        // staleMs is 50x heartbeatMs: a full-suite event-loop/disk stall longer
        // than staleMs ages the mtime past it and the waiter steals legitimately
        // (staleMs=150 flaked under 1004-file parallel load on Windows).
        const scope = new ProgressScope({ label: "holder", idleLimitMs: Infinity });
        const a = new FileLease(opts({ staleMs: 1000, scope }));
        await a.acquire();
        const ticker = setInterval(() => scope.touch("work"), 5);
        const b = new FileLease(opts({ staleMs: 1000 }));
        let got = false;
        const pb = b.acquire().then(() => {
            got = true;
        });
        try {
            await sleep(2500); // > 2x staleMs
            expect(got).toBe(false);
        } finally {
            clearInterval(ticker);
            await a.release();
            await pb;
            await b.release();
        }
    });

    it("steals once the holder stops progressing (heartbeat stops bumping mtime)", async () => {
        const scope = new ProgressScope({ label: "holder", idleLimitMs: Infinity });
        const a = new FileLease(opts({ staleMs: 150, scope }));
        await a.acquire(); // never touched afterwards
        const b = new FileLease(opts({ staleMs: 150 }));
        await b.acquire();
        expect(b.held).toBe(true);
        await b.release();
        await a.release(); // token mismatch / missing: must not throw
    });

    it("release is token-checked: never unlinks a lease owned by someone else", async () => {
        const a = new FileLease(opts());
        await a.acquire();
        fs.writeFileSync(
            leasePath(),
            JSON.stringify({ pid: process.pid, hostname: os.hostname(), token: "someone-else" }),
        );
        await a.release();
        expect(fs.existsSync(leasePath())).toBe(true);
    });

    it("waiter touches its own scope when the holder's mtime advances", async () => {
        const holderScope = new ProgressScope({ label: "holder", idleLimitMs: Infinity });
        const a = new FileLease(opts({ staleMs: 5000, scope: holderScope }));
        await a.acquire();
        const ticker = setInterval(() => holderScope.touch("work"), 5);

        const waiterScope = new ProgressScope({ label: "waiter", idleLimitMs: Infinity });
        const touchSpy = vi.spyOn(waiterScope, "touch");
        const b = new FileLease(opts({ staleMs: 5000, scope: waiterScope }));
        const pb = b.acquire();
        try {
            // Poll to a deadline, not a fixed sleep: a slow box may need several
            // heartbeat (20 ms) + poll (10 ms) cycles before mtime visibly advances.
            await vi.waitFor(() => expect(touchSpy).toHaveBeenCalledWith("lease-wait"), { timeout: 4000, interval: 20 });
        } finally {
            // Always drain the waiter: a pending acquire outliving afterEach's
            // rmSync throws ENOENT as an unhandled rejection.
            clearInterval(ticker);
            await a.release();
            await pb;
            await b.release();
        }
    });

    it("rejects path-unsafe names", () => {
        expect(() => new FileLease(opts({ name: "../x" }))).toThrow();
        expect(() => new FileLease(opts({ name: "a/b" }))).toThrow();
    });

    // ── Batch-2 review fixes (R14) and error-branch coverage ────────────────

    describe("error branches", () => {
        afterEach(() => vi.restoreAllMocks());

        const deadHolder = () =>
            fs.writeFileSync(
                leasePath(),
                JSON.stringify({ pid: 2 ** 22 - 3, hostname: os.hostname(), token: "dead", acquiredAt: "x" }),
            );

        it("rejects an empty dir", () => {
            expect(() => new FileLease(opts({ dir: "" }))).toThrow(/dir is required/);
            expect(() => new FileLease(opts({ dir: 5 }))).toThrow(/dir is required/);
        });

        it("ENOENT between create and stat: loops and acquires", async () => {
            fs.writeFileSync(leasePath(), JSON.stringify({ pid: process.ppid, hostname: "other", token: "t" }));
            const realStat = fs.promises.stat;
            vi.spyOn(fs.promises, "stat").mockImplementationOnce(async (p) => {
                fs.unlinkSync(leasePath()); // holder released in the gap
                return realStat(p);
            });
            const a = new FileLease(opts());
            await a.acquire();
            expect(a.held).toBe(true);
            await a.release();
        });

        it("stat error other than ENOENT is rethrown", async () => {
            fs.writeFileSync(leasePath(), JSON.stringify({ pid: process.ppid, hostname: "other", token: "t" }));
            vi.spyOn(fs.promises, "stat").mockRejectedValueOnce(Object.assign(new Error("io"), { code: "EIO" }));
            await expect(new FileLease(opts()).acquire()).rejects.toThrow("io");
        });

        it("open error other than EEXIST propagates and leaves the lease un-held", async () => {
            vi.spyOn(fs.promises, "open").mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
            const a = new FileLease(opts());
            await expect(a.acquire()).rejects.toThrow("denied");
            expect(a.held).toBe(false);
        });

        it("write failure closes the handle and removes the half-written lease file", async () => {
            const realOpen = fs.promises.open;
            vi.spyOn(fs.promises, "open").mockImplementationOnce(async (...args) => {
                const handle = await realOpen(...args);
                handle.writeFile = async () => {
                    throw new Error("ENOSPC");
                };
                return handle;
            });
            const a = new FileLease(opts());
            await expect(a.acquire()).rejects.toThrow("ENOSPC");
            expect(a.held).toBe(false);
            expect(fs.existsSync(leasePath())).toBe(false);
        });

        it("release without a token is a no-op (never touches the file)", async () => {
            fs.writeFileSync(leasePath(), JSON.stringify({ token: "foreign" }));
            const unlink = vi.spyOn(fs.promises, "unlink");
            await new FileLease(opts()).release();
            expect(unlink).not.toHaveBeenCalled();
            expect(fs.existsSync(leasePath())).toBe(true);
        });

        it("release: ENOENT on unlink is swallowed, any other unlink error is rethrown", async () => {
            const a = new FileLease(opts());
            await a.acquire();
            vi.spyOn(fs.promises, "unlink").mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "ENOENT" }));
            await expect(a.release()).resolves.toBeUndefined();
            fs.rmSync(leasePath(), { force: true });

            const b = new FileLease(opts());
            await b.acquire();
            vi.spyOn(fs.promises, "unlink").mockRejectedValueOnce(Object.assign(new Error("perm"), { code: "EPERM" }));
            await expect(b.release()).rejects.toThrow("perm");
        });

        it("_isStale: kill EPERM means the pid is alive (not stale); own pid is never stale", () => {
            const a = new FileLease(opts());
            const fresh = { mtimeMs: Date.now() };
            const info = { pid: process.pid + 1, hostname: os.hostname() };
            vi.spyOn(process, "kill").mockImplementation(() => {
                throw Object.assign(new Error("perm"), { code: "EPERM" });
            });
            expect(a._isStale(fresh, info)).toBe(false);
            process.kill.mockImplementation(() => {
                throw Object.assign(new Error("srch"), { code: "ESRCH" });
            });
            expect(a._isStale(fresh, info)).toBe(true);
            expect(a._isStale(fresh, { pid: process.pid, hostname: os.hostname() })).toBe(false);
            expect(a._isStale(fresh, null)).toBe(false);
        });

        it("_steal: losing the rename race (ENOENT) returns false; other rename errors throw", async () => {
            const a = new FileLease(opts());
            vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(Object.assign(new Error("x"), { code: "ENOENT" }));
            await expect(a._steal({ token: "t" })).resolves.toBe(false);
            vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }));
            await expect(a._steal({ token: "t" })).rejects.toThrow("busy");
        });

        it("_steal: a racing stealer's fresh lease is put back and the steal reports false", async () => {
            fs.writeFileSync(leasePath(), JSON.stringify({ pid: process.ppid, hostname: "h", token: "FRESH" }));
            const a = new FileLease(opts());
            await expect(a._steal({ token: "STALE", pid: 1, hostname: "h" })).resolves.toBe(false);
            expect(JSON.parse(fs.readFileSync(leasePath(), "utf8")).token).toBe("FRESH");
            expect(fs.readdirSync(dir).filter((f) => f.includes(".stale-"))).toEqual([]);
        });

        it("_steal: put-back still cleans the graveyard when the path was re-taken meanwhile", async () => {
            fs.writeFileSync(leasePath(), JSON.stringify({ token: "FRESH" }));
            vi.spyOn(fs.promises, "link").mockRejectedValueOnce(Object.assign(new Error("exists"), { code: "EEXIST" }));
            const a = new FileLease(opts());
            await expect(a._steal({ token: "STALE" })).resolves.toBe(false);
            expect(fs.readdirSync(dir).filter((f) => f.includes(".stale-"))).toEqual([]);
        });

        it("_steal: a stale lease with an unreadable body is stolen", async () => {
            fs.writeFileSync(leasePath(), "not json");
            const a = new FileLease(opts());
            await expect(a._steal(null)).resolves.toBe(true);
            expect(fs.existsSync(leasePath())).toBe(false);
        });

        it("a lost steal race inside acquire keeps polling and then acquires", async () => {
            deadHolder();
            vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(Object.assign(new Error("x"), { code: "ENOENT" }));
            const a = new FileLease(opts());
            await a.acquire();
            expect(a.held).toBe(true);
            await a.release();
        });
    });

    describe("_beat", () => {
        it("no token: nothing is written", async () => {
            const utimes = vi.spyOn(fs.promises, "utimes");
            await new FileLease(opts())._beat();
            expect(utimes).not.toHaveBeenCalled();
            utimes.mockRestore();
        });

        it("no scope: always bumps mtime", async () => {
            const a = new FileLease(opts({ heartbeatMs: 60_000 }));
            await a.acquire();
            const old = new Date(Date.now() - 10_000);
            fs.utimesSync(leasePath(), old, old);
            await a._beat();
            expect(Date.now() - fs.statSync(leasePath()).mtimeMs).toBeLessThan(2000);
            await a.release();
        });

        it("scope that did not progress: no bump", async () => {
            const scope = new ProgressScope({ label: "h", idleLimitMs: Infinity });
            const a = new FileLease(opts({ heartbeatMs: 60_000, scope }));
            await a.acquire();
            const old = new Date(Date.now() - 10_000);
            fs.utimesSync(leasePath(), old, old);
            a._lastBeatProgressAt = scope.lastProgressAt; // nothing newer
            await a._beat();
            expect(Date.now() - fs.statSync(leasePath()).mtimeMs).toBeGreaterThan(5000);
            await a.release();
        });

        it("a losing holder never bumps the NEW holder's file (token re-read)", async () => {
            const a = new FileLease(opts({ heartbeatMs: 60_000 }));
            await a.acquire();
            // a stealer replaced the lease
            fs.writeFileSync(leasePath(), JSON.stringify({ pid: process.pid, hostname: os.hostname(), token: "NEW-HOLDER" }));
            const old = new Date(Date.now() - 10_000);
            fs.utimesSync(leasePath(), old, old);
            await a._beat();
            expect(Date.now() - fs.statSync(leasePath()).mtimeMs).toBeGreaterThan(5000);
            await a.release();
            expect(fs.existsSync(leasePath())).toBe(true); // and release leaves it alone
        });

        it("bindScope resets the progress watermark", () => {
            const a = new FileLease(opts());
            a._lastBeatProgressAt = 5;
            a.bindScope(null);
            expect(a._lastBeatProgressAt).toBe(0);
        });
    });
});
