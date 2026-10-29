/**
 * returnTo.js — Pure validator for the "where was the user" hint carried across a takeover.
 *
 * WHAT THIS FILE DOES
 *   `HttpClient` stashes `location.pathname + location.search` when it hard-navigates to the 523
 *   page; the page offers "Continue where you left off" once the service is back. The stash lives
 *   in sessionStorage, so it is attacker-influenceable input (same-origin script, a crafted deep
 *   link that sets the path, a stale entry). Nothing may navigate to it without passing through
 *   `sanitizeReturnTo`.
 *
 * ACCEPTS only: a string <= 2048 chars that starts with exactly ONE slash, has no backslash or control
 *   character, resolves (dot segments, percent-decoding, case) to a same-origin path that is NOT an error
 *   page, `/auth*` or logout. Everything else -> null (the caller falls back to "/").
 *
 * SECURITY: CWE-601 (open redirect: `//host`, `/\host`, absolute URLs, `javascript:`), CWE-20
 *   (control characters, length), CWE-74 (no interpolation anywhere). Complexity: O(n) in length.
 */

import { ERROR_PAGE_ROUTES } from "../constants/httpStatus";

/** Longest accepted value (characters). */
export const RETURN_TO_MAX_LENGTH = 2048;

const PROBE_ORIGIN = "http://return-to.invalid";
// Routes a "continue" must never land on: every bare error page, the sign-in flow and logout.
const BLOCKED_PREFIXES = Object.freeze([...Object.values(ERROR_PAGE_ROUTES), "/auth", "/user/logout"].map((r) => r.toLowerCase()));

/**
 * @param {unknown} value Raw stashed value.
 * @returns {string|null} The same string when safe, else null.
 */
export function sanitizeReturnTo(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > RETURN_TO_MAX_LENGTH) return null;
    if (!/^\/(?!\/)/.test(value)) return null; // exactly one leading slash (CWE-601)
    // eslint-disable-next-line no-control-regex
    if (/[\\\u0000-\u001f\u007f]/.test(value)) return null; // backslash host tricks + control characters

    let pathname;
    try {
        const url = new URL(value, PROBE_ORIGIN);
        if (url.origin !== PROBE_ORIGIN) return null;
        pathname = decodeURIComponent(url.pathname).toLowerCase();
    } catch {
        return null; // malformed escape sequence
    }
    const blocked = BLOCKED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`) || (p === "/auth" && pathname.startsWith("/auth")));
    return blocked ? null : value;
}

/**
 * The PATH of a returnTo value, without query string or fragment — the only part ever shown on screen
 * (queries may carry ids or tokens; CWE-200/CWE-598). Navigation still uses the full validated value.
 *
 * @param {unknown} value Raw or validated returnTo.
 * @returns {string|null} Pathname, or null when `value` does not pass `sanitizeReturnTo`.
 */
export function returnToPathname(value) {
    const safe = sanitizeReturnTo(value);
    if (safe === null) return null;
    try {
        return new URL(safe, PROBE_ORIGIN).pathname;
    } catch {
        return null;
    }
}

export default sanitizeReturnTo;
