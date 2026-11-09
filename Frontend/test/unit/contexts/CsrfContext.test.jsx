/**
 * CsrfContext.test.jsx — CsrfProvider's loading / error / initialized states.
 *
 * CsrfProvider is what main.jsx's CsrfGate reads to decide whether the app
 * boots at all. Its three observable states — loading, error, initialized —
 * are a security control, not a spinner: if `error` never renders, the gate
 * hangs on <LoadingScreen /> forever; if `isInitialized` is reported true with
 * a null token, every state-changing request afterwards ships without CSRF.
 *
 * Everything here is asserted through RENDERED OUTPUT of a probe component
 * that prints the context value. The middleware underneath is the REAL
 * singleton and the network boundary is MSW — nothing is mocked and no
 * assertion claims a mock was called.
 *
 * Not using renderWithProviders(): that helper mounts CsrfProvider as part of
 * the full chain, which is exactly the subject under test here. It is used by
 * the rest of the suite and is not rebuilt — this file renders the provider
 * directly so it can drive the failure arms the app chain never reaches.
 */
import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CsrfProvider, useCsrf } from "../../../src/contexts/security/CsrfContext.jsx";
import csrfMiddleware from "../../../src/middleware/security/CsrfMiddleware";
import { apiUrl } from "../../helpers/msw/api.js";
import { TEST_CSRF_TOKEN } from "../../helpers/msw/handlers/csrf.handlers.js";
import { server } from "../../helpers/msw/server.js";

const HOUR_MS = 60 * 60 * 1000;

function tokenBody(token, overrides = {}) {
    return {
        success: true,
        token,
        expiresIn: HOUR_MS,
        expiresAt: new Date(Date.now() + HOUR_MS).toISOString(),
        refreshIn: HOUR_MS,
        ...overrides,
    };
}

/** Prints the whole context value so assertions read rendered DOM, not internals. */
function CsrfProbe() {
    const { csrfToken, loading, error, isInitialized, refreshToken, clearToken, manager } = useCsrf();
    return (
        <div>
            <output data-testid="token">{csrfToken ?? "(none)"}</output>
            <output data-testid="loading">{String(loading)}</output>
            <output data-testid="error">{error ?? "(no error)"}</output>
            <output data-testid="initialized">{String(isInitialized)}</output>
            {/* Identity only — NOT manager.getToken(). A live call here is
                memoised by the react-compiler transform (its only input,
                `manager`, is a stable singleton), so it would freeze on the
                first render's value. Middleware state is asserted directly
                against the singleton instead. */}
            <output data-testid="manager">{manager === csrfMiddleware ? "singleton" : "other"}</output>
            <button type="button" onClick={refreshToken}>
                Refresh
            </button>
            <button type="button" onClick={clearToken}>
                Clear
            </button>
        </div>
    );
}

function renderProvider() {
    return render(
        <CsrfProvider>
            <CsrfProbe />
        </CsrfProvider>,
    );
}

const token = () => screen.getByTestId("token").textContent;
const loading = () => screen.getByTestId("loading").textContent;
const error = () => screen.getByTestId("error").textContent;
const initialized = () => screen.getByTestId("initialized").textContent;

beforeEach(() => {
    // The shared HttpClient singleton fires a csrf/token fetch at import time;
    // clear so every test starts from a genuinely uninitialized provider.
    csrfMiddleware.clearToken();
    csrfMiddleware._retryDelay = 1;
});

describe("CsrfProvider — bootstrap failure (unhappy path first)", () => {
    it("surfaces the failure as a rendered error string and stops loading, so CsrfGate can leave the spinner", async () => {
        server.use(http.get(apiUrl("csrf/token"), () => HttpResponse.json({ success: false, message: "secret cookie missing" }, { status: 503 })));

        renderProvider();

        await waitFor(() => expect(loading()).toBe("false"));

        expect(error()).toMatch(/CSRF fetch failed after 4 attempts/);
        expect(token()).toBe("(none)");
        // Critically: NOT initialized. Reporting true here with a null token
        // would let every later mutation ship without a CSRF header.
        expect(initialized()).toBe("false");
        expect(csrfMiddleware.getToken()).toBeNull();
    });

    it("keeps children mounted through the failure — the provider degrades, it does not blank the tree", async () => {
        server.use(http.get(apiUrl("csrf/token"), () => HttpResponse.error()));

        renderProvider();

        await waitFor(() => expect(loading()).toBe("false"));
        expect(screen.getByTestId("token")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    });
});

describe("CsrfProvider — bootstrap success", () => {
    it("reports loading first, then publishes the token and flips isInitialized with no error", async () => {
        renderProvider();

        // First committed render is the loading state, before init resolves.
        expect(loading()).toBe("true");
        expect(token()).toBe("(none)");
        expect(initialized()).toBe("false");

        await waitFor(() => expect(initialized()).toBe("true"));

        expect(token()).toBe(TEST_CSRF_TOKEN);
        expect(loading()).toBe("false");
        expect(error()).toBe("(no error)");
    });

    it("initializes exactly once under React StrictMode's double-invoked effects", async () => {
        let hits = 0;
        server.use(
            http.get(apiUrl("csrf/token"), () => {
                hits += 1;
                return HttpResponse.json(tokenBody("strict-mode-token"));
            }),
        );

        render(
            <StrictMode>
                <CsrfProvider>
                    <CsrfProbe />
                </CsrfProvider>
            </StrictMode>,
        );

        await waitFor(() => expect(token()).toBe("strict-mode-token"));
        expect(hits).toBe(1);
    });

    it("republishes a token rotated by the middleware itself (scheduled auto-refresh), keeping the view in step", async () => {
        renderProvider();
        await waitFor(() => expect(initialized()).toBe("true"));

        server.use(http.post(apiUrl("csrf/refresh"), () => HttpResponse.json(tokenBody("rotated-behind-the-context"))));

        // Rotation driven through the middleware, not the context: this is the
        // subscription arm, which only runs once isInitialized is true.
        await csrfMiddleware.forceRefresh();

        await waitFor(() => expect(token()).toBe("rotated-behind-the-context"));
    });

    it("catches a rotation that lands between init resolving and the listener attaching (no notify is ever replayed)", async () => {
        // Deterministic replay of the full-suite race: init hands the context
        // token A, but by the time the subscription effect runs the middleware
        // already holds B — its notify fired while no listener existed.
        const spy = vi.spyOn(csrfMiddleware, "initialize").mockImplementation(async () => {
            csrfMiddleware._token = "rotated-in-the-gap";
            csrfMiddleware._isInitialized = true;
            return "stale-init-token";
        });
        try {
            renderProvider();
            await waitFor(() => expect(initialized()).toBe("true"));
            await waitFor(() => expect(token()).toBe("rotated-in-the-gap"));
        } finally {
            spy.mockRestore();
        }
    });
});

describe("CsrfProvider — refreshToken()", () => {
    it("publishes the rotated token to consumers and clears the loading flag", async () => {
        renderProvider();
        await waitFor(() => expect(initialized()).toBe("true"));

        server.use(http.post(apiUrl("csrf/refresh"), () => HttpResponse.json(tokenBody("user-triggered-rotation"))));

        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Refresh" }));

        await waitFor(() => expect(token()).toBe("user-triggered-rotation"));
        expect(loading()).toBe("false");
        expect(error()).toBe("(no error)");
    });

    it("renders the error when BOTH the refresh POST and its GET fallback fail, and does not fabricate a token", async () => {
        renderProvider();
        await waitFor(() => expect(initialized()).toBe("true"));

        server.use(
            http.post(apiUrl("csrf/refresh"), () => HttpResponse.json({ success: false, message: "rotation refused" }, { status: 500 })),
            http.get(apiUrl("csrf/token"), () => HttpResponse.json({ success: false, message: "issuance refused" }, { status: 500 })),
        );

        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Refresh" }));

        await waitFor(() => expect(error()).toMatch(/CSRF fetch failed after 4 attempts/));
        expect(loading()).toBe("false");
        // The previously issued token is still what is published — the failed
        // rotation neither replaced it with a bogus value nor silently nulled it.
        expect(token()).toBe(TEST_CSRF_TOKEN);
    });
});

describe("CsrfProvider — clearToken() (logout)", () => {
    it("drops the token from both the context and the middleware, and re-arms bootstrap", async () => {
        renderProvider();
        await waitFor(() => expect(initialized()).toBe("true"));
        expect(screen.getByTestId("manager").textContent).toBe("singleton");
        expect(csrfMiddleware.getToken()).toBe(TEST_CSRF_TOKEN);

        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Clear" }));

        await waitFor(() => expect(token()).toBe("(none)"));
        expect(initialized()).toBe("false");
        expect(csrfMiddleware.getToken()).toBeNull();
        expect(csrfMiddleware.isInitialized).toBe(false);
    });
});

describe("useCsrf() — provider guard", () => {
    it("throws a named error rather than returning null when used outside CsrfProvider", () => {
        // React logs the thrown render error; silence only that noise.
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        expect(() => render(<CsrfProbe />)).toThrow("useCsrf must be used within CsrfProvider");

        consoleErrorSpy.mockRestore();
    });
});
