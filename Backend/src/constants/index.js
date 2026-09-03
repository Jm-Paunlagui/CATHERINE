"use strict";

/**
 * @fileoverview App-wide constants
 * @description HTTP status codes, app metadata, and re-exports of errors/responses.
 */

/**
 * Every HTTP status this API is allowed to emit.
 *
 * This object is the single source of truth for status codes on the backend.
 * `constants/responses/index.js` carries a human title for each key here, and
 * the frontend mirrors both in `Frontend/src/constants/httpStatus.js`. Adding a
 * code means adding it in all three places — the contract test
 * (`test/unit/constants/httpStatusContract.test.js`) fails otherwise.
 *
 * Codes marked "reserved" are not thrown anywhere in `src/` today but are part
 * of the published contract because the frontend renders a dedicated page for
 * them (498, 523) or an upstream proxy/edge can inject them (410, 523).
 */
const HTTP_STATUS = {
    // ── 2xx Success ──
    OK: 200,
    CREATED: 201,
    ACCEPTED: 202,
    NO_CONTENT: 204,
    MULTI_STATUS: 207,

    // ── 4xx Client errors ──
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    METHOD_NOT_ALLOWED: 405,
    REQUEST_TIMEOUT: 408, // query cancelled at the driver (e.g. ORA-01013)
    CONFLICT: 409,
    GONE: 410, // reserved — proxy/CDN only
    PAYLOAD_TOO_LARGE: 413, // emitted by the error handler (body/file size)
    UNPROCESSABLE: 422,
    LOCKED: 423,
    PRECONDITION_REQUIRED: 428,
    TOO_MANY_REQUESTS: 429,
    SESSION_TIMEOUT: 440, // non-standard (IIS) — expired but well-formed JWT
    INVALID_TOKEN: 498, // reserved — non-standard, tampered/malformed token

    // ── 5xx Server errors ──
    INTERNAL_SERVER_ERROR: 500,
    BAD_GATEWAY: 502,
    SERVICE_UNAVAILABLE: 503,
    GATEWAY_TIMEOUT: 504, // driver connection timeout
    INSUFFICIENT_STORAGE: 507, // storage/tablespace full
    ORIGIN_UNREACHABLE: 523, // reserved — Cloudflare-style edge failure
};

module.exports = {
    HTTP_STATUS,
    ...require("./errors"),
    ...require("./responses"),
    ...require("./resetTypes"),
};
