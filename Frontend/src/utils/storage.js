/**
 * storage.js — localStorage + sessionStorage wrappers.
 * SSR-safe, JSON-serialised, never throws.
 */

function safe(fn) {
    try {
        return fn();
    } catch {
        return null;
    }
}

const local = {
    get: (k) =>
        typeof window !== "undefined"
            ? safe(() => {
                  const r = localStorage.getItem(k);
                  return r ? JSON.parse(r) : null;
              })
            : null,
    set: (k, v) => {
        if (typeof window !== "undefined") safe(() => localStorage.setItem(k, JSON.stringify(v)));
    },
    remove: (k) => {
        if (typeof window !== "undefined") safe(() => localStorage.removeItem(k));
    },
    clear: () => {
        if (typeof window !== "undefined") safe(() => localStorage.clear());
    },
};

const session = {
    get: (k) =>
        typeof window !== "undefined"
            ? safe(() => {
                  const r = sessionStorage.getItem(k);
                  return r ? JSON.parse(r) : null;
              })
            : null,
    set: (k, v) => {
        if (typeof window !== "undefined") safe(() => sessionStorage.setItem(k, JSON.stringify(v)));
    },
    remove: (k) => {
        if (typeof window !== "undefined") safe(() => sessionStorage.removeItem(k));
    },
    clear: () => {
        if (typeof window !== "undefined") safe(() => sessionStorage.clear());
    },
};

export const storage = { ...local, session };
export default storage;

/**
 * sessionStorage key carrying the payload behind ANY full-page error screen
 * across `HttpClient`'s hard navigation.
 *
 * `window.location.replace` is a full document load, so React Router state does
 * not survive it — without this hand-off an error screen cannot show the
 * server's own title, message, Request ID or countdown, and falls back to
 * generic hardcoded copy. That fallback is exactly why the 440/498/523 screens
 * used to render the same sentence whatever the server actually said.
 *
 * ⚠ It lives HERE, not in `HttpClient`, on purpose. `HttpClient` instantiates a
 * singleton at module scope (`new HttpClient()`), so importing it from an error
 * view would pull axios and that side effect into the error-page bundle — the
 * one bundle that must stay loadable when the API is unreachable.
 */
export const ERROR_PAGE_PAYLOAD_KEY = "app.errorPage.payload";

/**
 * @typedef {object} ErrorPagePayload
 * @property {number|null}        code       HTTP status the page is rendering for.
 * @property {string|null}        title      Server's `title` from the error envelope.
 * @property {string|null}        message    Server's `message` from the error envelope.
 * @property {string|null}        requestId  Correlation id, rendered click-to-copy.
 * @property {string|number|null} [retryAfter] 429 only — seconds to wait.
 * @property {string|null}        [returnTo]   Path + search the user was on at takeover time. A HINT only:
 *                                              always run through `sanitizeReturnTo` before use (CWE-601).
 */

/**
 * Stores the payload behind a full-page error for the error screen to pick up.
 * Never throws: a private-mode browser losing the message must not escalate
 * into losing the error page too.
 *
 * @param {ErrorPagePayload} payload
 * @returns {void}
 */
export function stashErrorPagePayload(payload) {
    session.set(ERROR_PAGE_PAYLOAD_KEY, payload);
}

/**
 * Reads and CLEARS the stored error payload, then memoises the result for the
 * rest of this document's lifetime.
 *
 * Two properties, both load-bearing:
 *
 *   • READ-ONCE against storage — a stale payload must never leak into a later,
 *     unrelated failure. A user who hits a 429, waits it out, then hits a
 *     different one an hour later sees the NEW countdown, not the old one.
 *
 *   • MEMOISED per document — an error screen has more than one reader
 *     (`useErrorOverrides` wants title/message, `TooManyRequests` wants
 *     retryAfter/requestId). Without the memo the first reader would clear the
 *     payload and the second would get null. A hard navigation creates a new
 *     document and therefore a fresh module, so the memo cannot outlive the
 *     navigation that produced the payload.
 *
 * Callers must still check `payload.code` against the page they are rendering:
 * within ONE document a soft navigation to a different error screen would
 * otherwise read a payload meant for the previous one.
 *
 * @returns {ErrorPagePayload|null}
 */
let _consumedPayload;
export function consumeErrorPagePayload() {
    if (_consumedPayload !== undefined) return _consumedPayload;
    const payload = session.get(ERROR_PAGE_PAYLOAD_KEY);
    if (payload) session.remove(ERROR_PAGE_PAYLOAD_KEY);
    _consumedPayload = payload ?? null;
    return _consumedPayload;
}

/**
 * Drops the in-memory memo so the next `consumeErrorPagePayload()` re-reads
 * storage. Exists for tests, which run many navigations inside one document and
 * would otherwise all see the first payload. A real hard navigation resets the module for free, so
 * production only calls it through `handOffErrorPagePayload` (an in-app navigation to an error screen).
 *
 * @returns {void}
 */
export function resetErrorPagePayloadCache() {
    _consumedPayload = undefined;
}

/**
 * Stashes a payload for an error screen reached by SPA navigation (no new document).
 * `consumeErrorPagePayload` memoises per document, so an error page shown earlier in this
 * document would otherwise keep serving its stale (possibly null) payload and the fresh
 * stash would never be read. Dropping the memo first makes the next mount read storage.
 *
 * @param {ErrorPagePayload} payload
 * @returns {void}
 */
export function handOffErrorPagePayload(payload) {
    resetErrorPagePayloadCache();
    stashErrorPagePayload(payload);
}
