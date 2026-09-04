"use strict";

/**
 * httpStatusCatalog.test.js — The backend half of the status-code contract.
 *
 * Two jobs:
 *
 *  1. Structural — HTTP_STATUS and HTTP_STATUS_TITLES agree with each other,
 *     and getStatusTitle() never returns an empty label.
 *
 *  2. Enforcement — a repo-wide scan of `src/` that fails when any code path
 *     emits a status the catalogue does not know about. Without this, the
 *     "single source of truth" is only true until the next `throw new
 *     AppError(msg, 451)` lands, and the frontend silently falls back to the
 *     generic "Client Error" label for a code nobody mapped.
 *
 * Pure — no DB, no HTTP, no network.
 */

const fs = require("fs");
const path = require("path");

const { HTTP_STATUS } = require("../../../src/constants");
const {
    HTTP_STATUS_TITLES,
    getStatusTitle,
    sendError,
    sendSuccess,
} = require("../../../src/constants/responses");
// OraCode.js exports the map itself (module.exports = ORA_MAP), not a named field.
const ORA_MAP = require("../../../src/middleware/errorHandling/OraCode");
const {
    NJS_MAP,
    TRANSIENT_STRING_PATTERNS,
} = require("../../../src/middleware/errorHandling/NjsCode");

const SRC_ROOT = path.join(__dirname, "..", "..", "..", "src");

/* ─── Source scanning helpers ────────────────────────────────────────────────── */

/** Collect every .js file under src/, skipping node_modules. O(f) in file count. */
function collectSourceFiles(dir, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "node_modules") continue;
            collectSourceFiles(full, acc);
        } else if (entry.name.endsWith(".js")) {
            acc.push(full);
        }
    }
    return acc;
}

/**
 * Splits an argument list on top-level commas only, so a nested object literal
 * or call in argument 3 never fragments argument 2.
 * O(n) time in the argument-string length, O(n) space.
 */
function splitTopLevelArgs(argString) {
    const parts = [];
    let depth = 0; // (), [], {} nesting, outside strings
    let current = "";
    let quote = null; // active string delimiter: ' " or `
    let escaped = false;
    let tplDepth = 0; // ${ } nesting inside a template literal

    for (let i = 0; i < argString.length; i += 1) {
        const ch = argString[i];
        current += ch;

        // A backslash escapes the next character wherever we are.
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === "\\") {
            escaped = true;
            continue;
        }

        // Inside a string every character is opaque — INCLUDING a comma. This
        // is the whole point of tracking quote state: an AppError message such
        // as `weight at index ${i} must be a whole number or BigInt, ...`
        // contains a comma that is punctuation, not an argument separator. A
        // depth-only splitter cuts there, hands back the message tail as
        // argument 2, and the call site is misreported as runtime-dynamic.
        if (quote) {
            if (quote === "`" && ch === "$" && argString[i + 1] === "{") {
                tplDepth += 1;
            } else if (quote === "`" && tplDepth > 0 && ch === "}") {
                tplDepth -= 1;
            } else if (ch === quote && tplDepth === 0) {
                quote = null;
            }
            continue;
        }

        if (ch === "'" || ch === '"' || ch === "`") {
            quote = ch;
        } else if ("([{".includes(ch)) {
            depth += 1;
        } else if (")]}".includes(ch)) {
            depth -= 1;
        } else if (ch === "," && depth === 0) {
            parts.push(current.slice(0, -1)); // drop the separator itself
            current = "";
        }
    }
    parts.push(current);
    return parts;
}

/**
 * Finds every `new AppError(message, <status>, ...)` in a source file and
 * resolves argument 2 to a number, following `HTTP_STATUS.KEY` references.
 * Returns `{ code, file, line }` records; call sites whose status is computed
 * at runtime (a lookup table, a variable) are reported separately as dynamic.
 */
function scanAppErrorCalls(file, text) {
    const found = [];
    const dynamic = [];
    const re = /new\s+AppError\s*\(/g;
    let match;

    while ((match = re.exec(text)) !== null) {
        const openIndex = match.index + match[0].length;
        let depth = 1;
        let i = openIndex;
        let close = -1;
        while (i < text.length) {
            const ch = text[i];
            if (ch === "(") depth += 1;
            else if (ch === ")") {
                depth -= 1;
                if (depth === 0) {
                    close = i;
                    break;
                }
            }
            i += 1;
        }
        if (close === -1) continue;

        const args = splitTopLevelArgs(text.slice(openIndex, close));
        const statusArg = (args[1] || "").trim();
        const line = text.slice(0, match.index).split(/\r?\n/).length;
        const where = `${path.relative(SRC_ROOT, file).split(path.sep).join("/")}:${line}`;

        const literal = statusArg.match(/^(\d{3})$/);
        const named = statusArg.match(/^HTTP_STATUS\.(\w+)$/);

        if (literal) found.push({ code: Number(literal[1]), where });
        else if (named) {
            const resolved = HTTP_STATUS[named[1]];
            // An unknown HTTP_STATUS key resolves to undefined — surface it as a
            // hard failure rather than silently skipping the call site.
            found.push({ code: resolved ?? `HTTP_STATUS.${named[1]} (undefined)`, where });
        } else if (statusArg) dynamic.push({ expr: statusArg, where });
    }

    return { found, dynamic };
}

/** Finds `res.status(<n>)` / `res.status(HTTP_STATUS.KEY)` call sites. */
function scanResStatusCalls(file, text) {
    const found = [];
    const re = /res\s*\.\s*status\(\s*(?:HTTP_STATUS\.)?(\w+)\s*\)/g;
    let match;
    while ((match = re.exec(text)) !== null) {
        const token = match[1];
        const code = /^\d{3}$/.test(token) ? Number(token) : HTTP_STATUS[token];
        if (code === undefined) continue; // res.status(someVariable) — dynamic
        const line = text.slice(0, match.index).split(/\r?\n/).length;
        found.push({
            code,
            where: `${path.relative(SRC_ROOT, file).split(path.sep).join("/")}:${line}`,
        });
    }
    return found;
}

/* ─── Cached scan (one pass, reused by every assertion) ──────────────────────── */

let SCAN;
beforeAll(function () {
    const files = collectSourceFiles(SRC_ROOT);
    const emitted = [];
    const dynamic = [];
    for (const file of files) {
        const text = fs.readFileSync(file, "utf8");
        const appError = scanAppErrorCalls(file, text);
        emitted.push(...appError.found, ...scanResStatusCalls(file, text));
        dynamic.push(...appError.dynamic);
    }
    SCAN = { files, emitted, dynamic };
});

/* ─── Tests ──────────────────────────────────────────────────────────────────── */

describe("HTTP status catalogue", function () {
    describe("structure", function () {
        it("gives every HTTP_STATUS value a title, except the 2xx codes that never appear in an error envelope", function () {
            // 200/201/202/204 are success codes — sendSuccess() carries no title
            // field, so they are deliberately absent from the title map.
            const TITLE_EXEMPT = new Set([200, 201, 202, 204]);
            const missing = Object.entries(HTTP_STATUS)
                .filter(([, code]) => !TITLE_EXEMPT.has(code))
                .filter(([, code]) => !HTTP_STATUS_TITLES[code])
                .map(([name, code]) => `${name} (${code})`);

            expect(missing).toEqual([]);
        });

        it("gives every title a matching HTTP_STATUS entry", function () {
            const known = new Set(Object.values(HTTP_STATUS));
            const orphans = Object.keys(HTTP_STATUS_TITLES)
                .map(Number)
                .filter((code) => !known.has(code));

            expect(orphans).toEqual([]);
        });

        it("never returns an empty or duplicated-looking title", function () {
            for (const [code, title] of Object.entries(HTTP_STATUS_TITLES)) {
                expect(typeof title).toBe("string");
                expect(title.trim().length).toBeGreaterThan(0);
                expect(getStatusTitle(Number(code))).toBe(title);
            }
        });

        it("falls back by category for unmapped codes", function () {
            expect(getStatusTitle(451)).toBe("Client Error");
            expect(getStatusTitle(599)).toBe("Server Error");
            expect(getStatusTitle(302)).toBe("Redirect");
            expect(getStatusTitle(0)).toBe("Error");
        });
    });

    describe("Oracle / driver classifiers", function () {
        it("maps every ORA_MAP status into the catalogue", function () {
            const known = new Set(Object.values(HTTP_STATUS));
            const unknown = [
                ...new Set(Object.values(ORA_MAP).map((e) => e.status)),
            ].filter((code) => !known.has(code));

            expect(unknown).toEqual([]);
        });

        it("maps every NJS_MAP status into the catalogue", function () {
            const known = new Set(Object.values(HTTP_STATUS));
            const unknown = [
                ...new Set(Object.values(NJS_MAP).map((e) => e.status)),
            ].filter((code) => !known.has(code));

            expect(unknown).toEqual([]);
        });

        it("maps every transient-string-pattern status into the catalogue", function () {
            const known = new Set(Object.values(HTTP_STATUS));
            const unknown = TRANSIENT_STRING_PATTERNS.map((p) => p.status).filter(
                (code) => !known.has(code),
            );

            expect(unknown).toEqual([]);
        });

        it("labels driver-level failures with an outage type the frontend can key on", function () {
            // The frontend takes the page over for DatabaseError /
            // DatabaseUnavailableError / DatabaseTimeoutError and ONLY those
            // (Frontend/src/constants/httpStatus.js OUTAGE_ERROR_TYPES).
            // Renaming one here silently disables the outage screen.
            expect(TRANSIENT_STRING_PATTERNS.map((p) => p.type)).toContain(
                "DatabaseTimeoutError",
            );
        });

        it("never maps an ORA code to 502 — the frontend's outage rule depends on it", function () {
            // The frontend treats a 502/503/504 carrying `DatabaseError` as an
            // outage and takes the whole page over. That is only safe because
            // every ORA code at those statuses is a connectivity failure (no
            // listener, instance down, connection lost, host unreachable) and
            // NO ORA code maps to 502 — 502 is reserved for service-level
            // failures (e.g. an upstream mail/notification transport) that must
            // stay inline so the originating flow can recover in place.
            // Adding an ORA→502 mapping here would silently start taking the
            // page over for a recoverable in-flow error.
            const oraStatuses = new Set(
                Object.values(ORA_MAP).map((e) => e.status),
            );
            expect(oraStatuses.has(502)).toBe(false);
        });

        it("maps every ORA 503/504 to a connectivity or availability failure", function () {
            // The same rule from the other direction: if a future ORA mapping
            // parks a business error on 503, the frontend will take the page
            // over for it. Every current entry names an unreachable or
            // unavailable database.
            const AVAILABILITY = /session|process|starting up|shutting down|not available|restricted mode|out of space|shared memory|shared pool|connection|not connected|resolve|connect|listener|unreachable|hostname|protocol adapter|timed out|timeout/i;

            const offenders = Object.entries(ORA_MAP)
                .filter(([, e]) => e.status === 503 || e.status === 504)
                .filter(([, e]) => !AVAILABILITY.test(e.msg))
                .map(([code, e]) => `ORA-${code}: ${e.msg}`);

            expect(offenders).toEqual([]);
        });
    });

    describe("repo-wide emission scan", function () {
        it("finds AppError call sites to scan (guards against a silently broken scanner)", function () {
            expect(SCAN.files.length).toBeGreaterThan(50);
            expect(SCAN.emitted.length).toBeGreaterThan(100);
        });

        it("emits no status outside the catalogue", function () {
            const known = new Set(Object.values(HTTP_STATUS));
            const offenders = SCAN.emitted
                .filter((e) => !known.has(e.code))
                .map((e) => `${e.where} → ${e.code}`);

            expect(offenders).toEqual([]);
        });

        it("gives every emitted 4xx/5xx a title", function () {
            const offenders = SCAN.emitted
                .filter((e) => typeof e.code === "number" && e.code >= 400)
                .filter((e) => !HTTP_STATUS_TITLES[e.code])
                .map((e) => `${e.where} → ${e.code}`);

            expect(offenders).toEqual([]);
        });

        it("resolves every runtime-computed status site to a catalogued code", function () {
            // One known dynamic site exists (AuthMiddleware's JWT branch, which
            // picks a status from a local table of HTTP_STATUS values). This
            // test pins the count so a second, unreviewed dynamic site cannot
            // appear unnoticed. If a feature legitimately adds one, raise this
            // bound in the same commit that adds it.
            expect(SCAN.dynamic.length).toBeLessThanOrEqual(1);
        });
    });

    describe("envelope builders", function () {
        it("stamps the catalogue title onto every error envelope", function () {
            for (const code of Object.keys(HTTP_STATUS_TITLES).map(Number)) {
                const body = sendError("boom", code);
                expect(body.status).toBe("error");
                expect(body.code).toBe(code);
                expect(body.title).toBe(HTTP_STATUS_TITLES[code]);
                expect(body.error.type).toBe("AppError");
            }
        });

        it("never leaks a stack in production", function () {
            const prev = process.env.NODE_ENV;
            process.env.NODE_ENV = "production";
            try {
                const body = sendError("boom", 500, { stack: "SECRET TRACE" });
                expect(body.error.stack).toBeUndefined();
                expect(JSON.stringify(body)).not.toContain("SECRET TRACE");
            } finally {
                process.env.NODE_ENV = prev;
            }
        });

        it("keeps success envelopes title-free", function () {
            const body = sendSuccess("ok", { a: 1 }, HTTP_STATUS.CREATED);
            expect(body.title).toBeUndefined();
            expect(body.code).toBe(201);
        });
    });
});
