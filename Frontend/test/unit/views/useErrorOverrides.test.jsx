/**
 * useErrorOverrides.test.jsx — The error screens' copy resolver.
 *
 * `useErrorOverrides` decides the headline and lead paragraph every full-page
 * error screen shows. It is exercised here through the real exported
 * components (it is module-private by design) against the four qualities that
 * matter:
 *
 *   DYNAMIC     — the server's own words reach the screen on BOTH arrival
 *                 paths. Soft nav (`<Navigate state>` from ProtectedRoute) and
 *                 hard nav (`window.location.replace` from HttpClient, which
 *                 destroys router state and hands over via sessionStorage).
 *                 Before this, four of the eight screens could only ever show
 *                 hardcoded copy.
 *   RELIABLE    — a malformed, empty, or hostile payload degrades to the
 *                 fallback and NEVER crashes. An error page that white-screens
 *                 is the worst possible failure.
 *   CONSISTENT  — all eight screens resolve copy the same way, in the same
 *                 priority order, including the one that used to hardcode it.
 *   ACCURATE    — a payload stashed for one status never captions another, and
 *                 a consumed payload never reappears.
 */
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetServerStatusForTests } from "../../../src/utils/serverStatus.js";
import { renderWithProviders } from "../../helpers/renderWithProviders.jsx";
import { ERROR_PAGE_PAYLOAD_KEY, consumeErrorPagePayload, handOffErrorPagePayload, resetErrorPagePayloadCache, stashErrorPagePayload } from "../../../src/utils/storage.js";
import { BadRequest, InvalidToken, LoginTimeOut, PageNotFound, ServiceUnavailable, SignatureMismatch, TooManyRequests, Unauthorized } from "../../../src/views/errors/ClientErrorResponses.jsx";

/** Every screen, with the status it renders for and its own fallback headline. */
const PAGES = [
    { name: "BadRequest", code: 400, Component: BadRequest, fallbackTitle: "You said what now?" },
    { name: "Unauthorized", code: 401, Component: Unauthorized, fallbackTitle: "Access denied." },
    { name: "PageNotFound", code: 404, Component: PageNotFound, fallbackTitle: "Lost in the void." },
    { name: "SignatureMismatch", code: 422, Component: SignatureMismatch, fallbackTitle: "The seal has been broken." },
    { name: "TooManyRequests", code: 429, Component: TooManyRequests, fallbackTitle: "Easy there — too many requests." },
    { name: "LoginTimeOut", code: 440, Component: LoginTimeOut, fallbackTitle: "Time stole your session." },
    { name: "InvalidToken", code: 498, Component: InvalidToken, fallbackTitle: "Token corrupted." },
    { name: "ServiceUnavailable", code: 523, Component: ServiceUnavailable, fallbackTitle: "The server is napping." },
];

/** Renders a screen with optional router state, mimicking a soft navigation. */
function renderPage(Component, props = {}, state) {
    return renderWithProviders(<Component {...props} />, {
        initialEntries: [{ pathname: "/err", state }],
    });
}

beforeEach(() => {
    _resetServerStatusForTests(); // the 523 page declares an outage on mount
    resetErrorPagePayloadCache();
    sessionStorage.removeItem(ERROR_PAGE_PAYLOAD_KEY);
});

afterEach(() => {
    cleanup();
    _resetServerStatusForTests();
});

describe("useErrorOverrides — SPA hand-off", () => {
    it("after a consumed null payload, handOffErrorPagePayload makes the next mount read the new payload", () => {
        expect(consumeErrorPagePayload()).toBeNull(); // memoised null
        stashErrorPagePayload({ code: 523, title: "Lost", message: "Lost.", requestId: null }); // plain stash: invisible
        expect(consumeErrorPagePayload()).toBeNull();

        handOffErrorPagePayload({ code: 523, title: "Hand-off headline", message: "Hand-off lead.", requestId: null });
        renderPage(ServiceUnavailable);
        expect(screen.getByText("Hand-off headline")).toBeTruthy();
    });
});

describe("useErrorOverrides — DYNAMIC: the server's words reach every screen", () => {
    it.each(PAGES)("$name shows the server title and message handed over by a HARD navigation", ({ code, Component }) => {
        // This is HttpClient's path. `window.location.replace` is a full
        // document load, so `location.state` is null here — the payload is the
        // ONLY channel, and before it existed these screens were mute.
        stashErrorPagePayload({ code, title: "Server headline", message: "Server explanation.", requestId: "req-hard-1", retryAfter: null });

        renderPage(Component);

        expect(screen.getByText("Server headline")).toBeTruthy();
        expect(screen.getByText("Server explanation.")).toBeTruthy();
    });

    it.each(PAGES)("$name shows the server error carried by a SOFT navigation", ({ Component }) => {
        // This is ProtectedRoute's path: <Navigate state={{ _serverError }} />.
        renderPage(Component, {}, { _serverError: { title: "Nav headline", message: "Nav explanation." } });

        expect(screen.getByText("Nav headline")).toBeTruthy();
        expect(screen.getByText("Nav explanation.")).toBeTruthy();
    });

    it("prefers an explicit caller override over the server's own words", () => {
        stashErrorPagePayload({ code: 401, title: "From payload", message: "From payload.", requestId: null });

        renderPage(Unauthorized, {}, { title: "Explicit", subtitle: "Explicit sub.", _serverError: { title: "From nav", message: "From nav." } });

        expect(screen.getByText("Explicit")).toBeTruthy();
        expect(screen.getByText("Explicit sub.")).toBeTruthy();
    });

    it("prefers the soft-nav server error over the stashed payload", () => {
        // Router state is the live navigation; a stashed payload is at best the
        // previous document's. When both exist, the live one wins.
        stashErrorPagePayload({ code: 401, title: "From payload", message: "From payload.", requestId: null });

        renderPage(Unauthorized, {}, { _serverError: { title: "From nav", message: "From nav." } });

        expect(screen.getByText("From nav")).toBeTruthy();
        expect(screen.queryByText("From payload")).toBeNull();
    });

    it("prefers the stashed payload over a route-level prop", () => {
        stashErrorPagePayload({ code: 440, title: "From payload", message: "From payload.", requestId: null });

        renderPage(LoginTimeOut, { title: "From prop", subtitle: "From prop." });

        expect(screen.getByText("From payload")).toBeTruthy();
    });

    it("falls back to the route-level prop when nothing else is available", () => {
        renderPage(LoginTimeOut, { title: "From prop", subtitle: "From prop sub." });

        expect(screen.getByText("From prop")).toBeTruthy();
        expect(screen.getByText("From prop sub.")).toBeTruthy();
    });

    it.each(PAGES)("$name falls back to its own copy when nothing is supplied", ({ Component, fallbackTitle }) => {
        renderPage(Component);
        expect(screen.getByText(fallbackTitle)).toBeTruthy();
    });
});

describe("useErrorOverrides — RELIABLE: bad input degrades, never crashes", () => {
    const HOSTILE = [
        ["an empty string", ""],
        ["a whitespace-only string", "   "],
        ["null", null],
        ["undefined", undefined],
        ["a number", 42],
        ["a boolean", true],
        ["an array", ["a", "b"]],
        ["a plain object", { nested: "value" }],
        ["a nested envelope object", { title: "x", message: "y" }],
    ];

    it.each(HOSTILE)("ignores %s in the stashed title and renders the fallback", (_label, value) => {
        stashErrorPagePayload({ code: 401, title: value, message: value, requestId: null });

        renderPage(Unauthorized);

        // An object reaching JSX throws "Objects are not valid as a React
        // child" and white-screens the one page that must survive a failure.
        expect(screen.getByText("Access denied.")).toBeTruthy();
    });

    it.each(HOSTILE)("ignores %s in router state and renders the fallback", (_label, value) => {
        renderPage(Unauthorized, {}, { title: value, subtitle: value, _serverError: { title: value, message: value } });

        expect(screen.getByText("Access denied.")).toBeTruthy();
    });

    it("survives a payload that is not an object at all", () => {
        sessionStorage.setItem(ERROR_PAGE_PAYLOAD_KEY, JSON.stringify("just a string"));
        resetErrorPagePayloadCache();

        renderPage(Unauthorized);

        expect(screen.getByText("Access denied.")).toBeTruthy();
    });

    it("survives corrupt JSON in the payload slot", () => {
        sessionStorage.setItem(ERROR_PAGE_PAYLOAD_KEY, "{not json");
        resetErrorPagePayloadCache();

        // storage.js swallows the parse error and returns null.
        expect(consumeErrorPagePayload()).toBeNull();

        resetErrorPagePayloadCache();
        renderPage(Unauthorized);
        expect(screen.getByText("Access denied.")).toBeTruthy();
    });

    it("takes a partial payload — title present, message missing — one field at a time", () => {
        stashErrorPagePayload({ code: 401, title: "Only a title", message: null, requestId: null });

        renderPage(Unauthorized);

        // The title is overridden; the subtitle independently falls back.
        expect(screen.getByText("Only a title")).toBeTruthy();
        expect(screen.getByText("You don't have clearance for this zone. Credentials, please.")).toBeTruthy();
    });

    it("renders a long server message without throwing", () => {
        stashErrorPagePayload({ code: 401, title: "T", message: "x".repeat(4000), requestId: null });

        expect(() => renderPage(Unauthorized)).not.toThrow();
    });
});

describe("useErrorOverrides — CONSISTENT: all eight screens behave alike", () => {
    it.each(PAGES)("$name accepts both a prop override and a payload override", ({ code, Component }) => {
        // SignatureMismatch used to hardcode its copy outright and accept
        // neither; it is on the shared resolver now like every sibling.
        renderPage(Component, { title: "Prop title", subtitle: "Prop sub." });
        expect(screen.getByText("Prop title")).toBeTruthy();
        cleanup();

        resetErrorPagePayloadCache();
        stashErrorPagePayload({ code, title: "Payload title", message: "Payload sub.", requestId: null });
        renderPage(Component);
        expect(screen.getByText("Payload title")).toBeTruthy();
    });

    it.each(PAGES)("$name resolves title and subtitle independently", ({ code, Component, fallbackTitle }) => {
        stashErrorPagePayload({ code, title: null, message: "Only a subtitle.", requestId: null });

        renderPage(Component);

        expect(screen.getByText(fallbackTitle)).toBeTruthy();
        expect(screen.getByText("Only a subtitle.")).toBeTruthy();
    });
});

describe("useErrorOverrides — CONSISTENT: the Request ID reaches every screen", () => {
    it.each(PAGES)("$name renders the correlation id the server sent", ({ code, Component }) => {
        // This is the single most useful thing a user can read off an error
        // screen when they contact support. It used to appear on the 429 screen
        // alone, even though every takeover hands one over.
        stashErrorPagePayload({ code, title: null, message: null, requestId: "REQ-VISIBLE-7" });

        renderPage(Component);

        expect(screen.getByText(/REQ-VISIBLE-7/)).toBeTruthy();
    });

    it.each(PAGES)("$name renders no id placeholder when the server sent none", ({ Component }) => {
        // Absent, never a dash or an empty tag — a placeholder reads as data.
        renderPage(Component);
        expect(screen.queryByText(/Request ID/i)).toBeNull();
    });

    it("takes the request id from a soft navigation too", () => {
        renderPage(Unauthorized, {}, { _serverError: { title: "T", message: "M", requestId: "REQ-SOFT-3" } });
        expect(screen.getByText(/REQ-SOFT-3/)).toBeTruthy();
    });
});

describe("useErrorOverrides — ACCURATE: the right message, once", () => {
    it("ignores a payload stashed for a DIFFERENT status", () => {
        // Within one document a soft navigation between error screens would
        // otherwise caption a 440 with the message stashed for a 503.
        stashErrorPagePayload({ code: 523, title: "Outage headline", message: "The origin is down.", requestId: null });

        renderPage(LoginTimeOut);

        expect(screen.queryByText("Outage headline")).toBeNull();
        expect(screen.getByText("Time stole your session.")).toBeTruthy();
    });

    it("matches the code whether it was stashed as a number or a string", () => {
        stashErrorPagePayload({ code: "440", title: "Stringy code", message: "Still mine.", requestId: null });

        renderPage(LoginTimeOut);

        expect(screen.getByText("Stringy code")).toBeTruthy();
    });

    it("clears the payload from storage as soon as it is read", () => {
        stashErrorPagePayload({ code: 440, title: "One shot", message: "Read once.", requestId: null });

        renderPage(LoginTimeOut);

        expect(sessionStorage.getItem(ERROR_PAGE_PAYLOAD_KEY)).toBeNull();
    });

    it("does not resurrect a consumed payload in a later document", () => {
        stashErrorPagePayload({ code: 440, title: "One shot", message: "Read once.", requestId: null });
        renderPage(LoginTimeOut);
        expect(screen.getByText("One shot")).toBeTruthy();
        cleanup();

        // A later hard navigation = a fresh module, and nothing left in storage.
        resetErrorPagePayloadCache();
        renderPage(LoginTimeOut);

        expect(screen.queryByText("One shot")).toBeNull();
        expect(screen.getByText("Time stole your session.")).toBeTruthy();
    });

    it("serves the SAME payload to every reader on one screen (the StrictMode / multi-reader guard)", () => {
        // The 429 screen reads the payload three times over: headline,
        // countdown, Request ID. Reading CLEARS storage, so without the
        // per-document memo the first reader would win and the rest would get
        // null — and React StrictMode double-invoking the lazy initialiser
        // would hit exactly the same edge.
        stashErrorPagePayload({ code: 429, title: "Slow down", message: "Too many.", requestId: "REQ-MULTI-1", retryAfter: "120" });

        renderPage(TooManyRequests);

        expect(screen.getByText("Slow down")).toBeTruthy();
        expect(screen.getByText("Too many.")).toBeTruthy();
        expect(screen.getByText("2:00")).toBeTruthy();
        expect(screen.getByText(/REQ-MULTI-1/)).toBeTruthy();
    });

    it("keeps the payload stable across re-renders", () => {
        stashErrorPagePayload({ code: 429, title: "Stable", message: "Stays put.", requestId: null, retryAfter: "90" });

        const { rerender } = renderPage(TooManyRequests);
        rerender(<TooManyRequests />);

        // Read in the render body instead of a lazy initialiser, the payload
        // would be consumed on the first render and gone on the next.
        expect(screen.getByText("Stable")).toBeTruthy();
        expect(screen.getByText("Stays put.")).toBeTruthy();
    });
});
