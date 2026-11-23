"use strict";

/**
 * @fileoverview ChangelogModel: AES-256-GCM encrypted file store in a private
 * temp dir (APP_ROOT redirected), key resolution, legacy-entry migration,
 * tamper/decrypt failure, and the cross-process lock (stale, busy, errors).
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

import ChangelogModel from "../../../../src/models/changelog.model";
import { logger } from "../../../../src/utils/logger";

const root = vi.hoisted(() => ({ dir: "" }));

vi.mock("../../../../src/utils/runtimePaths", async () => {
    const nodeFs = await import("fs");
    const nodeOs = await import("os");
    const nodePath = await import("path");
    root.dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "changelog-model-"));
    return { APP_ROOT: root.dir, IS_COMPILED: false };
});

const HEX_KEY = "ab".repeat(32);
const input = { displayDate: "2026-01-01", version: "1.0.0", title: "T", type: "feature", message: "m" };

function storePath() { return path.join(root.dir, "data", "changelog.enc"); }
function lockPath() { return storePath() + ".lock"; }

function encryptWith(key: Buffer, plaintext: string) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return JSON.stringify({ iv: iv.toString("hex"), authTag: c.getAuthTag().toString("hex"), ciphertext: enc.toString("hex") });
}

describe("ChangelogModel", function () {
    beforeEach(function () {
        fs.rmSync(path.join(root.dir, "data"), { recursive: true, force: true });
        vi.stubEnv("CHANGELOG_ENCRYPTION_KEY", HEX_KEY);
        vi.stubEnv("DATA_SIGNING_SECRET", "");
        for (const lvl of ["error", "notice", "debug", "info"] as const) {
            vi.spyOn(logger, lvl).mockImplementation(() => undefined as never);
        }
    });

    afterEach(function () {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    afterAll(function () {
        fs.rmSync(root.dir, { recursive: true, force: true });
    });

    describe("store lifecycle", function () {
        it("initialises an empty encrypted store on first read and never writes plaintext", function () {
            expect(ChangelogModel.listAll()).toEqual([]);
            const raw = fs.readFileSync(storePath(), "utf8");
            expect(JSON.parse(raw)).toEqual({ iv: expect.any(String), authTag: expect.any(String), ciphertext: expect.any(String) });
            expect(raw).not.toContain("entries");
            expect(logger.notice).toHaveBeenCalled();
        });

        it("create normalises list fields, persists, and listAll sorts newest date then createdAt", function () {
            vi.useFakeTimers();
            vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));
            const a = ChangelogModel.create({ ...input, displayDate: "2026-01-01", whatChanged: ["x"], authors: ["a"], coAuthors: ["c"] });
            expect(a).toMatchObject({ whatChanged: ["x"], authors: ["a"], coAuthors: ["c"], createdAt: "2026-03-01T00:00:00.000Z" });
            vi.setSystemTime(new Date("2026-03-02T00:00:00Z"));
            const b = ChangelogModel.create({ ...input, displayDate: "2026-02-01", whatChanged: "bad", authors: "bad", coAuthors: 5 });
            expect(b).toMatchObject({ whatChanged: [], authors: [], coAuthors: [] });
            vi.setSystemTime(new Date("2026-03-03T00:00:00Z"));
            const c = ChangelogModel.create({ ...input, displayDate: "2026-02-01" });
            expect(ChangelogModel.listAll().map((e) => e.id)).toEqual([c.id, b.id, a.id]);
        });

        it("findById returns the entry or a 404 AppError", function () {
            const e = ChangelogModel.create(input);
            expect(ChangelogModel.findById(e.id)).toMatchObject({ id: e.id, title: "T" });
            expect(() => ChangelogModel.findById("missing")).toThrow(expect.objectContaining({ statusCode: 404, message: "Changelog entry not found." }));
        });

        it("update applies only whitelisted, defined fields and bumps updatedAt", function () {
            vi.useFakeTimers();
            vi.setSystemTime(new Date("2026-04-01T00:00:00Z"));
            const e = ChangelogModel.create(input);
            vi.setSystemTime(new Date("2026-04-02T00:00:00Z"));
            const out = ChangelogModel.update(e.id, { title: "New", message: undefined, id: "hijack", createdAt: "1999", __proto__: { polluted: 1 } } as never);
            expect(out).toMatchObject({ id: e.id, title: "New", message: "m", createdAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-04-02T00:00:00.000Z" });
            expect(({} as Record<string, unknown>).polluted).toBeUndefined();
            expect(() => ChangelogModel.update("nope", { title: "x" })).toThrow(expect.objectContaining({ statusCode: 404 }));
        });

        it("delete removes one entry and 404s on an unknown id without writing", function () {
            const a = ChangelogModel.create(input);
            const b = ChangelogModel.create(input);
            ChangelogModel.delete(a.id);
            expect(ChangelogModel.listAll().map((e) => e.id)).toEqual([b.id]);
            const before = fs.readFileSync(storePath(), "utf8");
            expect(() => ChangelogModel.delete("ghost")).toThrow(expect.objectContaining({ statusCode: 404 }));
            expect(fs.readFileSync(storePath(), "utf8")).toBe(before);
        });

        it("resetStore replaces everything, keeping supplied ids/createdAt and generating the rest", function () {
            ChangelogModel.create(input);
            const n = ChangelogModel.resetStore([
                { id: "keep", createdAt: "2020-01-01T00:00:00.000Z", displayDate: "d", version: "v", title: "t", type: "x", whatChanged: ["w"], authors: ["a"], coAuthors: ["c"] },
                { displayDate: "d", version: "v", title: "t2", type: "x", whatChanged: 1, authors: 1, coAuthors: 1 },
            ]);
            expect(n).toBe(2);
            const all = ChangelogModel.listAll();
            expect(all).toHaveLength(2);
            expect(all.find((e) => e.id === "keep")).toMatchObject({ createdAt: "2020-01-01T00:00:00.000Z", whatChanged: ["w"] });
            const gen = all.find((e) => e.id !== "keep")!;
            expect(gen.id).toMatch(/^[0-9a-f-]{36}$/);
            expect(gen).toMatchObject({ whatChanged: [], authors: [], coAuthors: [] });
            expect(ChangelogModel.resetStore([])).toBe(0);
        });
    });

    describe("legacy migration", function () {
        function seed(entries: unknown[]) {
            fs.mkdirSync(path.dirname(storePath()), { recursive: true });
            fs.writeFileSync(storePath(), encryptWith(Buffer.from(HEX_KEY, "hex"), JSON.stringify({ entries })), "utf8");
        }

        it("converts summary -> message and defaults whatChanged, then rewrites the store", function () {
            seed([
                { id: "1", displayDate: "2025-01-01", createdAt: "a", summary: "old", version: "1", title: "t", type: "x" },
                { id: "2", displayDate: "2025-01-02", createdAt: "b", message: "m", version: "1", title: "t", type: "x" },
                { id: "3", displayDate: "2025-01-03", createdAt: "c", message: "m", whatChanged: ["k"], version: "1", title: "t", type: "x" },
            ]);
            const all = ChangelogModel.listAll();
            const byId = Object.fromEntries(all.map((e) => [e.id, e]));
            expect(byId["1"]).toMatchObject({ message: "old", whatChanged: [] });
            expect(byId["1"]).not.toHaveProperty("summary");
            expect(byId["2"].whatChanged).toEqual([]);
            expect(byId["3"].whatChanged).toEqual(["k"]);
            const spy = vi.spyOn(fs, "writeFileSync");
            ChangelogModel.listAll();
            expect(spy).not.toHaveBeenCalled(); // already migrated: no further rewrite
        });

        it("tolerates a store whose entries were already normalised (no rewrite)", function () {
            seed([{ id: "1", displayDate: "d", createdAt: "a", message: "m", whatChanged: [], version: "1", title: "t", type: "x" }]);
            const spy = vi.spyOn(fs, "writeFileSync");
            expect(ChangelogModel.listAll()).toHaveLength(1);
            expect(spy).not.toHaveBeenCalled();
        });
    });

    describe("encryption key handling", function () {
        it("derives a key from DATA_SIGNING_SECRET when no valid 64-hex key exists", function () {
            vi.stubEnv("CHANGELOG_ENCRYPTION_KEY", "short");
            vi.stubEnv("DATA_SIGNING_SECRET", "s".repeat(40));
            const e = ChangelogModel.create(input);
            expect(ChangelogModel.findById(e.id).id).toBe(e.id);
            const derived = crypto.createHash("sha256").update("s".repeat(40)).digest();
            const { iv, authTag, ciphertext } = JSON.parse(fs.readFileSync(storePath(), "utf8"));
            const d = crypto.createDecipheriv("aes-256-gcm", derived, Buffer.from(iv, "hex"));
            d.setAuthTag(Buffer.from(authTag, "hex"));
            expect(Buffer.concat([d.update(Buffer.from(ciphertext, "hex")), d.final()]).toString()).toContain(e.id);
        });

        it("fails closed with 503 when neither secret is usable (short fallback secret too)", function () {
            vi.stubEnv("CHANGELOG_ENCRYPTION_KEY", "");
            vi.stubEnv("DATA_SIGNING_SECRET", "x".repeat(31));
            expect(() => ChangelogModel.listAll()).toThrow(expect.objectContaining({ statusCode: 503 }));
            expect(fs.existsSync(storePath())).toBe(false);
            expect(logger.error).toHaveBeenCalled();
        });

        it("rejects a store encrypted with a different key (503, not a crash or plaintext leak)", function () {
            ChangelogModel.create(input);
            vi.stubEnv("CHANGELOG_ENCRYPTION_KEY", "cd".repeat(32));
            expect(() => ChangelogModel.listAll()).toThrow(expect.objectContaining({ statusCode: 503 }));
        });

        it("rejects tampered ciphertext and garbage files with 503", function () {
            ChangelogModel.create(input);
            const parsed = JSON.parse(fs.readFileSync(storePath(), "utf8"));
            parsed.ciphertext = (parsed.ciphertext[0] === "0" ? "1" : "0") + parsed.ciphertext.slice(1);
            fs.writeFileSync(storePath(), JSON.stringify(parsed));
            expect(() => ChangelogModel.listAll()).toThrow(expect.objectContaining({ statusCode: 503 }));
            fs.writeFileSync(storePath(), "not json");
            expect(() => ChangelogModel.findById("x")).toThrow(expect.objectContaining({ statusCode: 503 }));
        });

        it("reports a failed write as 503 and leaves no partial change visible", function () {
            ChangelogModel.create(input);
            vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => { throw new Error("ENOSPC"); });
            expect(() => ChangelogModel.create(input)).toThrow(expect.objectContaining({ statusCode: 503 }));
            expect(ChangelogModel.listAll()).toHaveLength(1);
            expect(fs.existsSync(lockPath())).toBe(false); // lock released on failure
        });
    });

    describe("write lock", function () {
        beforeEach(function () {
            ChangelogModel.listAll(); // ensure data dir + store exist
        });

        it("takes and always releases the lock file around a mutation", function () {
            ChangelogModel.create(input);
            expect(fs.existsSync(lockPath())).toBe(false);
            expect(() => ChangelogModel.delete("ghost")).toThrow();
            expect(fs.existsSync(lockPath())).toBe(false);
        });

        it("steals a stale lock left by a dead process", function () {
            fs.writeFileSync(lockPath(), "9999:1");
            const old = new Date(Date.now() - 60_000);
            fs.utimesSync(lockPath(), old, old);
            expect(ChangelogModel.create(input).title).toBe("T");
            expect(fs.existsSync(lockPath())).toBe(false);
        });

        it("survives a stale-lock unlink race (another waiter removed it first)", function () {
            fs.writeFileSync(lockPath(), "9999:1");
            const old = new Date(Date.now() - 60_000);
            fs.utimesSync(lockPath(), old, old);
            const realUnlink = fs.unlinkSync.bind(fs);
            vi.spyOn(fs, "unlinkSync").mockImplementationOnce((p) => { realUnlink(p); throw new Error("ENOENT"); });
            expect(ChangelogModel.create(input).title).toBe("T");
        });

        it("retries when the lock disappears between open and stat", function () {
            fs.writeFileSync(lockPath(), "9999:1");
            const realUnlink = fs.unlinkSync.bind(fs);
            vi.spyOn(fs, "statSync").mockImplementationOnce(() => { realUnlink(lockPath()); throw new Error("ENOENT"); });
            expect(ChangelogModel.create(input).title).toBe("T");
        });

        it("gives up with a 503 when a live lock stays busy past the timeout", function () {
            fs.writeFileSync(lockPath(), "1:1");
            const base = Date.now();
            let n = 0;
            vi.spyOn(Date, "now").mockImplementation(() => base + 3000 * n++);
            expect(() => ChangelogModel.create(input)).toThrow(expect.objectContaining({ statusCode: 503 }));
            expect(logger.error).toHaveBeenCalled();
            expect(fs.existsSync(lockPath())).toBe(true); // the foreign lock is not ours to remove
        });

        it("waits (bounded) for a live lock that is released while contending", function () {
            fs.writeFileSync(lockPath(), "1:1");
            const realStat = fs.statSync.bind(fs);
            let calls = 0;
            vi.spyOn(fs, "statSync").mockImplementation(((p: fs.PathLike, o?: never) => {
                const st = realStat(p, o);
                if (++calls === 1) fs.unlinkSync(lockPath()); // holder finishes after we observed it as live
                return st;
            }) as never);
            expect(ChangelogModel.create(input).title).toBe("T");
            expect(calls).toBeGreaterThanOrEqual(1);
        });

        it("propagates a non-EEXIST open error (e.g. permissions)", function () {
            vi.spyOn(fs, "openSync").mockImplementationOnce(() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
            expect(() => ChangelogModel.create(input)).toThrow("denied");
        });

        it("ignores a failing holder-metadata write and failing release cleanup", function () {
            vi.spyOn(fs, "writeSync").mockImplementationOnce(() => { throw new Error("EIO"); });
            const realClose = fs.closeSync.bind(fs);
            vi.spyOn(fs, "closeSync").mockImplementationOnce((fd) => { realClose(fd); throw new Error("EBADF"); });
            const realUnlink = fs.unlinkSync.bind(fs);
            vi.spyOn(fs, "unlinkSync").mockImplementationOnce((p) => { realUnlink(p); throw new Error("ENOENT"); });
            expect(ChangelogModel.create(input).title).toBe("T");
        });
    });
});
