/**
 * httpStatus.test.js — the frontend half of the status-code contract.
 *
 * `src/constants/httpStatus.js` calls itself "the assertion target for the
 * contract test". This is that test. It has three jobs:
 *
 *  1. PARITY — the title map and the status catalogue are read out of the
 *     BACKEND's own source files and compared key-for-key. A hand-copied mirror
 *     rots silently; reading the other side of the contract makes the rot a
 *     failing test on the commit that introduces it, instead of a wrong heading
 *     on an error screen six months later.
 *
 *  2. TRUTH TABLE — `resolveStatusHandling` is exercised for every status the
 *     backend can emit, asserting takeover-vs-inline, destination route,
 *     session teardown, and severity.
 *
 *  3. REGRESSION GUARDS — the mappings whose absence would be a user-visible
 *     defect: business 5xx staying inline, the sign-in exemption, and every
 *     takeover pointing at a page that exists.
 *
 * Pure: no MSW, no React, no network. The only I/O is reading two backend
 * source files off disk.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
    CONDITIONAL_TAKEOVER_STATUSES,
    ERROR_PAGE_ROUTES,
    HTTP_STATUS_TITLES,
    OUTAGE_ERROR_TYPES,
    SELF_HANDLED_ENDPOINTS,
    SESSION_ENDING_STATUSES,
    STATUS_SEVERITY,
    TAKEOVER_ROUTE_BY_STATUS,
    getStatusSeverity,
    getStatusTitle,
    isSelfHandledEndpoint,
    resolveStatusHandling,
} from "../../../src/constants/httpStatus.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_RESPONSES = path.resolve(HERE, "../../../../Backend/src/constants/responses/index.js");
const BACKEND_STATUS = path.resolve(HERE, "../../../../Backend/src/constants/index.js");

/** Parse a `const NAME = { KEY: 123, ... };` block out of a CommonJS constants file. */
function readNumericMap(file, constName, keyPattern) {
    const source = fs.readFileSync(file, "utf8");
    const block = source.match(new RegExp(`const ${constName} = \\{([\\s\\S]*?)\\n\\};`));
    expect(block, `${constName} block not found in ${path.basename(file)}`).not.toBeNull();

    const out = {};
    for (const line of block[1].split(/\r?\n/)) {
        const entry = line.match(keyPattern);
        if (entry) out[entry[1]] = entry[2];
    }
    return out;
}

/** Backend `HTTP_STATUS_TITLES` → `{ [code:number]: title:string }`. */
function backendTitles() {
    const raw = readNumericMap(BACKEND_RESPONSES, "HTTP_STATUS_TITLES", /^\s*(\d{3}):\s*"([^"]+)",/);
    return Object.fromEntries(Object.entries(raw).map(([code, title]) => [Number(code), title]));
}

/** Backend `HTTP_STATUS` → every code the API is allowed to emit. */
function backendCodes() {
    const raw = readNumericMap(BACKEND_STATUS, "HTTP_STATUS", /^\s*([A-Z_]+):\s*(\d{3}),/);
    return Object.values(raw).map(Number);
}

const ALL_BACKEND_CODES = backendCodes();
const BACKEND_ERROR_CODES = ALL_BACKEND_CODES.filter((c) => c >= 400);

describe("httpStatus — backend parity", () => {
    it("can see both backend source files (a broken path would make every parity test vacuous)", () => {
        expect(fs.existsSync(BACKEND_RESPONSES)).toBe(true);
        expect(fs.existsSync(BACKEND_STATUS)).toBe(true);
    });

    it("parses a non-trivial catalogue out of the backend (guards against a silently broken parser)", () => {
        expect(ALL_BACKEND_CODES.length).toBeGreaterThan(20);
        expect(Object.keys(backendTitles()).length).toBeGreaterThan(15);
    });

    it("mirrors the backend's HTTP_STATUS_TITLES exactly, code for code and string for string", () => {
        // Byte-identical, not merely "compatible". The backend already sends
        // `title` in every error envelope; this map is the offline fallback for
        // responses that never reached a server. If the two disagree, the same
        // failure reads as two different things depending on whether the origin
        // answered — precisely the bug a user reports and nobody can reproduce.
        const frontendTitles = Object.fromEntries(Object.entries(HTTP_STATUS_TITLES).map(([code, title]) => [Number(code), title]));
        expect(frontendTitles).toEqual(backendTitles());
    });

    it("gives EVERY backend error code a frontend title", () => {
        const titled = new Set(Object.keys(HTTP_STATUS_TITLES).map(Number));
        const untitled = BACKEND_ERROR_CODES.filter((c) => !titled.has(c));
        expect(untitled).toEqual([]);
    });

    it("leaves untitled exactly the four codes that never need a title — the success ones", () => {
        // 200/201/202/204 never surface as a heading: a success carries the
        // feature's own copy. 207 IS titled because a Multi-Status body reports
        // per-item failures the UI has to label.
        const titled = new Set(Object.keys(HTTP_STATUS_TITLES).map(Number));
        const untitled = ALL_BACKEND_CODES.filter((c) => !titled.has(c)).sort((a, b) => a - b);
        expect(untitled).toEqual([200, 201, 202, 204]);
    });

    it("never titles a code the backend cannot emit", () => {
        // A title for a status no service returns is dead copy that will be
        // maintained forever by people who assume something reaches it.
        const declared = new Set(ALL_BACKEND_CODES);
        const orphans = Object.keys(HTTP_STATUS_TITLES)
            .map(Number)
            .filter((c) => !declared.has(c));
        expect(orphans).toEqual([]);
    });

    it("uses the same category fallbacks the backend uses for unmapped codes", () => {
        expect(getStatusTitle(451)).toBe("Client Error");
        expect(getStatusTitle(599)).toBe("Server Error");
        expect(getStatusTitle(302)).toBe("Redirect");
        expect(getStatusTitle(0)).toBe("Error");
        expect(getStatusTitle(undefined)).toBe("Error");
    });

    it.each(BACKEND_ERROR_CODES)("gives status %i a specific title, never a category fallback", (code) => {
        const title = getStatusTitle(code);
        expect(title).toBeTruthy();
        expect(["Client Error", "Server Error", "Error"]).not.toContain(title);
    });
});

describe("httpStatus — severity", () => {
    it.each(BACKEND_ERROR_CODES)("assigns status %i an explicit severity", (code) => {
        expect(STATUS_SEVERITY[code]).toBeDefined();
        expect(["info", "warning", "danger"]).toContain(getStatusSeverity(code));
    });

    it("keeps recoverable client outcomes amber, not red", () => {
        // Each of these describes a state the user can resolve — wait, retry,
        // shrink the file, sign in again. Painting a recoverable, expected
        // outcome in danger red is what teaches users to stop reading red, and
        // the states that DO need attention then lose their signal.
        for (const code of [404, 408, 409, 410, 413, 423, 428, 429, 440]) {
            expect(getStatusSeverity(code)).toBe("warning");
        }
    });

    it("keeps genuine failures red", () => {
        for (const code of [400, 401, 403, 405, 422, 498, 500, 502, 503, 504, 507, 523]) {
            expect(getStatusSeverity(code)).toBe("danger");
        }
    });

    it("treats 207 Multi-Status as information, not failure", () => {
        // 207 is the one titled code with no severity entry: a partial success
        // is reported per item by the feature, so the envelope itself is
        // informational. It must fall through the map, not turn red by accident.
        expect(STATUS_SEVERITY[207]).toBeUndefined();
        expect(getStatusSeverity(207)).toBe("info");
    });

    it("falls back by category for an unmapped code", () => {
        expect(getStatusSeverity(451)).toBe("warning");
        expect(getStatusSeverity(599)).toBe("danger");
        expect(getStatusSeverity(999)).toBe("danger");
        expect(getStatusSeverity(204)).toBe("info");
        expect(getStatusSeverity(null)).toBe("info");
        expect(getStatusSeverity(undefined)).toBe("info");
    });
});

describe("httpStatus — error page routes", () => {
    it("maps each ClientErrorResponses page to exactly one route", () => {
        expect(ERROR_PAGE_ROUTES).toEqual({
            400: "/bad-request",
            401: "/unauthorized",
            404: "/page-not-found",
            422: "/signature-mismatch",
            429: "/too-many-requests",
            440: "/login-timeout",
            498: "/invalid-token",
            523: "/service-is-currently-unavailable",
        });
    });

    it("points every takeover status at a real error page route", () => {
        // A takeover route with no page behind it navigates into the router
        // catch-all — a 404 screen for a 503. This is what makes the derived
        // values in TAKEOVER_ROUTE_BY_STATUS load-bearing rather than decorative.
        const pages = new Set(Object.values(ERROR_PAGE_ROUTES));
        for (const route of Object.values(TAKEOVER_ROUTE_BY_STATUS)) {
            expect(pages).toContain(route);
        }
    });

    it("collapses every upstream-unreachable status onto one screen", () => {
        // From the browser's seat 502/503/504/523 are one situation with one
        // recovery (wait, retry later). Four near-identical screens would be
        // noise the user has to read past.
        const outage = ERROR_PAGE_ROUTES[523];
        for (const code of [502, 503, 504, 523]) {
            expect(TAKEOVER_ROUTE_BY_STATUS[code]).toBe(outage);
        }
    });

    it("declares takeover routes for exactly seven statuses", () => {
        expect(
            Object.keys(TAKEOVER_ROUTE_BY_STATUS)
                .map(Number)
                .sort((a, b) => a - b),
        ).toEqual([429, 440, 498, 502, 503, 504, 523]);
    });

    it("freezes the shared maps so a caller cannot mutate them", () => {
        // NOTE: `Object.freeze` on a Set only blocks bolting properties onto the
        // Set object — `.add()` still works, because membership lives in an
        // internal slot. The Sets are therefore checked for non-extensibility
        // only; the real protection for those is that nothing in src/ mutates
        // them, which no unit test can prove.
        for (const map of [HTTP_STATUS_TITLES, ERROR_PAGE_ROUTES, TAKEOVER_ROUTE_BY_STATUS, STATUS_SEVERITY, SELF_HANDLED_ENDPOINTS]) {
            expect(Object.isFrozen(map)).toBe(true);
        }
        expect(() => SELF_HANDLED_ENDPOINTS.push("auth/anything")).toThrow();
    });
});

describe("resolveStatusHandling — truth table", () => {
    /** Every backend error code with no takeover route: the view stays mounted. */
    const INLINE_ALWAYS = BACKEND_ERROR_CODES.filter((c) => !(c in TAKEOVER_ROUTE_BY_STATUS)).sort((a, b) => a - b);

    it("classifies fourteen statuses as always-inline", () => {
        expect(INLINE_ALWAYS).toEqual([400, 401, 403, 404, 405, 408, 409, 410, 413, 422, 423, 428, 500, 507]);
    });

    it.each(INLINE_ALWAYS)("keeps status %i inline — the view stays mounted and the feature renders its own message", (code) => {
        const plan = resolveStatusHandling(code, { url: "admin-management", errorType: "AppError" });
        expect(plan.mode).toBe("inline");
        expect(plan.route).toBeNull();
        expect(plan.endsSession).toBe(false);
    });

    it("never takes over on 401 — the backend uses it for a failed sign-in, not only a dead session", () => {
        // Hard-navigating on 401 would replace the sign-in form (and whatever
        // the user has typed) with a full-page screen, for what is a
        // field-level message.
        for (const type of ["AuthenticationError", "AppError"]) {
            expect(resolveStatusHandling(401, { url: "auth/me", errorType: type }).mode).toBe("inline");
        }
    });

    it("never takes over on 403 — the backend uses it for business-rule denials", () => {
        // `AuthMiddleware.requireAccess` throws 403 `AuthorizationError` for
        // "you may not do this", never "your session ended". A takeover here
        // destroys an in-progress form to deliver a permission message.
        for (const type of ["AuthorizationError", "ForbiddenError", "AppError"]) {
            expect(resolveStatusHandling(403, { url: "admin-management", errorType: type }).mode).toBe("inline");
        }
    });

    it.each([
        [429, "/too-many-requests", false],
        [440, "/login-timeout", true],
        [498, "/invalid-token", true],
    ])("takes over on status %i → %s", (code, route, endsSession) => {
        const plan = resolveStatusHandling(code, { url: "audit-logs", errorType: "AppError" });
        expect(plan.mode).toBe("takeover");
        expect(plan.route).toBe(route);
        expect(plan.endsSession).toBe(endsSession);
    });

    it.each([503, 523])("takes over on an infrastructural %i → /service-is-currently-unavailable", (code) => {
        const plan = resolveStatusHandling(code, { url: "metrics/summary", errorType: "DatabaseUnavailableError" });
        expect(plan.mode).toBe("takeover");
        expect(plan.route).toBe("/service-is-currently-unavailable");
    });

    it("ends the session on 440 and 498, and on nothing else", () => {
        expect([...SESSION_ENDING_STATUSES].sort((a, b) => a - b)).toEqual([440, 498]);
        for (const code of ALL_BACKEND_CODES) {
            const expected = code === 440 || code === 498;
            expect(resolveStatusHandling(code, { url: "changelog" }).endsSession).toBe(expected);
        }
    });

    it("accepts a bare url string as shorthand for { url }", () => {
        expect(resolveStatusHandling(440, "audit-logs")).toEqual(resolveStatusHandling(440, { url: "audit-logs" }));
    });

    it("tolerates a null/undefined context and a null status", () => {
        // The interceptor calls this on a network error too, where there is no
        // status at all. Throwing here would turn a recoverable failure into an
        // unhandled rejection inside the interceptor.
        expect(() => resolveStatusHandling(undefined)).not.toThrow();
        expect(resolveStatusHandling(undefined).mode).toBe("inline");
        expect(resolveStatusHandling(null, null).mode).toBe("inline");
        expect(resolveStatusHandling(null, null).selfHandled).toBe(false);
    });

    it("carries the title and severity through onto the plan", () => {
        const plan = resolveStatusHandling(409, { url: "changelog", errorType: "AppError" });
        expect(plan.title).toBe("Conflict Detected");
        expect(plan.severity).toBe("warning");
    });

    it("returns the same six-key plan shape whatever the status", () => {
        for (const code of [400, 429, 440, 503, 999, undefined]) {
            expect(Object.keys(resolveStatusHandling(code, { url: "health" })).sort()).toEqual(["endsSession", "mode", "route", "selfHandled", "severity", "title"]);
        }
    });
});

describe("resolveStatusHandling — conditional 5xx", () => {
    it("declares exactly the four upstream codes as conditional", () => {
        expect([...CONDITIONAL_TAKEOVER_STATUSES].sort((a, b) => a - b)).toEqual([502, 503, 504, 523]);
    });

    it("recognises the three database-level outage types and nothing else", () => {
        expect([...OUTAGE_ERROR_TYPES].sort()).toEqual(["DatabaseError", "DatabaseTimeoutError", "DatabaseUnavailableError"]);
    });

    it("does not let DatabaseError take over outside the conditional statuses", () => {
        // ORA- errors carry `DatabaseError` at 4xx and 500 too (a constraint
        // violation, a bad bind). Those are business outcomes on a healthy
        // server and must stay inline — only the connectivity variants at
        // 502/503/504/523 are outages.
        for (const code of [400, 409, 422, 423, 500]) {
            expect(resolveStatusHandling(code, { url: "audit-logs", errorType: "DatabaseError" }).mode).toBe("inline");
        }
    });

    it.each([
        [502, "EmailError", "admin-management"],
        [502, "NotificationError", "metrics/notifications/status"],
        [503, "MetricsError", "metrics/summary"],
        [503, "AppError", "changelog"],
        [504, "AppError", "audit-logs/export/excel"],
    ])("keeps a business %i (%s) inline so the feature can render its own recovery UI", (code, errorType, url) => {
        const plan = resolveStatusHandling(code, { url, errorType });
        expect(plan.mode).toBe("inline");
        expect(plan.route).toBeNull();
    });

    it("takes over on a 502/503/504 the driver classified as an outage", () => {
        for (const errorType of ["DatabaseError", "DatabaseUnavailableError", "DatabaseTimeoutError"]) {
            for (const code of [502, 503, 504]) {
                const plan = resolveStatusHandling(code, { url: "admin-management", errorType });
                expect(plan.mode).toBe("takeover");
                expect(plan.route).toBe("/service-is-currently-unavailable");
            }
        }
    });

    it("takes over on a 5xx that carried no envelope at all — an edge proxy or a dead origin", () => {
        for (const code of [502, 503, 504, 523]) {
            const plan = resolveStatusHandling(code, { url: "changelog", hasEnvelope: false });
            expect(plan.mode).toBe("takeover");
            expect(plan.route).toBe("/service-is-currently-unavailable");
        }
    });

    it("treats a missing errorType as 'no envelope' so a bare 523 from an edge still takes over", () => {
        expect(resolveStatusHandling(523, { url: "changelog" }).mode).toBe("takeover");
    });

    it("does NOT take over on a 500 with no envelope — a dead origin does not answer 500", () => {
        // 500 is deliberately absent from CONDITIONAL_TAKEOVER_STATUSES: it
        // means an application ran and threw, so the feature stays mounted and
        // renders the failure in place.
        expect(resolveStatusHandling(500, { url: "changelog", hasEnvelope: false }).mode).toBe("inline");
    });
});

describe("resolveStatusHandling — sign-in exemption", () => {
    it("exempts exactly the three endpoints that share the auth rate limiter", () => {
        expect([...SELF_HANDLED_ENDPOINTS]).toEqual(["auth/login", "auth/refresh", "auth/change-password"]);
    });

    it.each(["auth/login", "auth/refresh", "auth/change-password"])("recognises %s as self-handled", (url) => {
        expect(isSelfHandledEndpoint(url)).toBe(true);
        expect(isSelfHandledEndpoint(`/api/v1/${url}`)).toBe(true);
        expect(isSelfHandledEndpoint(`http://localhost:3000/api/v1/${url}`)).toBe(true);
    });

    it("does not treat an unrelated route as self-handled", () => {
        expect(isSelfHandledEndpoint("auth/me")).toBe(false);
        expect(isSelfHandledEndpoint("auth/logout")).toBe(false);
        expect(isSelfHandledEndpoint("admin-management")).toBe(false);
        expect(isSelfHandledEndpoint("")).toBe(false);
        expect(isSelfHandledEndpoint(null)).toBe(false);
        expect(isSelfHandledEndpoint(undefined)).toBe(false);
    });

    it("never hijacks a rate-limited sign-in — auth.hook.js owns that countdown", () => {
        // The sign-in screen is exactly where a lockout needs the most context.
        // Replacing it with a full-page takeover strips that away, and the
        // takeover screen's own retry affordance would extend the block.
        for (const url of SELF_HANDLED_ENDPOINTS) {
            const plan = resolveStatusHandling(429, { url, errorType: "AppError" });
            expect(plan.mode).toBe("inline");
            expect(plan.route).toBeNull();
            expect(plan.selfHandled).toBe(true);
        }
    });

    it("never hijacks a locked account on 423 either", () => {
        expect(resolveStatusHandling(423, { url: "auth/login", errorType: "AppError" }).mode).toBe("inline");
    });

    it("keeps a self-handled outage inline — the sign-in form shows its own message", () => {
        expect(resolveStatusHandling(503, { url: "auth/login", errorType: "DatabaseUnavailableError" }).mode).toBe("inline");
    });

    it("STILL ends the session on a self-handled 440/498 — a dead cookie is dead everywhere", () => {
        for (const code of [440, 498]) {
            const plan = resolveStatusHandling(code, { url: "auth/refresh", errorType: "AppError" });
            expect(plan.endsSession).toBe(true);
            // The takeover is still correct: the credential is gone, so
            // suppressing it would leave the app rendering a signed-in shell
            // for a user the server has forgotten.
            expect(plan.mode).toBe("takeover");
        }
    });
});
