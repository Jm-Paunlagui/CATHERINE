/**
 * clientErrorResponses.test.jsx — every full-page error screen, end to end.
 *
 * "Is every ClientErrorResponses page wired correctly?" is really five
 * questions, because a page can be wrong in five independent ways:
 *
 *   1. RENDER      — does it mount, and does it show the code it is named for?
 *   2. ROUTE       — does App.jsx actually register that path?
 *   3. CHROME      — is it in BARE_ROUTES? A "the server is unreachable" page
 *                    wrapped in a sidebar whose every link leads to the same
 *                    dead server is worse than no chrome at all.
 *   4. REACHABLE   — is it the destination of a status the API can return, or
 *                    of a routing decision? A page nothing can reach is dead
 *                    code that rots silently.
 *   5. SPEAKS      — does the server's own title/message survive the hard
 *                    navigation, or does every takeover show the same
 *                    hardcoded sentence whatever actually happened?
 *
 * App.jsx is read as SOURCE rather than rendered. Mounting the whole route tree
 * pulls in every lazy view and its providers — a slow and fragile way to answer
 * "is this path registered?", and one that fails for reasons unrelated to the
 * question.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { renderWithProviders } from "../../helpers/renderWithProviders.jsx";
import { ERROR_PAGE_ROUTES, TAKEOVER_ROUTE_BY_STATUS } from "../../../src/constants/httpStatus.js";
import csrfMiddleware from "../../../src/middleware/security/CsrfMiddleware.js";
import { resetErrorPagePayloadCache, stashErrorPagePayload } from "../../../src/utils/storage.js";
import ClientErrorResponses, { BadRequest, InvalidToken, LoginTimeOut, PageNotFound, ServiceUnavailable, SignatureMismatch, TooManyRequests, Unauthorized } from "../../../src/views/errors/ClientErrorResponses.jsx";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_JSX = path.resolve(HERE, "../../../src/App.jsx");
const PROTECTED_ROUTE_JSX = path.resolve(HERE, "../../../src/components/routing/ProtectedRoute.jsx");

/** The eight exported screens, paired with the code each is named for. */
const PAGES = [
    { name: "BadRequest", code: "400", Component: BadRequest },
    { name: "Unauthorized", code: "401", Component: Unauthorized },
    { name: "PageNotFound", code: "404", Component: PageNotFound },
    { name: "SignatureMismatch", code: "422", Component: SignatureMismatch },
    { name: "TooManyRequests", code: "429", Component: TooManyRequests },
    { name: "LoginTimeOut", code: "440", Component: LoginTimeOut },
    { name: "InvalidToken", code: "498", Component: InvalidToken },
    { name: "ServiceUnavailable", code: "523", Component: ServiceUnavailable },
];

let appSource;
beforeAll(() => {
    appSource = fs.readFileSync(APP_JSX, "utf8");
});

beforeEach(() => {
    // `consumeErrorPagePayload` memoises per document and these tests share one.
    // Without the reset, the first screen to mount would clear the payload and
    // every later screen in the file would read the memoised value instead.
    sessionStorage.clear();
    resetErrorPagePayloadCache();
});

afterEach(() => {
    cleanup();
    // `CsrfProvider` schedules a token refresh timer on init; clearing the token
    // cancels it so no test leaves a live handle behind for the next one.
    csrfMiddleware.clearToken();
    sessionStorage.clear();
    resetErrorPagePayloadCache();
});

describe("ClientErrorResponses — exports", () => {
    it("exports exactly the eight screens the status map knows about", () => {
        expect(Object.keys(ClientErrorResponses).sort()).toEqual(PAGES.map((p) => p.name).sort());
    });

    it("gives every exported screen a route entry in ERROR_PAGE_ROUTES", () => {
        expect(Object.keys(ERROR_PAGE_ROUTES).sort()).toEqual(PAGES.map((p) => p.code).sort());
    });
});

describe("ClientErrorResponses — rendering", () => {
    it.each(PAGES)("$name renders and shows its own status code ($code)", ({ code, Component }) => {
        const { container } = renderWithProviders(<Component />, { route: ERROR_PAGE_ROUTES[code] });
        // Scoped to the <h1> display, not getByText: the ambient side
        // decorations render loose digits (a falling-code column, a terminal
        // dump), so a document-wide text query matches more than one node.
        expect(container.querySelector("h1")?.textContent).toBe(code);
    });

    it.each(PAGES)("$name offers a way out", ({ code, Component }) => {
        renderWithProviders(<Component />, { route: ERROR_PAGE_ROUTES[code] });
        // A dead end with no exit is the one thing an error page must never be.
        const links = screen.getAllByRole("link");
        expect(links.length).toBeGreaterThan(0);
        expect(links.some((a) => a.getAttribute("href"))).toBe(true);
    });

    it.each(PAGES)("$name accepts a server-supplied title and subtitle override", ({ code, Component }) => {
        // All eight, SignatureMismatch included. A screen that hardcodes its
        // copy is a screen the server cannot speak through, and the server is
        // the only party that knows what actually went wrong.
        renderWithProviders(<Component title="Server said this" subtitle="And explained this" />, { route: ERROR_PAGE_ROUTES[code] });

        expect(screen.getByText("Server said this")).toBeTruthy();
        expect(screen.getByText("And explained this")).toBeTruthy();
    });

    it("TooManyRequests renders a countdown seeded from its prop", () => {
        renderWithProviders(<TooManyRequests retryAfter={90} />, { route: "/too-many-requests" });
        // formatCountdown(90) → "1:30". Asserted on the formatted value because
        // that is what the user reads.
        expect(document.body.textContent).toContain("1:30");
    });

    it("TooManyRequests falls back to 60s when nothing supplied a delay", () => {
        renderWithProviders(<TooManyRequests />, { route: "/too-many-requests" });
        expect(document.body.textContent).toContain("1:00");
    });
});

describe("ClientErrorResponses — the hard-navigation hand-off", () => {
    it("shows the server's own title, message and requestId after HttpClient stashed them", () => {
        // `window.location.replace` destroys router state, so `HttpClient`
        // stashes the envelope in sessionStorage and the screen picks it up.
        // Without this hand-off every takeover tells the user the same thing
        // whatever the server actually said.
        stashErrorPagePayload({
            code: 440,
            title: "Session Timeout",
            message: "Token has expired. Please log in again.",
            requestId: "test-req-000042",
        });

        renderWithProviders(<LoginTimeOut />, { route: "/login-timeout" });

        expect(screen.getByText("Session Timeout")).toBeTruthy();
        expect(screen.getByText("Token has expired. Please log in again.")).toBeTruthy();
        expect(screen.getByRole("button", { name: /test-req-000042/ })).toBeTruthy();
    });

    it("ignores a payload stashed for a DIFFERENT screen", () => {
        // A soft navigation between two error screens inside one document would
        // otherwise let the 429 payload write the 498 screen's headline.
        stashErrorPagePayload({ code: 429, title: "Too Many Requests", message: "Slow down.", requestId: "test-req-000043" });

        renderWithProviders(<InvalidToken />, { route: "/invalid-token" });

        expect(screen.queryByText("Slow down.")).toBeNull();
        expect(screen.queryByText("Too Many Requests")).toBeNull();
    });

    it("seeds the 429 countdown from the stashed retryAfter", () => {
        stashErrorPagePayload({ code: 429, title: "Too Many Requests", message: "Slow down.", requestId: "test-req-000044", retryAfter: "125" });

        renderWithProviders(<TooManyRequests />, { route: "/too-many-requests" });

        expect(document.body.textContent).toContain("2:05");
    });
});

describe("ClientErrorResponses — routing (read from App.jsx source)", () => {
    it.each(PAGES)("$name is imported by App.jsx", ({ name }) => {
        expect(appSource).toContain(name);
    });

    it.each(Object.entries(ERROR_PAGE_ROUTES))("route %s → %s is registered in App.jsx", (_code, route) => {
        const bare = route.replace(/^\//, "");
        expect(appSource).toMatch(new RegExp(`path="${bare}"`));
    });

    it("routes unknown paths to the 404 page", () => {
        expect(appSource).toMatch(/path="\*"[\s\S]{0,80}\/page-not-found/);
    });
});

describe("ClientErrorResponses — chrome (BARE_ROUTES)", () => {
    let bareRoutes;
    beforeAll(() => {
        const match = appSource.match(/const BARE_ROUTES = \[([\s\S]*?)\];/);
        expect(match, "BARE_ROUTES not found in App.jsx").not.toBeNull();
        bareRoutes = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
        expect(bareRoutes.length).toBeGreaterThan(5);
    });

    it.each(Object.entries(ERROR_PAGE_ROUTES))("route %s → %s renders with no app chrome", (_code, route) => {
        // An outage screen inside the app shell offers a sidebar full of links
        // to the server that just failed. Every error route must be bare.
        expect(bareRoutes).toContain(route);
    });
});

describe("ClientErrorResponses — reachability", () => {
    const INTERCEPTOR_REACHED = new Set(Object.values(TAKEOVER_ROUTE_BY_STATUS));

    it("has every page reachable either by the interceptor or by a routing decision", () => {
        // Pages `HttpClient`'s response interceptor navigates to.
        const byInterceptor = ["/too-many-requests", "/login-timeout", "/invalid-token", "/service-is-currently-unavailable"];
        // Pages reached by a routing decision instead: ProtectedRoute redirects
        // to /unauthorized, the router catch-all sends unknown paths to
        // /page-not-found, and /bad-request + /signature-mismatch are explicit
        // navigation targets for features that detect those conditions locally.
        const byRouting = ["/unauthorized", "/page-not-found", "/bad-request", "/signature-mismatch"];

        expect([...byInterceptor, ...byRouting].sort()).toEqual(Object.values(ERROR_PAGE_ROUTES).sort());

        for (const route of byInterceptor) expect(INTERCEPTOR_REACHED).toContain(route);
        for (const route of byRouting) expect(INTERCEPTOR_REACHED).not.toContain(route);
    });

    it("wires ProtectedRoute's default redirect to the /unauthorized page", () => {
        expect(fs.readFileSync(PROTECTED_ROUTE_JSX, "utf8")).toContain('redirectTo = "/unauthorized"');
    });
});

describe("ClientErrorResponses — dark mode parity", () => {
    it.each(PAGES)("$name paints an explicit dark surface, never inheriting the host background", ({ code, Component }) => {
        const { container } = renderWithProviders(<Component />, { route: ERROR_PAGE_ROUTES[code] });
        const html = container.innerHTML;
        expect(html).toMatch(/dark:(bg|from|via|to)-/);
        expect(html).toMatch(/dark:text-/);
    });
});
