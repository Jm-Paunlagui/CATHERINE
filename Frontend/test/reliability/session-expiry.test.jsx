/**
 * session-expiry.test.jsx — Reliability: when a session dies, is the user
 * ALWAYS moved off the app shell, and never on a status that merely means the
 * one request failed?
 *
 * Two subjects, one reliability concern (a gone session must never leave a
 * signed-in shell rendered for a user the server has forgotten):
 *
 *   A. src/middleware/HttpClient.js takeover path, driven for real over MSW,
 *      resolved through src/constants/httpStatus.js. A 440 (Session Timeout)
 *      and a 498 (Invalid Token) hard-navigate to the routes in
 *      TAKEOVER_ROUTE_BY_STATUS — asserted against the ACTUAL constants, not a
 *      copy — and clear the local CSRF token on the way out. A non-takeover
 *      status (409) does neither.
 *
 *   B. src/hooks/useSessionWarning.js, driven with real React state and fake
 *      timers. When the wall-clock deadline in localStorage["session_exp"]
 *      passes, the hook signs out, clears the CSRF token, and navigates to
 *      /login-timeout — the SAME destination httpStatus.js maps 440 to, proving
 *      the proactive and reactive paths agree.
 *
 * MSW is the only network boundary. The two unavoidable seams are jsdom's
 * [Unforgeable] `window.location` (spied via HttpClient._navigate, and asserted
 * on directly for the hook's hard-navigation fallback) and time (Vitest fake
 * timers for the hook's countdown). Neither hides repo-owned behaviour; both
 * stand in for a host capability jsdom does not provide.
 *
 * CONSOLE HYGIENE: the takeover path logs nothing. The hook's refresh-failure
 * branch is a silent catch → expireSession; no test asserts on console output
 * and none is expected. No console spy is scoped; a log appearing here would be
 * a real regression.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_ENDING_STATUSES, TAKEOVER_ROUTE_BY_STATUS } from "../../src/constants/httpStatus.js";
import httpClient from "../../src/middleware/HttpClient.js";
import AuthMiddleware from "../../src/middleware/authentication/AuthMiddleware.js";
import csrfMiddleware from "../../src/middleware/security/CsrfMiddleware.js";
import { useSessionWarning } from "../../src/hooks/useSessionWarning.js";
import { fail, ok } from "../helpers/fixtures/contract.js";
import { apiUrl } from "../helpers/msw/api.js";
import { server } from "../helpers/msw/server.js";

/** Registers a GET handler that answers `path` with `status` in the real error envelope. */
function respondWith(path, status, { type = "AppError" } = {}) {
    server.use(http.get(apiUrl(path), () => HttpResponse.json(fail(`synthetic ${status}`, status, { type }), { status })));
}

/** Wrapper giving the hook the router context its `useNavigate()` needs. */
function routerWrapper({ children }) {
    return <MemoryRouter initialEntries={["/dashboard"]}>{children}</MemoryRouter>;
}

/** Seed a valid in-memory CSRF token so a later `clearToken()` is observable. */
async function seedCsrfToken() {
    server.use(http.get(apiUrl("csrf/token"), () => HttpResponse.json({ success: true, token: "live-token", expiresIn: 3_600_000, expiresAt: new Date(Date.now() + 3_600_000).toISOString() })));
    await csrfMiddleware.ensureTokenReady();
}

/* ─── A. HttpClient takeover path (440 / 498) ──────────────────────────────── */

describe("HttpClient session-ending statuses — takeover, resolved from the real constants", () => {
    let navigate;

    beforeEach(() => {
        navigate = vi.spyOn(httpClient, "_navigate").mockImplementation(() => {});
        localStorage.setItem("user_session", "1");
    });

    afterEach(() => {
        navigate.mockRestore();
        localStorage.clear();
        csrfMiddleware.clearToken();
        vi.restoreAllMocks();
    });

    // Drive the assertion off the SOURCE table. If a maintainer repoints 440 or
    // 498 in httpStatus.js, this test follows automatically — a hard-coded
    // route would silently pass against a stale expectation.
    it.each([...SESSION_ENDING_STATUSES])("status %i hard-navigates to its route in TAKEOVER_ROUTE_BY_STATUS", async (status) => {
        const expectedRoute = TAKEOVER_ROUTE_BY_STATUS[status];
        // Sanity-check the fixture itself: these two MUST have a takeover route.
        expect(expectedRoute).toEqual(expect.any(String));

        const path = `status-probe/session-${status}`;
        respondWith(path, status);

        await expect(httpClient.get(path)).rejects.toMatchObject({ response: { status } });

        expect(navigate).toHaveBeenCalledTimes(1);
        expect(navigate).toHaveBeenCalledWith(expectedRoute);
    });

    it("maps 440 → /login-timeout and 498 → /invalid-token (the concrete route values)", () => {
        // Pin the actual literals once, so a mis-edit of the constants file is
        // caught in words a human reads — the data-driven test above only checks
        // internal consistency.
        expect(TAKEOVER_ROUTE_BY_STATUS[440]).toBe("/login-timeout");
        expect(TAKEOVER_ROUTE_BY_STATUS[498]).toBe("/invalid-token");
        expect([...SESSION_ENDING_STATUSES].sort()).toEqual([440, 498]);
    });

    it.each([...SESSION_ENDING_STATUSES])("status %i clears the local session AND the CSRF token before navigating", async (status) => {
        await seedCsrfToken();
        expect(csrfMiddleware.getToken()).toBe("live-token");

        const path = `status-probe/clear-${status}`;
        respondWith(path, status);

        await expect(httpClient.get(path)).rejects.toMatchObject({ response: { status } });

        // A dead credential must not leave a signed-in shell renderable.
        expect(localStorage.getItem("user_session")).toBeNull();
        expect(csrfMiddleware.getToken()).toBeNull();
    });

    it("distinguishes a takeover from inline handling — a 409 neither navigates nor ends the session", async () => {
        await seedCsrfToken();
        respondWith("status-probe/inline-409", 409, { type: "ConflictError" });

        await expect(httpClient.get("status-probe/inline-409")).rejects.toMatchObject({ response: { status: 409 } });

        // 409 is a business outcome the feature shows in context — the view
        // stays mounted, the session and token stay intact.
        expect(navigate).not.toHaveBeenCalled();
        expect(localStorage.getItem("user_session")).toBe("1");
        expect(csrfMiddleware.getToken()).toBe("live-token");
    });

    it("hands the server's own title and message to the takeover screen across the hard navigation", async () => {
        // Both session-ending statuses stash their envelope so the full-page
        // screen shows what actually happened, not hardcoded copy.
        respondWith("status-probe/handoff-440", 440);

        const err = await httpClient.get("status-probe/handoff-440").catch((e) => e);

        expect(err.response.data.title).toBe("Session Timeout");
        expect(err.response.data.message).toBe("synthetic 440");
        expect(navigate).toHaveBeenCalledWith("/login-timeout");
    });
});

/* ─── B. useSessionWarning proactive expiry ────────────────────────────────── */

describe("useSessionWarning — the proactive path ends the session the same way", () => {
    let signoutSpy;
    let clearTokenSpy;
    let replaceSpy;

    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        // Observe the two teardown side effects without hitting real storage
        // internals — both are called by the hook's expireSession().
        signoutSpy = vi.spyOn(AuthMiddleware, "signout").mockImplementation(() => {});
        clearTokenSpy = vi.spyOn(csrfMiddleware, "clearToken").mockImplementation(() => {});
        // The hook's hard-navigation fallback calls window.location.replace in a
        // 0ms timer; jsdom cannot navigate, so intercept it. jsdom's location is
        // [Unforgeable], so redefine the whole object rather than spy `.replace`.
        replaceSpy = vi.fn();
        Object.defineProperty(window, "location", { value: { pathname: "/dashboard", replace: replaceSpy }, writable: true, configurable: true });
        localStorage.clear();
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
        localStorage.clear();
    });

    it("shows the warning modal, then on countdown reaching zero signs out, clears the CSRF token, and navigates to /login-timeout", async () => {
        // Session expires in 5s; warning fires WARNING_SECS (default 30s) before
        // expiry, i.e. immediately, and the countdown drives off the wall clock.
        localStorage.setItem("session_exp", String(Date.now() + 5_000));

        const { result } = renderHook(() => useSessionWarning(), { wrapper: routerWrapper });

        // Warning timer (delay clamped to 0 because expiry is inside the window).
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(result.current.visible).toBe(true);

        // Walk past the wall-clock deadline; the 1s interval reads session_exp
        // and, finding remaining <= 0, expires the session.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(6_000);
        });

        expect(signoutSpy).toHaveBeenCalledTimes(1);
        expect(clearTokenSpy).toHaveBeenCalledTimes(1);
        expect(result.current.visible).toBe(false);

        // Hard-navigation fallback fires in a 0ms timer after SPA navigate.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(replaceSpy).toHaveBeenCalledWith("/login-timeout");
    });

    it("expires exactly once even when the deadline is walked past by several ticks (idempotent teardown)", async () => {
        localStorage.setItem("session_exp", String(Date.now() + 2_000));

        renderHook(() => useSessionWarning(), { wrapper: routerWrapper });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(0); // arm warning
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(10_000); // blow well past the deadline
        });

        // The expiredRef latch guards against double signout/navigate under
        // React 19 StrictMode double-invocation and throttled tick bursts.
        expect(signoutSpy).toHaveBeenCalledTimes(1);
        expect(clearTokenSpy).toHaveBeenCalledTimes(1);
    });

    it("signOut() (user-initiated) ends the session down the identical path", async () => {
        localStorage.setItem("session_exp", String(Date.now() + 60_000));

        const { result } = renderHook(() => useSessionWarning(), { wrapper: routerWrapper });

        await act(async () => {
            result.current.signOut();
        });

        expect(signoutSpy).toHaveBeenCalledTimes(1);
        expect(clearTokenSpy).toHaveBeenCalledTimes(1);
    });

    it("extendSession() failure falls through to a full session teardown", async () => {
        localStorage.setItem("session_exp", String(Date.now() + 60_000));
        // auth/refresh rejects → the hook's catch calls expireSession().
        // Deliberately a 500, NOT a 440/498: a session-ending status would ALSO
        // trip HttpClient's own takeover teardown, and this test isolates the
        // hook's catch path — one signout, from the hook, not two.
        server.use(http.post(apiUrl("auth/refresh"), () => HttpResponse.json(fail("Refresh failed.", 500), { status: 500 })));

        const { result } = renderHook(() => useSessionWarning(), { wrapper: routerWrapper });

        await act(async () => {
            await result.current.extendSession();
        });

        expect(signoutSpy).toHaveBeenCalledTimes(1);
        expect(clearTokenSpy).toHaveBeenCalledTimes(1);
    });

    it("extendSession() success reschedules and does NOT tear down the session", async () => {
        localStorage.setItem("session_exp", String(Date.now() + 60_000));
        server.use(http.post(apiUrl("auth/refresh"), () => HttpResponse.json(ok("Session extended."))));

        const { result } = renderHook(() => useSessionWarning(), { wrapper: routerWrapper });

        await act(async () => {
            await result.current.extendSession();
        });

        // A successful extend is the opposite of expiry — no teardown at all.
        expect(signoutSpy).not.toHaveBeenCalled();
        expect(clearTokenSpy).not.toHaveBeenCalled();
        await waitFor(() => expect(result.current.extending).toBe(false));
    });
});
