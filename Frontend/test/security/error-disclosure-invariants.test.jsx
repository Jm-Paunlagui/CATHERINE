/**
 * error-disclosure-invariants.test.jsx — Security: internal diagnostics never
 * reach the DOM, and a gone-session status always tears the local credential
 * down while a business-rule status is left inline.
 *
 * Two invariants, one theme — the client must not disclose more than it should,
 * and must not keep a credential the server has repudiated:
 *
 *   INVARIANT 1 (CWE-209, Information Exposure Through an Error Message):
 *   src/components/feedback/ErrorBoundary.jsx, driven for real, must render only
 *   a generic message and (under DEV) `error.message` — NEVER `error.stack`, a
 *   file path, a stack frame, or a "file:line:col" marker. This builds on the
 *   pattern in test/reliability/error-boundary.test.jsx but asserts the
 *   INVARIANT as a security property across several hostile stack shapes.
 *
 *   INVARIANT 2 (session repudiation): src/middleware/HttpClient.js, resolved
 *   through src/constants/httpStatus.js, must — on 440/498 — clear the local
 *   session hint AND the CSRF token (so the app cannot render a signed-in shell
 *   for a user the server has forgotten), while a business-rule status (409)
 *   must leave both intact and stay inline. The session-ending set is read from
 *   the REAL constant, not hard-coded, so a repoint follows automatically.
 *
 * MSW is the only network boundary; `onUnhandledRequest: "error"` (setup.js)
 * fails any un-stubbed request. The two unavoidable seams are jsdom's
 * [Unforgeable] `window.location` (spied via HttpClient._navigate) and React's
 * own console.error on a caught render error (scoped and restored per test).
 *
 * CONSOLE HYGIENE: React calls console.error for every error an error boundary
 * catches — its own default onCaughtError, not this repo's code — and
 * clientLogger echoes under DEV. Every test that deliberately throws scopes a
 * console.error spy for exactly that render and restores it after the async
 * round trip settles. That is understood noise being silenced; no assertion
 * depends on console output.
 */

import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorBoundary } from "../../src/components/feedback/ErrorBoundary.jsx";
import { SESSION_ENDING_STATUSES, TAKEOVER_ROUTE_BY_STATUS } from "../../src/constants/httpStatus.js";
import httpClient from "../../src/middleware/HttpClient.js";
import csrfMiddleware from "../../src/middleware/security/CsrfMiddleware.js";
import { fail, ok } from "../helpers/fixtures/contract.js";
import { apiUrl } from "../helpers/msw/api.js";
import { server } from "../helpers/msw/server.js";
import { renderWithProviders } from "../helpers/renderWithProviders.jsx";

const GENERIC_TITLE = "Something went wrong";

/**
 * Throws an error whose `.stack` carries deterministic, easy-to-recognise
 * internal markers — a file path, a stack frame, a line:column marker — none of
 * which may reach the DOM.
 */
function StackyBomb({ file = "SecretInternalModule.jsx", line = 42, col = 17 } = {}) {
    const err = new Error("Cannot read properties of undefined (reading 'secret')");
    err.stack = [`Error: Cannot read properties of undefined (reading 'secret')`, `    at StackyBomb (/src/features/internal/${file}:${line}:${col})`, `    at renderWithHooks (react-dom.development.js:1234:18)`].join("\n");
    throw err;
}

/** Stub `client/errors` so componentDidCatch's async round trip settles deterministically. */
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

describe("error disclosure invariant — no internal diagnostics reach the DOM (CWE-209)", () => {
    it("renders only the generic message; file paths, stack frames and line:column markers NEVER appear", async () => {
        const getHits = installClientErrorsHandler();
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        renderWithProviders(
            <ErrorBoundary>
                <StackyBomb />
            </ErrorBoundary>,
        );

        expect(await screen.findByText(GENERIC_TITLE)).toBeInTheDocument();

        // The dev-only block may render error.message and ONLY error.message.
        if (import.meta.env.DEV) {
            expect(screen.getByText(/Cannot read properties of undefined/i)).toBeInTheDocument();
        } else {
            expect(screen.queryByText(/Cannot read properties of undefined/i)).not.toBeInTheDocument();
        }

        // Nothing stack-shaped may leak, in either build mode.
        const body = document.body.textContent;
        expect(body).not.toMatch(/SecretInternalModule\.jsx/);
        expect(body).not.toMatch(/at StackyBomb/);
        expect(body).not.toMatch(/renderWithHooks/);
        expect(body).not.toMatch(/react-dom\.development\.js/);
        expect(body).not.toMatch(/\/src\/features\//);
        // No "file:line:col)" frame text anywhere in the rendered output.
        expect(body).not.toMatch(/:\d+:\d+\)/);

        await waitFor(() => expect(getHits()).toBe(1));
        errSpy.mockRestore();
    });

    it.each([
        ["a Windows-style absolute path", { file: "C:\\app\\src\\secret\\Vault.jsx", line: 8, col: 3 }],
        ["a deep POSIX path", { file: "deeply/nested/private/Keys.jsx", line: 900, col: 12 }],
    ])("keeps %s out of the DOM", async (_label, shape) => {
        const getHits = installClientErrorsHandler();
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        renderWithProviders(
            <ErrorBoundary>
                <StackyBomb {...shape} />
            </ErrorBoundary>,
        );

        expect(await screen.findByText(GENERIC_TITLE)).toBeInTheDocument();

        const body = document.body.textContent;
        expect(body).not.toContain(shape.file);
        expect(body).not.toMatch(/Vault\.jsx|Keys\.jsx/);
        expect(body).not.toMatch(/:\d+:\d+\)/);

        await waitFor(() => expect(getHits()).toBe(1));
        errSpy.mockRestore();
    });
});

describe("session repudiation invariant — 440/498 tear down the local credential", () => {
    let navigate;

    beforeEach(async () => {
        navigate = vi.spyOn(httpClient, "_navigate").mockImplementation(() => {});
        localStorage.setItem("user_session", "1");
        // Clear FIRST — the singleton persists `_isInitialized` across tests, so
        // without this `ensureTokenReady()` returns whatever token a prior test
        // left cached instead of fetching the distinctive "live-token" below.
        csrfMiddleware.clearToken();
        // Seed a real in-memory token so a later clear is observable.
        server.use(http.get(apiUrl("csrf/token"), () => HttpResponse.json({ success: true, token: "live-token", expiresIn: 3_600_000, expiresAt: new Date(Date.now() + 3_600_000).toISOString() })));
        await csrfMiddleware.ensureTokenReady();
    });

    afterEach(() => {
        navigate.mockRestore();
        localStorage.clear();
        csrfMiddleware.clearToken();
        vi.restoreAllMocks();
    });

    it.each([...SESSION_ENDING_STATUSES])("status %i clears user_session AND the CSRF token, then takes over", async (status) => {
        expect(csrfMiddleware.getToken()).toBe("live-token");
        const expectedRoute = TAKEOVER_ROUTE_BY_STATUS[status];
        expect(expectedRoute).toEqual(expect.any(String));

        const path = `probe/session-${status}`;
        server.use(http.get(apiUrl(path), () => HttpResponse.json(fail(`synthetic ${status}`, status, { type: "AuthenticationError" }), { status })));

        await expect(httpClient.get(path)).rejects.toMatchObject({ response: { status } });

        // The repudiated credential is gone — no signed-in shell can render.
        expect(localStorage.getItem("user_session")).toBeNull();
        expect(csrfMiddleware.getToken()).toBeNull();
        expect(navigate).toHaveBeenCalledWith(expectedRoute);
    });

    it("a business-rule 409 leaves the session and CSRF token intact and stays inline — no takeover, no teardown", async () => {
        expect(csrfMiddleware.getToken()).toBe("live-token");

        server.use(http.get(apiUrl("probe/conflict"), () => HttpResponse.json(fail("Already exists.", 409, { type: "ConflictError" }), { status: 409 })));

        await expect(httpClient.get("probe/conflict")).rejects.toMatchObject({ response: { status: 409 } });

        // A recoverable business outcome must not destroy the session.
        expect(localStorage.getItem("user_session")).toBe("1");
        expect(csrfMiddleware.getToken()).toBe("live-token");
        expect(navigate).not.toHaveBeenCalled();
    });
});
