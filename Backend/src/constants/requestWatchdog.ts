"use strict";

/**
 * @fileoverview Idle-limit configuration for the request watchdog.
 *
 * WHAT THIS FILE DOES
 *   Defines how long a request may make NO progress (no DB call finished, no
 *   socket byte moved, no SMTP step, no explicit `touch()`) before the
 *   watchdog cuts it with a 504 `RequestStalledError`, per route class:
 *     - "default": ordinary requests         (env REQUEST_IDLE_TIMEOUT_MS)
 *     - "long":    bulk / export / upload     (env REQUEST_IDLE_TIMEOUT_LONG_MS)
 *     - "exempt":  SSE streams, never cut
 *
 * WHY THE FLOOR IS 65 s
 *   A safety floor, not a derived bound: an idle window shorter than about a
 *   minute would cut healthy requests between slow-but-legal progress events
 *   (the sweep runs every 5 s, SMTP/network steps can take tens of seconds).
 *   `POOL_DEFAULTS.callTimeout` is NOT a per-call cap here: node-oracledb 6.x
 *   ignores `callTimeout` at pool level (it is a connection property only), so
 *   single DB calls are unbounded by the driver. Instead a DB call IN FLIGHT
 *   counts as progress for its watched scope, up to `DB_CALL_PROGRESS_CAP_MS`
 *   (default 30 min); past that the call is treated as hung and the request is
 *   cut + `conn.break()`-ed.
 *
 * Pure functions only — no state, no I/O.
 */

/** Idle windows are never below this (safety floor; see file header). */
const IDLE_FLOOR_MS = 65_000;

const DEFAULT_IDLE_MS = 120_000;
const DEFAULT_IDLE_MAX_MS = 600_000;
const LONG_IDLE_MS = 600_000;
const LONG_IDLE_MAX_MS = 1_800_000;

/** In-flight DB call progress ceiling: default and clamp range. */
const DB_CALL_CAP_DEFAULT_MS = 1_800_000;
const DB_CALL_CAP_MIN_MS = 65_000;
const DB_CALL_CAP_MAX_MS = 3_600_000;

/** Idle limit meaning "never cut". */
const EXEMPT = Infinity;

/** Path prefix stripped before rule matching. */
const API_PREFIX = "/api/v1";

/**
 * Requests that legitimately go quiet for longer than the default window
 * (bulk writes, large exports, backup / restore, per-row e-mail loops).
 * `path` is matched WITHOUT the `/api/v1` prefix and WITHOUT the query string.
 * Projects add their own bulk/export routes here.
 * @type {ReadonlyArray<{ method: string|null, path: RegExp }>}
 */
const LONG_RULES = Object.freeze([
    {
        method: "POST",
        path: /^\/data-purge\/(backup|execute|restore|restore\/preview|backups\/run)$/,
    },
    { method: "GET", path: /^\/data-purge\/backups\/[^/]+\/download$/ },
    { method: "POST", path: /^\/data-purge\/backups\/[^/]+\/verify$/ },
    {
        method: "POST",
        path: /^\/admin-management\/[^/]+(\/revoke-backup|\/revoke)?$/,
    },
    {
        method: "DELETE",
        path: /^\/admin-management\/[^/]+(\/revoke-backup|\/revoke)?$/,
    },
    // Real export routes only (enumerated from src/routes; paths are
    // lower-cased with the trailing slash stripped by normalizePath). A bare
    // segment named "export" elsewhere (e.g. a param value) is NOT long.
    { method: "GET", path: /^\/audit-logs\/export\/(excel|logs)$/ },
    { method: "GET", path: /^\/audit-logs\/[^/]+\/export\/trace$/ },
    { method: "GET", path: /^\/integrity\/[^/]+\/export$/ },
]);

/**
 * SSE surfaces. The sweep also exempts any response whose Content-Type is
 * `text/event-stream`.
 * @type {ReadonlyArray<{ method: string|null, path: RegExp }>}
 */
const EXEMPT_RULES = Object.freeze([
    { method: "GET", path: /^\/health\/stream$/ },
    { method: "GET", path: /^\/audit-logs\/stream$/ },
    { method: "GET", path: /^\/audit-logs\/system-logs\/stream$/ },
    { method: "GET", path: /^\/integrity\/stream$/ },
]);

/**
 * Parse an env value into a clamped integer.
 * @param {string|undefined} raw
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {{ value: number, clamped: boolean, invalid: boolean }}
 */
function _clamp(raw, fallback, min, max) {
    if (raw === undefined || raw === null || raw === "") {
        return { value: fallback, clamped: false, invalid: false };
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
        return { value: fallback, clamped: false, invalid: true };
    }
    const v = Math.min(max, Math.max(min, Math.trunc(n)));
    return { value: v, clamped: v !== Math.trunc(n), invalid: false };
}

/**
 * Resolve the two idle windows from the environment.
 * Never throws; out-of-range values are clamped and reported in `warnings`.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {{ defaultMs: number, longMs: number, warnings: Array<{ name: string, raw: string, applied: number }> }}
 */
function resolveIdleLimits(env = process.env) {
    const warnings = [];
    const specs = [
        ["REQUEST_IDLE_TIMEOUT_MS", DEFAULT_IDLE_MS, DEFAULT_IDLE_MAX_MS],
        ["REQUEST_IDLE_TIMEOUT_LONG_MS", LONG_IDLE_MS, LONG_IDLE_MAX_MS],
    ];
    const out = specs.map(([name, fallback, max]) => {
        const r = _clamp(env[name], fallback, IDLE_FLOOR_MS, max);
        if (r.clamped || r.invalid) {
            warnings.push({ name, raw: String(env[name]), applied: r.value });
        }
        return r.value;
    });
    return { defaultMs: out[0], longMs: out[1], warnings };
}

/**
 * Resolve the in-flight DB call progress cap from the environment.
 * Never throws; out-of-range values are clamped and reported in `warnings`.
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {{ capMs: number, warnings: Array<{ name: string, raw: string, applied: number }> }}
 */
function resolveDbCallProgressCap(env = process.env) {
    const name = "DB_CALL_PROGRESS_CAP_MS";
    const r = _clamp(
        env[name],
        DB_CALL_CAP_DEFAULT_MS,
        DB_CALL_CAP_MIN_MS,
        DB_CALL_CAP_MAX_MS,
    );
    const warnings =
        r.clamped || r.invalid
            ? [{ name, raw: String(env[name]), applied: r.value }]
            : [];
    return { capMs: r.value, warnings };
}

/**
 * Normalise a raw request URL to the path used by the rule tables: query
 * string and `/api/v1` prefix removed, lower-cased and trailing slash
 * stripped (Express routing is case- and trailing-slash-insensitive).
 * @param {string} url
 * @returns {string}
 */
function normalizePath(url) {
    let p = String(url || "/").split("?")[0].toLowerCase();
    if (p.startsWith(API_PREFIX)) p = p.slice(API_PREFIX.length) || "/";
    if (p.length > 1 && p.endsWith("/")) p = p.replace(/\/+$/, "") || "/";
    return p;
}

function _matches(rules, method, path) {
    return rules.some(
        (r) => (r.method === null || r.method === method) && r.path.test(path),
    );
}

/**
 * Classify a request into an idle-limit class. Exempt wins over long.
 *
 * @param {string} method - HTTP verb.
 * @param {string} url - Raw request URL (query allowed, prefix allowed).
 * @returns {"default"|"long"|"exempt"}
 */
function classifyRoute(method, url) {
    const m = String(method || "GET").toUpperCase();
    const path = normalizePath(url);
    if (_matches(EXEMPT_RULES, m, path)) return "exempt";
    if (_matches(LONG_RULES, m, path)) return "long";
    return "default";
}

module.exports = {
    IDLE_FLOOR_MS,
    DEFAULT_IDLE_MS,
    LONG_IDLE_MS,
    EXEMPT,
    LONG_RULES,
    EXEMPT_RULES,
    DB_CALL_CAP_DEFAULT_MS,
    resolveIdleLimits,
    resolveDbCallProgressCap,
    classifyRoute,
    normalizePath,
};
