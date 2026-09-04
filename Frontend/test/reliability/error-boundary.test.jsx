/**
 * error-boundary.test.jsx — Reliability: does a render-phase crash stay
 * contained?
 *
 * Subject: src/components/feedback/ErrorBoundary.jsx, driven for real — the
 * boundary's own `getDerivedStateFromError` / `componentDidCatch`, the REAL
 * `clientLogger` (src/utils/clientLogger.js), the REAL `HttpClient`, and the
 * REAL `RequestIdTag`. MSW is the only mocking boundary; nothing the repo owns
 * is stubbed, because the thing under test IS the wiring between those parts.
 *
 * Covered, unhappy path first:
 *   1. A child that throws during render is caught — siblings OUTSIDE the
 *      boundary keep rendering (the concrete meaning of "no white screen").
 *   2. No stack-trace text ever reaches the DOM (CWE-209): file paths, "at
 *      <Component>" frames and line:column markers never render. Only
 *      `error.message` may, and only under `import.meta.env.DEV`, exactly as
 *      the source implements it.
 *   3. The Request ID surfaces both ways — synchronously when the error already
 *      carries one (attached by HttpClient's response interceptor) and
 *      asynchronously via clientLogger's `POST client/errors` round trip when
 *      it does not.
 *   4. clientLogger's OWN failure does not produce a second crash.
 *   5. "Try again" resets the boundary; a custom `fallback` is honoured.
 *
 * CONSOLE HYGIENE: React itself calls `console.error` for every error caught by
 * an error boundary — that is React's own default `onCaughtError`, not
 * something this repo controls — and `clientLogger.error()` adds its own
 * `console.error("[ClientLogger]", …)` echo under DEV. Every test that
 * deliberately throws scopes a `vi.spyOn(console, "error")` for exactly that
 * render and restores it immediately after the async round trip has settled.
 * That is understood noise being silenced, not evidence being hidden — the
 * assertions below never depend on console output.
 */

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ErrorBoundary } from "../../src/components/feedback/ErrorBoundary.jsx";
import { ok } from "../helpers/fixtures/contract.js";
import { apiUrl } from "../helpers/msw/api.js";
import { server } from "../helpers/msw/server.js";
import { renderWithProviders } from "../helpers/renderWithProviders.jsx";

const GENERIC_TITLE = "Something went wrong";
const GENERIC_BODY = /An unexpected error occurred\. Refresh the page or contact support if it persists\./i;

/** Unconditionally throws during render. */
function Bomb({ message = "Boom" }) {
    throw new Error(message);
}

/**
 * Throws only while `switchBox.armed` is true, so a test can disarm it between
 * the crash and the "Try again" click. A plain object (not a React ref, not
 * state) is the whole mechanism: the boundary re-renders children from its own
 * setState, and a state update owned by the test would not be visible to it.
 */
function FlakyBomb({ switchBox, message = "Boom" }) {
    if (switchBox.armed) throw new Error(message);
    return <div>Recovered content</div>;
}

/** Throws an error whose `.stack` carries deterministic, easy-to-recognise markers. */
function StackyBomb() {
    const err = new Error("Cannot read properties of undefined (reading 'foo')");
    err.stack = ["Error: Cannot read properties of undefined (reading 'foo')", "    at StackyBomb (/src/features/secret/SecretInternalModule.jsx:42:17)", "    at renderWithHooks (react-dom.development.js:1234:18)"].join("\n");
    throw err;
}

/**
 * Stub the endpoint `clientLogger` posts to and expose a hit counter, so tests
 * can wait for the round trip to settle deterministically instead of guessing
 * at tick counts.
 * @returns {() => number} current hit count
 */
function installClientErrorsHandler() {
    let hits = 0;
    server.use(
        http.post(apiUrl("client/errors"), () => {
            hits += 1;
            return HttpResponse.json(ok("Error logged.", { received: true }));
        }),
    );
    return () => hits;
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("ErrorBoundary — happy path", () => {
    it("renders its children unmodified when nothing throws", () => {
        renderWithProviders(
            <ErrorBoundary>
                <div>Safe content</div>
            </ErrorBoundary>,
        );

        expect(screen.getByText("Safe content")).toBeInTheDocument();
        expect(screen.queryByText(GENERIC_TITLE)).not.toBeInTheDocument();
    });
});

describe("ErrorBoundary — a render-phase crash is caught (unhappy path)", () => {
    it("catches the throw, shows the generic fallback message, and does NOT take down the rest of the tree", async () => {
        const getHits = installClientErrorsHandler();
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        renderWithProviders(
            <div>
                <div>Sibling still alive</div>
                <ErrorBoundary>
                    <Bomb message="Widget crashed" />
                </ErrorBoundary>
            </div>,
        );

        expect(await screen.findByText(GENERIC_TITLE)).toBeInTheDocument();
        expect(screen.getByText(GENERIC_BODY)).toBeInTheDocument();
        // The boundary contains the crash — content OUTSIDE it is unaffected.
        expect(screen.getByText("Sibling still alive")).toBeInTheDocument();

        // Let componentDidCatch's async clientLogger round trip fully settle
        // BEFORE restoring the console spy — its dev-mode echo fires only once
        // the request resolves, and would otherwise leak a real console.error
        // after the spy is gone.
        await waitFor(() => expect(getHits()).toBe(1));
        errSpy.mockRestore();
    });

    it("does not leak stack-trace text into the DOM (CWE-209) — file paths, stack frames, and line:column markers never render", async () => {
        const getHits = installClientErrorsHandler();
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        renderWithProviders(
            <ErrorBoundary>
                <StackyBomb />
            </ErrorBoundary>,
        );

        expect(await screen.findByText(GENERIC_TITLE)).toBeInTheDocument();

        // The dev-only block renders error.message — never error.stack. Assert
        // that ONLY the message may appear, and that stack-only markers never
        // do, in either build mode.
        if (import.meta.env.DEV) {
            expect(screen.getByText(/Cannot read properties of undefined/i)).toBeInTheDocument();
        } else {
            expect(screen.queryByText(/Cannot read properties of undefined/i)).not.toBeInTheDocument();
        }
        expect(screen.queryByText(/SecretInternalModule\.jsx/)).not.toBeInTheDocument();
        expect(screen.queryByText(/at StackyBomb/)).not.toBeInTheDocument();
        expect(screen.queryByText(/renderWithHooks/)).not.toBeInTheDocument();
        expect(screen.queryByText(/react-dom\.development\.js/)).not.toBeInTheDocument();
        // Belt and braces: no stack-frame-shaped "file:line:col)" text anywhere.
        expect(document.body.textContent).not.toMatch(/:\d+:\d+\)/);

        await waitFor(() => expect(getHits()).toBe(1));
        errSpy.mockRestore();
    });

    // The stack must still reach the SERVER — suppressing it in the DOM is only
    // half the contract; an audit trail with no diagnostics is useless.
    it("still ships the message, stack and componentStack to the backend even though none of it renders", async () => {
        let body = null;
        server.use(
            http.post(apiUrl("client/errors"), async ({ request }) => {
                body = await request.json();
                return HttpResponse.json(ok("Error logged.", { received: true }));
            }),
        );
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        renderWithProviders(
            <ErrorBoundary>
                <StackyBomb />
            </ErrorBoundary>,
        );

        expect(await screen.findByText(GENERIC_TITLE)).toBeInTheDocument();
        await waitFor(() => expect(body).not.toBeNull());

        expect(body.message).toBe("Cannot read properties of undefined (reading 'foo')");
        expect(body.stack).toContain("SecretInternalModule.jsx");
        expect(typeof body.componentStack).toBe("string");

        errSpy.mockRestore();
    });
});

describe("ErrorBoundary — Request ID surfacing", () => {
    it("surfaces the server-assigned Request ID once clientLogger's POST client/errors round trip resolves", async () => {
        const getHits = installClientErrorsHandler();
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        renderWithProviders(
            <ErrorBoundary>
                <Bomb />
            </ErrorBoundary>,
        );

        expect(await screen.findByText(GENERIC_TITLE)).toBeInTheDocument();

        // This error carries no pre-existing requestId, so the tag can only
        // appear once the async POST resolves and componentDidCatch's .then()
        // calls setState. `findByText` IS the wait — no assumption is made
        // about how many ticks that takes relative to the first paint.
        expect(await screen.findByText(/Request ID: test-req-\d+/i)).toBeInTheDocument();
        expect(getHits()).toBe(1);

        errSpy.mockRestore();
    });

    it("preserves an error's PRE-EXISTING requestId (as propagated from a failed HttpClient call) instead of waiting for clientLogger", async () => {
        const getHits = installClientErrorsHandler();
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        function BombWithRequestId() {
            const err = new Error("Save failed");
            err.requestId = "existing-req-999";
            throw err;
        }

        renderWithProviders(
            <ErrorBoundary>
                <BombWithRequestId />
            </ErrorBoundary>,
        );

        // getDerivedStateFromError runs synchronously in the render phase — the
        // pre-existing requestId is visible on first paint, no round trip.
        expect(await screen.findByText(/Request ID: existing-req-999/i)).toBeInTheDocument();

        // clientLogger.error() still fires unconditionally from
        // componentDidCatch (for the audit trail), but the `!this.state.requestId`
        // guard must stop it overwriting the ID already on screen.
        await waitFor(() => expect(getHits()).toBe(1));
        expect(screen.getByText(/Request ID: existing-req-999/i)).toBeInTheDocument();

        errSpy.mockRestore();
    });

    it("never crashes a second time when clientLogger's own POST fails — the fallback UI still works, just without a Request ID", async () => {
        let hits = 0;
        server.use(
            http.post(apiUrl("client/errors"), () => {
                hits += 1;
                return new HttpResponse(null, { status: 500 });
            }),
        );
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        renderWithProviders(
            <ErrorBoundary>
                <Bomb />
            </ErrorBoundary>,
        );

        expect(await screen.findByText(GENERIC_TITLE)).toBeInTheDocument();
        // Deterministically wait for the failed round trip to settle (its own
        // catch swallows the rejection — it never throws) before asserting on
        // the absence of the tag.
        await waitFor(() => expect(hits).toBe(1));
        expect(screen.queryByText(/Request ID:/i)).not.toBeInTheDocument();
        // The rest of the fallback (title, body, Try again) is still intact.
        expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();

        errSpy.mockRestore();
    });
});

describe("ErrorBoundary — reset + customisation", () => {
    it('"Try again" resets the boundary and re-renders fresh children', async () => {
        const getHits = installClientErrorsHandler();
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const user = userEvent.setup();
        const switchBox = { armed: true };

        renderWithProviders(
            <ErrorBoundary>
                <FlakyBomb switchBox={switchBox} />
            </ErrorBoundary>,
        );

        expect(await screen.findByText(GENERIC_TITLE)).toBeInTheDocument();
        await waitFor(() => expect(getHits()).toBe(1));

        // Fix the underlying condition (as a real refresh would once the
        // transient cause is gone), then click Try again.
        switchBox.armed = false;
        await user.click(screen.getByRole("button", { name: "Try again" }));

        expect(await screen.findByText("Recovered content")).toBeInTheDocument();
        expect(screen.queryByText(GENERIC_TITLE)).not.toBeInTheDocument();

        errSpy.mockRestore();
    });

    it("re-catches instead of white-screening when the underlying cause has NOT gone away", async () => {
        const getHits = installClientErrorsHandler();
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const user = userEvent.setup();
        const switchBox = { armed: true };

        renderWithProviders(
            <ErrorBoundary>
                <FlakyBomb switchBox={switchBox} />
            </ErrorBoundary>,
        );

        expect(await screen.findByText(GENERIC_TITLE)).toBeInTheDocument();
        await waitFor(() => expect(getHits()).toBe(1));

        // Still broken — retrying must land back on the fallback, not on a
        // blank document.
        await user.click(screen.getByRole("button", { name: "Try again" }));

        expect(await screen.findByText(GENERIC_TITLE)).toBeInTheDocument();
        await waitFor(() => expect(getHits()).toBe(2));

        errSpy.mockRestore();
    });

    it("honours a custom `fallback` prop instead of the default UI", async () => {
        // componentDidCatch (and therefore POST client/errors) still fires even
        // though the custom fallback overrides what is rendered — a handler is
        // required here too, or the request is an unhandled MSW request.
        const getHits = installClientErrorsHandler();
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        renderWithProviders(
            <ErrorBoundary fallback={<p>Custom fallback text</p>}>
                <Bomb />
            </ErrorBoundary>,
        );

        expect(screen.getByText("Custom fallback text")).toBeInTheDocument();
        expect(screen.queryByText(GENERIC_TITLE)).not.toBeInTheDocument();

        await waitFor(() => expect(getHits()).toBe(1));
        errSpy.mockRestore();
    });
});
