/**
 * auth-login-flow.test.jsx — Integration: does a sign-in drive the WHOLE real
 * stack — hook → api → HttpClient → CsrfMiddleware → CsrfContext — end to end,
 * with MSW faking only the network?
 *
 * Subject, all driven for real, nothing repo-owned stubbed:
 *   • src/features/auth/auth.hook.js   (useAuth.login state machine)
 *   • src/features/auth/auth.api.js    (the POST auth/login call)
 *   • src/middleware/HttpClient.js     (request interceptor: CSRF injection,
 *                                       X-Client-Username traceability)
 *   • src/middleware/security/CsrfMiddleware.js (token lifecycle singleton)
 *   • src/contexts/security/CsrfContext.jsx     (boot-time token bootstrap)
 *   • src/middleware/authentication/AuthMiddleware.js (session hint + cache)
 *
 * The point of an INTEGRATION suite (versus the unit hook tests) is that no
 * seam between those modules is mocked. The CSRF token the login POST carries
 * is the one CsrfProvider actually bootstrapped from `GET csrf/token`; the
 * session hint the middleware writes is the one a later request would read.
 * MSW is the single network boundary — `onUnhandledRequest: "error"` (set in
 * test/helpers/setup.js) turns any request the suite forgot to stub into a
 * loud failure rather than a silent pass-through to a real backend.
 *
 * `renderHook` is wrapped in `renderWithProviders`' full provider chain via a
 * thin adapter (RTL's `renderHook` takes a `wrapper`, and our helper already
 * assembles Router → Theme → Csrf → Layout → Version). That gives `useAuth`
 * the `useNavigate()` and CSRF context it depends on, exactly as the app wires
 * them in `src/main.jsx`.
 *
 * Covered, unhappy path first:
 *   1. A login POST that the server rejects (401) leaves the hook in an error
 *      state and writes NO session hint — a failed sign-in must not look
 *      signed-in to the next request.
 *   2. A successful login POST carries BOTH the bootstrapped x-csrf-token and a
 *      well-formed X-Client-Username, updates the auth state (loading resolves,
 *      no error), and writes the non-PII session hint AuthMiddleware.isAuth()
 *      later fast-paths on.
 *   3. The credential field mapping the hook documents (form `username` →
 *      backend `userId`) actually reaches the wire.
 *
 * CONSOLE HYGIENE: the login error path surfaces through the hook's own
 * try/catch and toast, not console. No console spy is scoped; a log appearing
 * here would be a real regression, not noise to mute.
 */

import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LayoutProvider } from "../../src/contexts/layout/LayoutContext.jsx";
import { CsrfProvider } from "../../src/contexts/security/CsrfContext.jsx";
import { ThemeProvider } from "../../src/contexts/theme/ThemeContext.jsx";
import { useAuth } from "../../src/features/auth/auth.hook.js";
import AuthMiddleware from "../../src/middleware/authentication/AuthMiddleware.js";
import csrfMiddleware from "../../src/middleware/security/CsrfMiddleware.js";
import { fail, ok } from "../helpers/fixtures/contract.js";
import { apiUrl } from "../helpers/msw/api.js";
import { server } from "../helpers/msw/server.js";

/**
 * A user payload in the shape `AuthService._issueTokens()` decodes into and
 * `GET auth/me` / the login `data.user` hands back. Zero-domain: no role beyond
 * the template's own USER, no feature fields.
 */
function buildLoginUser(overrides = {}) {
    return {
        sub: "testuser",
        userId: "testuser",
        id: 1001,
        username: "testuser",
        userLevel: 1,
        firstName: "Test",
        lastName: "User",
        email: "test.user@example.com",
        role: "USER",
        loginSource: "user",
        isDefaultPassword: false,
        requiresPasswordChange: false,
        ...overrides,
    };
}

/**
 * jsdom ships no `window.matchMedia`, and `ThemeProvider` calls it in a
 * `useState` initialiser. `renderWithProviders.jsx` installs this shim, but this
 * suite mounts the provider chain around a HOOK (not through that helper), so it
 * owns the gap it opens. `matches: false` = OS light mode, deterministic across
 * machines.
 */
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
    window.matchMedia = (query) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
    });
}

/**
 * The REAL provider chain `useAuth` depends on — Router (for `useNavigate`),
 * Theme, Csrf (which bootstraps the token the login POST must carry), Layout.
 * VersionProvider is omitted deliberately: it fetches `changelog` on mount and
 * this suite asserts on request traffic, so leaving it out keeps the network
 * quiet except for the calls under test. This is the same chain
 * `renderWithProviders` assembles, minus that one provider — reused here as a
 * `renderHook` wrapper rather than a full render.
 */
function AuthWrapper({ children }) {
    return (
        <MemoryRouter initialEntries={["/auth"]}>
            <ThemeProvider>
                <CsrfProvider>
                    <LayoutProvider>{children}</LayoutProvider>
                </CsrfProvider>
            </ThemeProvider>
        </MemoryRouter>
    );
}

/**
 * Render `useAuth` inside the app's real provider chain and let CsrfProvider's
 * boot `useEffect` settle. That effect calls `csrfMiddleware.initialize()` and
 * `setCsrfToken` asynchronously; flushing it here (inside `act`) keeps its
 * state update from landing AFTER the login `act` block and emitting React's
 * "update not wrapped in act(...)" warning. The token is already primed by the
 * caller's `ensureTokenReady()`, so this is a settle, not a fetch.
 */
async function renderUseAuth() {
    let rendered;
    await act(async () => {
        rendered = renderHook(() => useAuth(), { wrapper: AuthWrapper });
    });
    return rendered;
}

beforeEach(() => {
    // Start from a clean token and no session so each test observes the boot
    // bootstrap and the login write in isolation.
    csrfMiddleware.clearToken();
    AuthMiddleware.clearAuthCache?.();
    localStorage.clear();
});

afterEach(() => {
    csrfMiddleware.clearToken();
    localStorage.clear();
    vi.restoreAllMocks();
});

describe("auth login flow — a rejected sign-in never looks signed-in (unhappy path)", () => {
    it("leaves the hook in an error state and writes NO session hint when the server answers 401", async () => {
        await csrfMiddleware.ensureTokenReady();
        server.use(http.post(apiUrl("auth/login"), () => HttpResponse.json(fail("Invalid credentials.", 401, { type: "AuthenticationError" }), { status: 401 })));

        const { result } = await renderUseAuth();

        let outcome;
        await act(async () => {
            outcome = await result.current.login({ username: "testuser", password: "wrong" });
        });

        // The hook reports failure to its caller and captures the error…
        expect(outcome).toBe(false);
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.error).toBeTruthy();

        // …and crucially, no session hint was written — the next request must
        // not fast-path as authenticated off a failed login.
        expect(localStorage.getItem("user_session")).toBeNull();
    });
});

describe("auth login flow — a successful sign-in drives the full stack", () => {
    it("carries the bootstrapped x-csrf-token and a well-formed X-Client-Username on the login POST, then updates auth state", async () => {
        // The token CsrfProvider bootstrapped from GET csrf/token — the login
        // POST must carry THIS value, proving injection is the real singleton's
        // work, not a per-test stub.
        await csrfMiddleware.ensureTokenReady();
        expect(csrfMiddleware.getToken()).toBe("test-csrf-token");

        let seenCsrf = "unset";
        let seenClientUser = "unset";
        server.use(
            http.post(apiUrl("auth/login"), async ({ request }) => {
                seenCsrf = request.headers.get("x-csrf-token");
                seenClientUser = request.headers.get("x-client-username");
                return HttpResponse.json(ok("Welcome!", { user: buildLoginUser(), accessToken: "opaque" }));
            }),
        );

        const { result } = await renderUseAuth();

        let outcome;
        await act(async () => {
            outcome = await result.current.login({ username: "testuser", password: "correct" });
        });

        expect(outcome).toBe(true);
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.error).toBeNull();

        // The request interceptor injected the REAL bootstrapped token.
        expect(seenCsrf).toBe("test-csrf-token");
        // Traceability header is well-formed: "Name@userId" or "anonymous@unknown".
        expect(seenClientUser).toMatch(/@/);
        // And the session hint AuthMiddleware.isAuth() fast-paths on is now set.
        expect(localStorage.getItem("user_session")).toBe("1");
    });

    it("maps the form's `username` field to the backend's `userId` on the wire", async () => {
        await csrfMiddleware.ensureTokenReady();

        let seenBody = null;
        server.use(
            http.post(apiUrl("auth/login"), async ({ request }) => {
                seenBody = await request.json();
                return HttpResponse.json(ok("Welcome!", { user: buildLoginUser(), accessToken: "opaque" }));
            }),
        );

        const { result } = await renderUseAuth();
        await act(async () => {
            await result.current.login({ username: "testuser", password: "correct" });
        });

        // The hook documents this mapping; assert it actually reaches the body.
        expect(seenBody).toMatchObject({ userId: "testuser", password: "correct" });
        expect(seenBody).not.toHaveProperty("username");
    });
});
