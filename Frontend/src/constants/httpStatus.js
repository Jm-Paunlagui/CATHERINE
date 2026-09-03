/**
 * httpStatus.js — The frontend's single source of truth for HTTP status handling.
 *
 * WHAT THIS FILE DOES
 *   Mirrors the backend's status catalogue (`Backend/src/constants/index.js`
 *   HTTP_STATUS + `Backend/src/constants/responses/index.js` HTTP_STATUS_TITLES)
 *   and decides, for every code the API can return, how the UI reacts:
 *
 *     takeover → hard-navigate to a full-page <ClientErrorResponses> screen
 *     inline   → keep the view mounted, render <ApiErrorAlert> / a toast
 *
 * HOW IT WORKS
 *   A status earns `takeover` ONLY when the current view genuinely cannot
 *   continue — the session is gone (440/498), the whole client is being
 *   throttled (429), or the origin is unreachable (502/503/504/523). Every
 *   other code is a per-request outcome that the calling feature must show
 *   in context.
 *
 *   This distinction is the whole point of the file. 401/403/409/422/423 are
 *   NOT takeovers: a backend uses them for business-rule failures ("you may not
 *   perform this action", "that password doesn't match", "this record is
 *   already closed"). Hard-navigating on those would destroy an in-progress
 *   form and lose the user's work for what is, semantically, a validation
 *   message.
 *
 * EXAMPLE
 *   import { resolveStatusHandling } from "../constants/httpStatus";
 *
 *   const plan = resolveStatusHandling(503, "reports/summary");
 *   // → { mode: "takeover", route: "/service-is-currently-unavailable",
 *   //     severity: "danger", title: "Service Unavailable", selfHandled: false }
 *
 *   const plan2 = resolveStatusHandling(429, "auth/login");
 *   // → { mode: "inline", route: null, ... selfHandled: true }
 *   //   the sign-in form renders its own lockout countdown.
 */

/* ─── Status catalogue (mirrors the backend byte-for-byte) ───────────────────── */

/**
 * Human-readable title per status code. Must stay identical to
 * `HTTP_STATUS_TITLES` in `Backend/src/constants/responses/index.js`.
 * The backend already sends `title` in every error envelope; this map is the
 * fallback for responses that never reached the server (network error,
 * Axios timeout) and the assertion target for the contract test.
 * @type {Readonly<Record<number, string>>}
 */
export const HTTP_STATUS_TITLES = Object.freeze({
    // 2xx Success
    207: "Multi-Status",
    // 4xx Client Errors
    400: "Bad Request",
    401: "Unauthorized Access",
    403: "Forbidden Access",
    404: "Not Found",
    405: "Method Not Allowed",
    408: "Request Timeout",
    409: "Conflict Detected",
    410: "Gone Permanently",
    413: "Payload Too Large",
    422: "Unprocessable Entity",
    423: "Locked Resource",
    428: "Precondition Required",
    429: "Too Many Requests",
    440: "Session Timeout",
    498: "Invalid Token",
    // 5xx Server Errors
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout",
    507: "Insufficient Storage",
    523: "Origin Unreachable",
});

/**
 * Returns the standard title for a status code, falling back to a broad
 * category label. Mirrors `getStatusTitle()` in the backend exactly, so an
 * offline-generated title never disagrees with a server-generated one.
 *
 * @param {number|null|undefined} code
 * @returns {string}
 * @example getStatusTitle(409) // "Conflict Detected"
 * @example getStatusTitle(451) // "Client Error"
 */
export function getStatusTitle(code) {
    if (HTTP_STATUS_TITLES[code]) return HTTP_STATUS_TITLES[code];
    if (code >= 500) return "Server Error";
    if (code >= 400) return "Client Error";
    if (code >= 300) return "Redirect";
    return "Error";
}

/* ─── Full-page error routes ─────────────────────────────────────────────────── */

/**
 * Route path for every page exported by `views/errors/ClientErrorResponses.jsx`.
 * Keys are the HTTP code the page is *named* after; the presence of a key here
 * does NOT mean the interceptor navigates there automatically — see
 * `TAKEOVER_ROUTE_BY_STATUS` for that. `/unauthorized`, `/bad-request`,
 * `/page-not-found` and `/signature-mismatch` are reached by routing decisions
 * (ProtectedRoute, the router catch-all, an explicit `navigate()`), not by the
 * response interceptor.
 * @type {Readonly<Record<number, string>>}
 */
export const ERROR_PAGE_ROUTES = Object.freeze({
    400: "/bad-request",
    401: "/unauthorized",
    404: "/page-not-found",
    422: "/signature-mismatch",
    429: "/too-many-requests",
    440: "/login-timeout",
    498: "/invalid-token",
    523: "/service-is-currently-unavailable",
});

/**
 * Statuses the HttpClient response interceptor hard-navigates on.
 *
 * Membership rule — a code belongs here only if BOTH hold:
 *   1. No feature could meaningfully recover in place, and
 *   2. Continuing to render the current view would mislead the user.
 *
 * 502/504/523 all resolve to the 523 page: from the browser's seat "the
 * upstream is not answering" is one situation with one recovery (wait, retry
 * later), and three near-identical screens would be noise. 503 joins them
 * because the Oracle adapter emits it for pool exhaustion and lost connections.
 *
 * ⚠ 502/503/504/523 are CONDITIONAL — see `OUTAGE_ERROR_TYPES`. This backend
 * overloads all three 5xx codes with business meanings (a failed SMTP send is
 * 502 `EmailError`; an unavailable metrics store is 503 `MetricsError`), and
 * those must stay inline. Only the infrastructure variants take over.
 * @type {Readonly<Record<number, string>>}
 */
export const TAKEOVER_ROUTE_BY_STATUS = Object.freeze({
    429: ERROR_PAGE_ROUTES[429],
    440: ERROR_PAGE_ROUTES[440],
    498: ERROR_PAGE_ROUTES[498],
    502: ERROR_PAGE_ROUTES[523],
    503: ERROR_PAGE_ROUTES[523],
    504: ERROR_PAGE_ROUTES[523],
    523: ERROR_PAGE_ROUTES[523],
});

/**
 * Statuses whose takeover is conditional on the error being infrastructural.
 * @type {ReadonlySet<number>}
 */
export const CONDITIONAL_TAKEOVER_STATUSES = Object.freeze(new Set([502, 503, 504, 523]));

/**
 * `error.type` values a backend stamps on genuine infrastructure failures.
 *
 * Only consulted for the four `CONDITIONAL_TAKEOVER_STATUSES`. A `DatabaseError`
 * that reaches this check has, by construction, already been narrowed to a
 * connectivity/availability failure (no listener, instance down, connection
 * lost, host unreachable, pool exhausted) — the ORA- classifier stamps the
 * business-shaped `DatabaseError`s with 4xx or 500, and those never enter the
 * conditional branch.
 *
 * `DatabaseUnavailableError` comes from the NJS- driver classifier (pool
 * exhausted, connection lost) and `DatabaseTimeoutError` from the
 * connection-acquire timeout.
 *
 * Deliberately NOT here: every service-level 5xx type — `EmailError`,
 * `NotificationError`, `MetricsError`, `DataProtectionError`, plain `AppError`
 * — each of which describes one failed operation on a healthy server. A feature
 * that opens its own modal on a 502 `EmailError` would lose that context to a
 * hard navigation.
 * @type {ReadonlySet<string>}
 */
export const OUTAGE_ERROR_TYPES = Object.freeze(new Set(["DatabaseError", "DatabaseUnavailableError", "DatabaseTimeoutError"]));

/**
 * Takeover statuses that additionally require clearing the local session
 * before navigating. Both mean the credential itself is unusable, so leaving
 * `user_session` / the CSRF token in place would let the app render a
 * signed-in shell for a user the server no longer recognises.
 * @type {ReadonlySet<number>}
 */
export const SESSION_ENDING_STATUSES = Object.freeze(new Set([440, 498]));

/* ─── Severity mapping ───────────────────────────────────────────────────────── */

/**
 * `<Alert variant>` to use for each status when rendered in context.
 *
 * `warning` is deliberate for 409/423/428/429: those describe a state the user
 * can resolve (close the period, wait for the lock, confirm the precondition).
 * Painting a recoverable, expected outcome in danger red trains users to
 * ignore red — the states that actually need attention lose their signal.
 * @type {Readonly<Record<number, "info"|"success"|"warning"|"danger">>}
 */
export const STATUS_SEVERITY = Object.freeze({
    400: "danger",
    401: "danger",
    403: "danger",
    404: "warning",
    405: "danger",
    408: "warning",
    409: "warning",
    410: "warning",
    413: "warning",
    422: "danger",
    423: "warning",
    428: "warning",
    429: "warning",
    440: "warning",
    498: "danger",
    500: "danger",
    502: "danger",
    503: "danger",
    504: "danger",
    507: "danger",
    523: "danger",
});

/**
 * Returns the Alert variant for a status code.
 * Unmapped 4xx default to `warning` (client-correctable), 5xx to `danger`.
 *
 * @param {number|null|undefined} code
 * @returns {"info"|"warning"|"danger"}
 */
export function getStatusSeverity(code) {
    if (STATUS_SEVERITY[code]) return STATUS_SEVERITY[code];
    if (code >= 500) return "danger";
    if (code >= 400) return "warning";
    return "info";
}

/* ─── Self-handled endpoints ─────────────────────────────────────────────────── */

/**
 * URL fragments whose owning feature renders its OWN error UI and must never
 * be hijacked by a global takeover.
 *
 * The sign-in flow is the whole of this list and is exempt by explicit
 * requirement: `auth.hook.js` shows an in-context lockout countdown for 429
 * and 423, and a full-page takeover on the sign-in screen would strip away the
 * exact context a locked-out user needs. `auth/refresh` and
 * `auth/change-password` share the same server-side limiter instance, so they
 * carry the same exemption.
 *
 * NOTE: session-ending codes (440/498) intentionally ignore this list — a dead
 * token on the sign-in screen still has to clear local session state.
 * @type {ReadonlyArray<string>}
 */
export const SELF_HANDLED_ENDPOINTS = Object.freeze(["auth/login", "auth/refresh", "auth/change-password"]);

/**
 * True when `url` belongs to a feature that renders its own error UI.
 * @param {string|undefined|null} url
 * @returns {boolean}
 */
export function isSelfHandledEndpoint(url) {
    if (!url) return false;
    return SELF_HANDLED_ENDPOINTS.some((p) => url.includes(p));
}

/* ─── Resolution ─────────────────────────────────────────────────────────────── */

/**
 * @typedef {object} StatusHandlingPlan
 * @property {"takeover"|"inline"} mode        How the UI should react.
 * @property {string|null}         route       Destination path when mode is "takeover".
 * @property {boolean}             endsSession Whether local session state must be cleared first.
 * @property {"info"|"warning"|"danger"} severity  `<Alert variant>` for inline display.
 * @property {string}              title       Human-readable status title.
 * @property {boolean}             selfHandled Whether the endpoint owns its error UI.
 */

/**
 * @typedef {object} StatusHandlingContext
 * @property {string}  [url=""]         Request URL, for the self-handled check.
 * @property {string|null} [errorType]  `response.data.error.type` from the envelope.
 * @property {boolean} [hasEnvelope]    Whether the body is our `sendError` shape.
 *                                      Defaults to `errorType != null`. A 5xx with
 *                                      no envelope came from an edge proxy or a
 *                                      dead origin, never from a service — those
 *                                      always take over.
 */

/**
 * Single decision point for "what does the UI do with this status?".
 *
 * O(1) time — every lookup is a plain object/Set hit; `isSelfHandledEndpoint`
 * scans a frozen 3-element array. O(1) space.
 *
 * @param {number|null|undefined} status HTTP status from `error.response.status`.
 * @param {StatusHandlingContext|string} [context={}] Context object. A bare
 *        string is accepted and treated as `{ url }` for call-site brevity.
 * @returns {StatusHandlingPlan}
 *
 * @example
 * const { mode, route } = resolveStatusHandling(440, { url: "reports/summary" });
 * if (mode === "takeover") window.location.replace(route);
 *
 * @example
 * // Business 502 — stays inline so the feature can open its own modal.
 * resolveStatusHandling(502, { url: "qr/resend", errorType: "EmailError" }).mode; // "inline"
 */
export function resolveStatusHandling(status, context = {}) {
    const ctx = typeof context === "string" ? { url: context } : (context ?? {});
    const { url = "", errorType = null } = ctx;
    const hasEnvelope = ctx.hasEnvelope ?? errorType != null;

    const selfHandled = isSelfHandledEndpoint(url);
    const endsSession = SESSION_ENDING_STATUSES.has(status);
    const mappedRoute = TAKEOVER_ROUTE_BY_STATUS[status] ?? null;

    // A conditional 5xx takes over only when it is genuinely infrastructural:
    // either the backend labelled it so, or nothing recognisable came back at
    // all (edge proxy / dead origin — no envelope to label it with).
    const conditionOk = !CONDITIONAL_TAKEOVER_STATUSES.has(status) || !hasEnvelope || OUTAGE_ERROR_TYPES.has(errorType);

    // A self-handled endpoint suppresses the navigation but NEVER the session
    // teardown — a 440 on auth/refresh still means the cookie is dead.
    const takes = Boolean(mappedRoute) && conditionOk && (!selfHandled || endsSession);

    return {
        mode: takes ? "takeover" : "inline",
        route: takes ? mappedRoute : null,
        endsSession,
        severity: getStatusSeverity(status),
        title: getStatusTitle(status),
        selfHandled,
    };
}
