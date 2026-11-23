"use strict";

/**
 * @fileoverview Regression: AuditLogFileModel.deleteMany counts a day's lines
 * into rowsAffected ONLY after fs.rm(dir) succeeds. Previously a day whose
 * directory could not be removed was still reported as deleted.
 *
 * Runs against a real temp directory: runtimePaths is mocked to the compiled
 * arm with APP_ROOT = a fresh mkdtemp, so CONFIG.BASE_DIR = <tmp>/logs/Main.
 * Only fs.rm on the model's `promises` object is spied, and only to make one
 * day's removal fail.
 */

import { promises as fs, existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import os from "os";
import path from "path";


const TMP_PREFIX = "audit-deleteMany-";

vi.mock("../../../../src/utils/runtimePaths", async (importOriginal) => {
    const real = await importOriginal<typeof import("../../../../src/utils/runtimePaths")>();
    const { mkdtempSync } = await import("fs");
    const os = await import("os");
    const p = await import("path");
    const root = mkdtempSync(p.join(os.tmpdir(), "audit-deleteMany-"));
    return { ...real, IS_COMPILED: true, APP_ROOT: root, appPath: (...s: string[]) => p.join(root, ...s) };
});

/**
 * Recursive delete that refuses anything but this suite's own temp directory.
 * The model may have been loaded (by the shared setup chain) before the mock above;
 * without this guard a wrongly-resolved BASE_DIR would point into the working tree.
 */
function safeRm(target: string): void {
    const resolved = path.resolve(target);
    const tmp = path.resolve(os.tmpdir());
    const rel = path.relative(tmp, resolved);
    const top = rel.split(path.sep)[0];
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || !top.startsWith(TMP_PREFIX)) {
        throw new Error(`refusing to delete outside the suite temp dir: ${resolved}`);
    }
    rmSync(resolved, { recursive: true, force: true });
}

let logger: typeof import("../../../../src/utils/logger").logger;
let AuditLogFileModel: typeof import("../../../../src/models/audit.log.file.model").default;
let BASE: string;
let ROOT: string;

// Evaluate the model AFTER the runtimePaths mock so BASE_DIR is rooted in the temp dir,
// even if the setup chain already loaded a copy under the real paths.
beforeAll(async () => {
    vi.resetModules();
    ({ logger } = await import("../../../../src/utils/logger"));
    AuditLogFileModel = (await import("../../../../src/models/audit.log.file.model")).default;
    BASE = AuditLogFileModel.CONFIG.BASE_DIR;
    ROOT = path.resolve(BASE, "..", "..");
    safeRm(path.join(BASE, "__guard_probe__")); // throws now if BASE is not inside the temp root
});

/** Same Manila-day directory naming the model uses. */
function dayDir(date: Date): string {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-CA", AuditLogFileModel.CONFIG.DATE_OPTIONS)
            .formatToParts(date)
            .map(({ type, value }) => [type, value]),
    );
    return path.join(BASE, parts.year, parts.month, parts.day);
}

/** Mirrors the model's calendar-day walk so the test is timezone-agnostic. */
function resolvedDays(from: Date, to: Date): string[] {
    const out: string[] = [];
    const cursor = new Date(from);
    cursor.setHours(0, 0, 0, 0);
    const end = new Date(to);
    end.setHours(23, 59, 59, 999);
    while (cursor <= end) {
        out.push(dayDir(cursor));
        cursor.setDate(cursor.getDate() + 1);
    }
    return out;
}

const line = (id: string) => `${JSON.stringify({ REQUEST_ID: id, CREATED_AT: "2026-03-05T04:00:00.000Z" })}\n`;

const FROM = new Date("2026-03-05T12:00:00Z");
const TO = new Date("2026-03-06T12:00:00Z");
const FILTER = { CREATED_AT: { $gte: FROM, $lte: TO } };

let dayA: string;
let dayB: string;
let fileA: string;
let fileB1: string;
let fileB2: string;

describe("AuditLogFileModel.deleteMany — rowsAffected only counts removed days (regression)", function () {
    beforeEach(function () {
        vi.spyOn(logger, "warning").mockImplementation(async () => {});
        safeRm(BASE);
        [dayA, dayB] = resolvedDays(FROM, TO);
        mkdirSync(dayA, { recursive: true });
        mkdirSync(dayB, { recursive: true });
        // Day A: 3 records (one malformed line and a blank line are not counted).
        fileA = path.join(dayA, "audit.log");
        writeFileSync(fileA, line("a1") + line("a2") + "{broken\n\n" + line("a3"));
        // Day B: 2 + 1 records across a rotated file; a non-audit file is ignored.
        fileB1 = path.join(dayB, "audit.log");
        fileB2 = path.join(dayB, "audit_1.log");
        writeFileSync(fileB1, line("b1") + line("b2"));
        writeFileSync(fileB2, line("b3"));
        writeFileSync(path.join(dayB, "notes.txt"), line("x1"));
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    afterAll(function () {
        if (ROOT) safeRm(ROOT);
    });

    it("the store is rooted in the temp directory, not the working tree", function () {
        expect(BASE).toBe(path.join(ROOT, "logs", "Main"));
        expect(path.basename(ROOT)).toMatch(/^audit-deleteMany-/);
        expect(ROOT.startsWith(os.tmpdir())).toBe(true);
        expect(dayA).not.toBe(dayB);
    });

    it("counts only the day whose directory was actually removed when rm fails for the other", async function () {
        const realRm = fs.rm.bind(fs);
        const rmSpy = vi.spyOn(fs, "rm").mockImplementation((async (p: string, opts?: Parameters<typeof fs.rm>[1]) => {
            if (p === dayB) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
            return realRm(p, opts);
        }) as typeof fs.rm);

        const res = await AuditLogFileModel.deleteMany(FILTER);

        expect(res).toEqual({ rowsAffected: 3 });
        expect(rmSpy).toHaveBeenCalledWith(dayA, { recursive: true, force: true });
        expect(rmSpy).toHaveBeenCalledWith(dayB, { recursive: true, force: true });
        expect(existsSync(dayA)).toBe(false);
        expect(existsSync(fileB1)).toBe(true);
        expect(existsSync(fileB2)).toBe(true);
    });

    it("counts nothing for the failing day even when it is the first one", async function () {
        const realRm = fs.rm.bind(fs);
        vi.spyOn(fs, "rm").mockImplementation((async (p: string, opts?: Parameters<typeof fs.rm>[1]) => {
            if (p === dayA) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
            return realRm(p, opts);
        }) as typeof fs.rm);

        expect(await AuditLogFileModel.deleteMany(FILTER)).toEqual({ rowsAffected: 3 });
        expect(existsSync(fileA)).toBe(true);
        expect(existsSync(dayB)).toBe(false);
    });

    it("reports 0 and keeps every file when rm fails for every day", async function () {
        vi.spyOn(fs, "rm").mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }));
        expect(await AuditLogFileModel.deleteMany(FILTER)).toEqual({ rowsAffected: 0 });
        for (const f of [fileA, fileB1, fileB2]) expect(existsSync(f)).toBe(true);
    });

    it("happy path: removes both days and counts both days' records", async function () {
        const rmSpy = vi.spyOn(fs, "rm");
        expect(await AuditLogFileModel.deleteMany(FILTER)).toEqual({ rowsAffected: 6 });
        expect(rmSpy).toHaveBeenCalledWith(dayA, { recursive: true, force: true });
        expect(rmSpy).toHaveBeenCalledWith(dayB, { recursive: true, force: true });
        expect(existsSync(dayA)).toBe(false);
        expect(existsSync(dayB)).toBe(false);
    });

    it("returns 0 without touching the filesystem when the filter has no full date range", async function () {
        const rmSpy = vi.spyOn(fs, "rm");
        expect(await AuditLogFileModel.deleteMany({})).toEqual({ rowsAffected: 0 });
        expect(await AuditLogFileModel.deleteMany({ CREATED_AT: { $gte: FROM } })).toEqual({ rowsAffected: 0 });
        expect(rmSpy).not.toHaveBeenCalled();
        expect(existsSync(fileA)).toBe(true);
        expect(existsSync(fileB1)).toBe(true);
    });
});
