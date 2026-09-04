/**
 * api.js — the one place a handler learns where the API lives.
 *
 * `vitest.config.js` pins `VITE_API_BASE_URL` to `http://localhost:3000/api/v1/`,
 * which `src/config/apiBase.js` normalises to a trailing slash. Handlers must
 * register the SAME absolute origin or MSW's `onUnhandledRequest: "error"` turns
 * a typo into an unrelated-looking failure in whatever test happened to run first.
 *
 * `API` here is byte-identical to `API` in `./server.js` — un-slashed. Two
 * spellings of the same base is how a suite ends up with `//csrf/token`
 * handlers that never match, so there is exactly one spelling and `apiUrl()`
 * owns the join.
 *
 * Both transports are intercepted at this boundary: Axios (`HttpClient`) and
 * raw `fetch` (`CsrfMiddleware`, `frontendMetrics`).
 */

/** Base URL every handler registers against — matches vitest.config.js env. */
export const API = "http://localhost:3000/api/v1";

/**
 * Join a feature path onto the API base.
 *
 * @param {string} path Path with or without a leading slash, e.g. `"auth/login"`.
 * @returns {string} Absolute URL, e.g. `"http://localhost:3000/api/v1/auth/login"`.
 * @example http.get(apiUrl("changelog"), () => HttpResponse.json(ok("...", [])));
 */
export function apiUrl(path) {
    return `${API}/${String(path).replace(/^\/+/, "")}`;
}
