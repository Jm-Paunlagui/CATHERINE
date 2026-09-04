/**
 * network-failure-contained.test.jsx — Chaos: a network failure on a
 * non-critical fetch degrades gracefully. No white screen, no uncaught
 * rejection, no second crash.
 *
 * Subject: src/utils/clientLogger.js and src/middleware/HttpClient.js driven for
 * real, plus src/components/feedback/ErrorBoundary.jsx as the containment shell
 * (built on the reliability/error-boundary.test.jsx patterns). MSW is the only
 * mocking boundary; the failure is INJECTED at the network and the assertion is
 * that the production code absorbs it.
 *
 * A chaos test injects a fault and asserts the system stays up. Here the fault
 * is the network itself failing under a request the app does not strictly need
 * to succeed — the error-logging round trip, and an arbitrary feature GET. The
 * contract is graceful degradation: the caller gets a rejection it can handle,
 * the process gets no unhandled rejection, and any UI stays mounted.
 *
 * CONSOLE HYGIENE: paths that route through ErrorBoundary make React itself call
 * console.error, and clientLogger echoes under DEV. Each such test scopes a
 * console.error spy for the duration of the awaited settle and restores it after
 * — understood noise, never an assertion target.
 *
 * Covered:
 *   1. A network error on POST client/errors is contained by clientLogger — it
 *      resolves to null rather than rejecting, so componentDidCatch never sees a
 *      second throw.
 *   2. An ErrorBoundary whose async logging round trip network-fails still shows
 *      its fallback UI and never white-screens — the crash is contained even
 *      when the containment machinery's OWN network call fails.
 *   3. A network error on an ordinary feature GET rejects the caller cleanly
 *      (no unhandled rejection), leaving surrounding state intact.
 */

import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorBoundary } from "../../src/components/feedback/ErrorBoundary.jsx";
import clientLogger from "../../src/utils/clientLogger.js";
import httpClient from "../../src/middleware/HttpClient.js";
import { apiUrl } from "../helpers/msw/api.js";
import { server } from "../helpers/msw/server.js";
import { renderWithProviders } from "../helpers/renderWithProviders.jsx";

const GENERIC_TITLE = "Something went wrong";

/** Unconditionally throws during render — the injected render-phase fault. */
function Bomb({ message = "Boom" }) {
    throw new Error(message);
}

beforeEach(() => {
    localStorage.clear();
});

afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
});

describe("Chaos — a network failure on a non-critical fetch is contained", () => {
    it("clientLogger absorbs a network error and resolves to null instead of rejecting", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        let hits = 0;
        server.use(
            http.post(apiUrl("client/errors"), () => {
                hits += 1;
                return HttpResponse.error();
            }),
        );

        // The logger's whole contract under failure: never throw. A rejection
        // here would propagate straight out of componentDidCatch.
        await expect(clientLogger.error(new Error("contained"))).resolves.toBeNull();
        expect(hits).toBe(1);

        errSpy.mockRestore();
    });

    it("keeps the ErrorBoundary fallback on screen even when its OWN logging round trip network-fails — no white screen", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        let hits = 0;
        server.use(
            http.post(apiUrl("client/errors"), () => {
                hits += 1;
                return HttpResponse.error();
            }),
        );

        renderWithProviders(
            <div>
                <div>Sibling still alive</div>
                <ErrorBoundary>
                    <Bomb message="Widget crashed" />
                </ErrorBoundary>
            </div>,
        );

        // The crash is caught and the fallback shows despite the failing logger.
        expect(await screen.findByText(GENERIC_TITLE)).toBeInTheDocument();
        // Content outside the boundary is untouched — the fault is contained.
        expect(screen.getByText("Sibling still alive")).toBeInTheDocument();

        // Let the failed logging round trip settle (its own catch swallows the
        // rejection) before restoring the spy.
        await waitFor(() => expect(hits).toBe(1));
        // No Request ID surfaced because the report never reached the server —
        // graceful degradation, not a crash.
        expect(screen.queryByText(/Request ID:/i)).not.toBeInTheDocument();

        errSpy.mockRestore();
    });

    it("rejects an ordinary feature GET cleanly on a network error — the caller's catch handles it, no unhandled rejection", async () => {
        server.use(http.get(apiUrl("widgets"), () => HttpResponse.error()));

        // A rejection the caller can await is the graceful outcome; an
        // unhandled rejection would surface as a process-level warning/failure.
        let caught = null;
        try {
            await httpClient.get("widgets");
        } catch (err) {
            caught = err;
        }

        expect(caught).not.toBeNull();
        // A transport failure has no HTTP response — the caller sees a network
        // error object, not a phantom status.
        expect(caught.response).toBeUndefined();
    });
});
