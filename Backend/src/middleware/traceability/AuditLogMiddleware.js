"use strict";

const AuditLogService = require("../../services/AuditLogService");
const { resolveRouteLabel } = require("../../utils/routeLabel");
const os = require("os");

// Sensitive query-param fragments (CWE-200 / CWE-532 — sensitive data
// persisted to the audit-log PARAMS column, which renders in the FE Trace
// modal AND a truncated table preview).
//
// TWO-TIER matching, not one flat substring list. Pure substring matching is
// right for fragments with no plausible innocent containment, but wrong for
// short/common ones — it over-redacts as the app grows, and an over-redacted
// audit row is a silent loss of forensic data nobody notices until they need
// it. Split accordingly:
//
// TIER 1 (SENSITIVE_PARAM_FRAGMENTS_SUBSTRING) — matched as a SUBSTRING
// against the normalised key (lowercased, non-alphanumerics stripped — see
// normalizeParamKey), so decorated AND unseparated variants all sail
// through the same as the bare form: refreshToken / refresh_token,
// csrfToken / csrf_token, apiSecret, id_token, clientSecret, privateKey,
// pwd, passwd, credential(s), bearer, xaccesstoken, myAPIKey — all
// normalise to a string containing one of these fragments. Safe as a
// substring because nothing in a typical key surface plausibly contains
// "password", "secret", "apikey", etc. by accident.
//
// TIER 2 (SENSITIVE_PARAM_FRAGMENTS_TOKEN) — matched only as a WHOLE TOKEN
// against the ORIGINAL key split on camelCase boundaries + separators (see
// tokenizeParamKey). These fragments are common enough as substrings of
// unrelated English words that pure substring matching would gratuitously
// blind the audit log:
//   auth    -> "author"/"authorName" contain "auth" but aren't credentials
//   session -> "possession" contains "session" (p-o-s-SESSION)
//   pin     -> "pinned"/"opinion" contain "pin" (o-PIN-ion)
//   otp     -> "footprint" contains "otp" (fo-OTP-rint)
//   mfa     -> no known live collision, tokenised anyway for consistency
//   salt    -> "basalt" contains "salt"
// Tokenising "authToken" -> ["auth", "token"] still matches (and "token"
// also catches it via Tier 1); "author" -> ["author"] does not; "pinCode"
// -> ["pin", "code"] matches; "pinned" -> ["pinned"] does not.
//
// "hash" is DELIBERATELY DROPPED entirely — not demoted to Tier 2.
// Tokenising cannot save it: "rowHash" -> ["row", "hash"] still matches a
// bare "hash" token, so a future ?rowHash= (an HMAC/row-hash tamper-evidence
// value) would be destroyed — deleting exactly the value an auditor
// investigating tampering would need intact. And keeping it earns nothing:
// every genuinely sensitive hash compound is already caught by its own
// prefix in Tier 1 (passwordHash -> "password", tokenHash -> "token",
// secretHash -> "secret"). A bare hash/rowHash key means an integrity
// checksum, not a credential — audit-relevant data, not a secret to redact.
//
// A sibling file (TraceabilityMiddleware.js) has an analogous
// SENSITIVE_PATTERNS/isSensitiveKey mechanism for request/response log lines.
// Deliberately NOT reused here as-is: that list also redacts PII (email,
// phone, dob, names) for a different surface (structured log messages);
// pulling it in wholesale would silently widen what gets redacted in the
// audit PARAMS column beyond what this scopes (credentials/secrets). This
// list is audit-PARAMS-specific.
//
// Deliberately DROPS bare "key" (an exact-match list would have it). As a
// substring, "key" would swallow unrelated legitimate params (sortKey,
// cacheKey, keyword) for no real gain: the two genuinely sensitive "key"
// compounds are already caught by "apikey" and "privatekey".
//
// Deliberately DROPS bare "sig" (kept "signature" as a whole word instead).
// A param like `eSign` normalises to "esign", which CONTAINS "sig" as a
// substring ("e-SIG-n"); a bare "sig" fragment would silently redact it —
// exactly the gratuitous-blinding failure mode this design guards against.
// "signature" (the full word) still catches "signature", "reqSignature",
// etc. where the key actually spells the whole word out.
const SENSITIVE_PARAM_FRAGMENTS_SUBSTRING = [
    "token",
    "password",
    "passwd",
    "pwd",
    "secret",
    "apikey",
    "credential",
    "privatekey",
    "bearer",
    "jwt",
    "signature",
    "authorization",
];

const SENSITIVE_PARAM_FRAGMENTS_TOKEN = ["auth", "session", "pin", "otp", "mfa", "salt"];

/**
 * Byte budget for the audit-log PARAMS column.
 *
 * The column is VARCHAR2(2000). On an AL32UTF8 database with
 * NLS_LENGTH_SEMANTICS = BYTE it holds 2000 BYTES, not 2000 characters. A JS
 * `.slice(2000)` of multi-byte text can be up to 8000 bytes and is rejected
 * with ORA-12899, so this column is budgeted in BYTES here instead.
 *
 * @constant {number}
 */
const PARAMS_MAX_BYTES = 2000;

/** Suffix appended when a value is truncated. ASCII — exactly 3 bytes. */
const TRUNCATION_SUFFIX = "...";

/**
 * Truncate a string so its UTF-8 encoding fits `maxBytes`, never splitting a
 * character in half.
 *
 * Why this is not `str.slice(n)`: JavaScript string indices are UTF-16 code
 * units, while Oracle counts UTF-8 bytes. One "character" costs 1 byte (ASCII),
 * 2 (n-tilde, e-acute), 3 (most CJK) or 4 (emoji, astral planes). A
 * 2000-character slice can therefore be up to 8000 bytes and is rejected with
 * ORA-12899.
 *
 * `Buffer.byteLength` measures; `Buffer.subarray().toString()` would happily
 * cut mid-sequence and emit U+FFFD, so the cut point is walked back to a
 * UTF-8 leading byte (`(b & 0xC0) !== 0x80` skips continuation bytes) before
 * decoding. Surrogate pairs survive because a 4-byte sequence has exactly one
 * leading byte and three continuation bytes.
 *
 * @param {string} str - Source text.
 * @param {number} maxBytes - Hard UTF-8 byte budget, suffix included.
 * @returns {string} `str` unchanged when it already fits, else a truncated
 *   copy ending in "..." whose UTF-8 length is <= `maxBytes`.
 */
function truncateUtf8Bytes(str, maxBytes) {
    const buf = Buffer.from(str, "utf8");
    if (buf.length <= maxBytes) return str;

    // Reserve room for the suffix, then walk back off any continuation byte
    // so the buffer never ends mid-character.
    let end = maxBytes - Buffer.byteLength(TRUNCATION_SUFFIX, "utf8");
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;

    return buf.subarray(0, end).toString("utf8") + TRUNCATION_SUFFIX;
}

/**
 * Normalise a query-param key for Tier 1 substring matching: lowercase,
 * then strip every non-alphanumeric character. Collapses access_token,
 * access-token, accessToken, and ACCESS_TOKEN to the same "accesstoken"
 * comparison string so decoration (camelCase/snake_case/kebab-case/casing)
 * can never be used to dodge the filter.
 *
 * @param {string} key - Raw query-param key.
 * @returns {string} Normalised comparison key.
 */
function normalizeParamKey(key) {
    return String(key)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
}

/**
 * Split a raw query-param key into lowercase tokens for Tier 2 whole-token
 * matching: on camelCase boundaries (lower/digit -> Upper, and an acronym
 * run -> Titlecase, e.g. "HTTPServer" -> "HTTP Server") and on any
 * non-alphanumeric separator (_, -, space, etc). Unlike normalizeParamKey,
 * this preserves word boundaries instead of erasing them — that's the whole
 * point: Tier 2 fragments need an EXACT token match, not a substring.
 *
 * Examples:
 *   "authToken"   -> ["auth", "token"]
 *   "authorName"  -> ["author", "name"]   (no "auth" token — "author" stays intact)
 *   "eSign"       -> ["e", "sign"]
 *   "session_id"  -> ["session", "id"]
 *   "rowHash"     -> ["row", "hash"]
 *
 * @param {string} key - Raw query-param key.
 * @returns {string[]} Lowercased tokens.
 */
function tokenizeParamKey(key) {
    return String(key)
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .replace(/[^a-zA-Z0-9]+/g, " ")
        .trim()
        .split(" ")
        .filter(Boolean)
        .map((t) => t.toLowerCase());
}

/**
 * @param {string} key - Raw query-param key.
 * @returns {boolean} True if the normalised key contains any Tier 1
 * substring fragment, OR the tokenised key exactly matches any Tier 2
 * fragment.
 */
function isSensitiveParamKey(key) {
    const norm = normalizeParamKey(key);
    if (SENSITIVE_PARAM_FRAGMENTS_SUBSTRING.some((fragment) => norm.includes(fragment)))
        return true;

    const tokens = tokenizeParamKey(key);
    return SENSITIVE_PARAM_FRAGMENTS_TOKEN.some((fragment) => tokens.includes(fragment));
}

// Resolve server IP once at startup
const _serverIp = (() => {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
            if (iface.family === "IPv4" && !iface.internal)
                return iface.address;
        }
    }
    return "127.0.0.1";
})();

class AuditLogMiddleware {
    constructor(options = {}) {
        this._enabled =
            options.enabled ?? process.env.AUDIT_LOG_ENABLED !== "false";
        this._excludeHealth =
            options.excludeHealth ??
            process.env.AUDIT_LOG_EXCLUDE_HEALTH !== "false";
        this._excludedPaths =
            options.excludedPaths ??
            (process.env.AUDIT_LOG_EXCLUDE_PATHS
                ? process.env.AUDIT_LOG_EXCLUDE_PATHS.split(",").map((p) =>
                      p.trim(),
                  )
                : ["/api/v1/audit-logs"]);
        this.handle = this.handle.bind(this);
    }

    handle(req, res, next) {
        if (!this._enabled) return next();
        if (this._excludeHealth && req.path === "/health") return next();
        if (this._excludedPaths.some((p) => req.path.startsWith(p)))
            return next();

        // OPTIONS (CORS preflight) requests are browser plumbing, not business
        // traffic. They are answered before routing, so req.route is never set
        // and the endpoint resolves to "UNMATCHED" — polluting the audit log
        // with imprecise rows. RED metrics already exclude them via
        // shouldRecordRouteMetrics(); audit logs must do the same.
        if (req.method === "OPTIONS") return next();

        const startTime = Date.now();
        const originalEnd = res.end.bind(res);

        res.end = (...args) => {
            const result = originalEnd(...args);
            const duration = Date.now() - startTime;
            const record = AuditLogMiddleware._buildRecord(req, res, duration);
            setImmediate(() => AuditLogService.insertAsync(record));
            return result;
        };

        next();
    }

    static _buildRecord(req, res, duration) {
        const statusCode = res.statusCode || 200;
        const statusCategory = Math.floor(statusCode / 100) + "xx";

        // Use the same canonical route label that RED metrics use (resolveRouteLabel)
        // so the ENDPOINT column stores parameterized patterns like
        // "/api/v1/records/:gid/:cardNumber/history" instead of concrete
        // paths with raw param values. This:
        //   1. Keeps audit log endpoints consistent with the RED Metrics table
        //   2. Prevents PII/ID leakage into the audit table (CWE-200)
        //   3. Makes endpoint-based grouping and search meaningful
        // The label format is "METHOD /path" — strip the method prefix since METHOD
        // is already stored in its own column.
        const routeLabel = resolveRouteLabel(req);
        const spaceIdx = routeLabel.indexOf(" ");
        const endpoint =
            spaceIdx !== -1 ? routeLabel.slice(spaceIdx + 1) : req.path;

        // USER_ID is a NUMBER column, but JWT claims are not guaranteed numeric
        // (a `userId` claim is commonly a string). insertMany batches type each
        // column from the FIRST non-null sample — mixed number/string values in
        // one flush batch trip NJS-011 and lose the whole batch. Normalize to a
        // numeric value or null before the record ever reaches the buffer.
        const rawUserId =
            req.user?.id ?? req.user?.GID ?? req.user?.userId ?? null;
        const userId =
            rawUserId != null && /^\d+$/.test(String(rawUserId).trim())
                ? Number(String(rawUserId).trim())
                : null;

        return {
            REQUEST_ID: req.id ?? null,
            USER_ID: userId,
            USERNAME: req.user?.username ?? req.user?.firstName ?? null,
            METHOD: req.method,
            ENDPOINT: endpoint,
            PARAMS: AuditLogMiddleware._sanitizeParams(req.query),
            STATUS_CODE: statusCode,
            STATUS_CATEGORY: statusCategory,
            RESPONSE_TIME_MS: duration,
            CLIENT_IP: req.ip ?? null,
            SERVER_IP: _serverIp,
            CREATED_AT: new Date(),
        };
    }

    /**
     * Redacts (never drops) sensitive query-param values before they are
     * persisted to the audit-log PARAMS column.
     *
     * Redaction over omission: dropping sensitive keys entirely means an
     * auditor reading a row cannot tell whether a sensitive param was even
     * present. Replacing the VALUE with "[REDACTED]" preserves the shape of
     * what was actually requested without leaking the secret.
     *
     * One observable behavior change from the redaction switch: previously,
     * a query where EVERY param was sensitive collapsed to `null` (nothing
     * "survived" the filter). Under redaction nothing is dropped anymore —
     * every key survives, sensitive ones just carry "[REDACTED]" — so that
     * case now returns a fully-redacted-but-present JSON object instead of
     * null. `null` is still returned for the two cases where there is truly
     * nothing to report: non-object/falsy input, and a query object with
     * zero keys.
     *
     * @param {object|null} query - req.query.
     * @returns {string|null} JSON string (redacted, ≤2000 BYTES) or null.
     */
    static _sanitizeParams(query) {
        if (!query || typeof query !== "object") return null;
        const keys = Object.keys(query);
        if (keys.length === 0) return null;

        const filtered = {};
        for (const [k, v] of Object.entries(query)) {
            filtered[k] = AuditLogMiddleware._isSensitiveParamKey(k)
                ? "[REDACTED]"
                : v;
        }
        return truncateUtf8Bytes(JSON.stringify(filtered), PARAMS_MAX_BYTES);
    }

    /**
     * @param {string} key - Raw query-param key.
     * @returns {boolean} True if the key should be redacted.
     * @see isSensitiveParamKey
     */
    static _isSensitiveParamKey(key) {
        return isSensitiveParamKey(key);
    }
}

const defaultAuditLog = new AuditLogMiddleware();
module.exports = { AuditLogMiddleware, defaultAuditLog };
