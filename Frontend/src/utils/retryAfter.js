/**
 * retryAfter.js — Parse the HTTP `Retry-After` header into seconds.
 *
 * RFC 9110 allows two shapes: delta-seconds (`"120"`) or an HTTP-date
 * (`"Wed, 21 Oct 2026 07:28:00 GMT"`). The API only sends integers today, but
 * a proxy in front of it may rewrite either form.
 */

import { SERVER_SHUTTING_DOWN_TYPE } from "../constants/httpStatus";
import { sanitizeReturnTo } from "./returnTo";

/**
 * @param {string|number|null|undefined} raw Raw header value.
 * @param {number} [now=Date.now()] Clock injection point for tests.
 * @returns {number|null} Seconds to wait (>= 0, may be fractional for dates), or null when unusable.
 */
export function parseRetryAfterSeconds(raw, now = Date.now()) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? raw : null;

    const text = String(raw).trim();
    if (text === "") return null;

    if (/^\d+(\.\d+)?$/.test(text)) return Number(text);

    const at = Date.parse(text);
    if (Number.isNaN(at)) return null;
    return Math.max(0, (at - now) / 1000);
}

// ─── Load-shed retry (shared by HttpClient and CsrfMiddleware) ───────────────
// A 429 whose envelope says `PoolOverloadedError` is the API's deliberate,
// momentary DB-pool load-shed (Retry-After: 1). `RateLimitExceeded` is a
// different 429 and is never retried by either caller.

/** Envelope `error.type` of the load-shed 429. */
export const POOL_OVERLOADED_TYPE = "PoolOverloadedError";
/** `error.type` values whose response HttpClient transparently re-sends (idempotent requests only). */
export const SHED_RETRYABLE_TYPES = new Set([POOL_OVERLOADED_TYPE, SERVER_SHUTTING_DOWN_TYPE]);

/**
 * True for the two momentary, retry-safe answers: 429 PoolOverloadedError and
 * 503 ServerShuttingDown. A type on the wrong status is not retryable.
 *
 * @param {number|null|undefined} status HTTP status.
 * @param {string|null|undefined} type Envelope `error.type`.
 * @returns {boolean}
 */
export function isShedRetryable(status, type) {
    if (!SHED_RETRYABLE_TYPES.has(type)) return false;
    return (status === 429 && type === POOL_OVERLOADED_TYPE) || (status === 503 && type === SERVER_SHUTTING_DOWN_TYPE);
}
/** Max transparent re-sends of one request. */
export const SHED_RETRY_MAX = 2;
const SHED_RETRY_MIN_MS = 500;
const SHED_RETRY_MAX_MS = 5_000;
const SHED_RETRY_DEFAULT_MS = 1_000;
const SHED_RETRY_JITTER_MS = 250;

/**
 * Wait before re-sending a shed request: `Retry-After` clamped to
 * [0.5 s, 5 s] plus up to 250 ms jitter. Missing/unparseable header → 1 s.
 *
 * @param {string|number|null|undefined} header Raw Retry-After value.
 * @returns {number} Milliseconds.
 */
export function shedRetryDelayMs(header) {
    const secs = parseRetryAfterSeconds(header);
    const base = secs === null ? SHED_RETRY_DEFAULT_MS : secs * 1000;
    return Math.min(SHED_RETRY_MAX_MS, Math.max(SHED_RETRY_MIN_MS, base)) + Math.random() * SHED_RETRY_JITTER_MS;
}

const PROBE_BACKOFF_CAP_MS = 15_000;
/**
 * Longest a server-supplied Retry-After may park the readiness probe loop. The header is a floor, but a
 * buggy or hostile value (`Retry-After: 3000000000`) must not silence recovery checks for days (S2).
 */
export const PROBE_RETRY_AFTER_CAP_MS = 60_000;

/**
 * Full-jitter exponential backoff for the server-status readiness probe:
 * `max(min(retryAfterMs, 60 s), random() * min(15 s, 2^attempt * 1 s))`. The server's own
 * Retry-After is a floor, never exceeded downward, but capped at `PROBE_RETRY_AFTER_CAP_MS`.
 *
 * @param {number} attempt Zero-based attempt number.
 * @param {number} [retryAfterMs=0] Server-requested minimum wait.
 * @param {() => number} [random=Math.random] Injectable RNG in [0,1).
 * @returns {number} Milliseconds.
 */
export function probeBackoffMs(attempt, retryAfterMs = 0, random = Math.random) {
    const ceiling = Math.min(PROBE_BACKOFF_CAP_MS, 2 ** attempt * 1000);
    return Math.max(Math.min(Math.max(0, retryAfterMs), PROBE_RETRY_AFTER_CAP_MS), random() * ceiling);
}

/**
 * Sleep `ms`, rejecting with `makeAbortError()` if `signal` aborts first (or
 * already has). The timer and listener are always cleaned up.
 *
 * @param {number} ms
 * @param {AbortSignal|undefined} signal
 * @param {() => Error} makeAbortError Builds the rejection (caller picks its error type).
 * @returns {Promise<void>}
 */
export function sleepUnlessAborted(ms, signal, makeAbortError) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(makeAbortError());
        const onAbort = () => {
            clearTimeout(timer);
            reject(makeAbortError());
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener?.("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener?.("abort", onAbort, { once: true });
    });
}

/**
 * The server's own wait for a 429: the body's `retryAfter` detail first (raw,
 * the limiter sends e.g. "252 seconds"), then the `Retry-After` header
 * converted to seconds. Null when neither is usable.
 *
 * @param {object|undefined} body Parsed error envelope.
 * @param {string|number|null|undefined} headerValue Raw Retry-After header.
 * @returns {string|number|null}
 */
export function extractRetryAfter(body, headerValue) {
    const details = body?.error?.details ?? [];
    const fromBody = Array.isArray(details) ? details.find((d) => d?.field === "retryAfter")?.issue : undefined;
    return fromBody ?? parseRetryAfterSeconds(headerValue) ?? null;
}

/**
 * Error-page payload for a 429 that failed the boot-time CSRF init (the
 * `errorDetail` CsrfContext exposes). Same shape HttpClient stashes, so the
 * countdown page reads the real wait instead of its default.
 *
 * @param {{ data?: object|null, headers?: object, requestId?: string|null }} errorDetail
 * @param {string|null} [returnTo] Path + search the user was on; dropped unless `sanitizeReturnTo`
 *   accepts it, so the countdown's "Try again" can never point back at an error page.
 * @returns {{ code: 429, title: string|null, message: string|null, requestId: string|null, retryAfter: string|number|null, returnTo: string|null }}
 */
export function buildThrottlePayload(errorDetail, returnTo = null) {
    return {
        code: 429,
        title: errorDetail?.data?.title ?? null,
        message: errorDetail?.data?.message ?? null,
        requestId: errorDetail?.requestId ?? null,
        retryAfter: extractRetryAfter(errorDetail?.data, errorDetail?.headers?.["retry-after"]),
        returnTo: sanitizeReturnTo(returnTo),
    };
}
