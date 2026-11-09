/**
 * smartHome.perf.test.jsx — Performance: the smart error pages and signed-in redirect cost
 * almost nothing and never storm.
 *
 *   P1  resolveHomeHref is O(path length), O(1) storage reads: 10k resolutions on max-length input are fast
 *   P2  the 429 page renders once per countdown second (no re-render storm) and resolves home once
 *   P3  ProtectedRoute writes the last location once per navigation, not once per render
 *   P4  a signed-in visit to /auth costs exactly one auth/me; a signed-out one costs none
 */
import { Profiler } from "react";
import { act, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ProtectedRoute from "../../src/components/routing/ProtectedRoute.jsx";
import { ERROR_PAGE_ROUTES } from "../../src/constants/httpStatus.js";
import LoginView from "../../src/features/auth/Login.view.jsx";
import * as smartHome from "../../src/utils/smartHome.js";
import { LAST_LOCATION_KEY, recordLastLocation } from "../../src/utils/lastLocation.js";
import { RETURN_TO_MAX_LENGTH } from "../../src/utils/returnTo.js";
import { _resetServerStatusForTests } from "../../src/utils/serverStatus.js";
import { resetErrorPagePayloadCache, stashErrorPagePayload } from "../../src/utils/storage.js";
import { TooManyRequests } from "../../src/views/errors/ClientErrorResponses.jsx";
import AuthMiddleware from "../../src/middleware/authentication/AuthMiddleware.js";
import { loginAs } from "../helpers/auth.js";
import { ok } from "../helpers/fixtures/contract.js";
import { apiUrl } from "../helpers/msw/api.js";
import { server } from "../helpers/msw/server.js";
import { renderWithProviders } from "../helpers/renderWithProviders.jsx";

const USER_ID = "100001";

function signIn() {
    localStorage.setItem("user_session", "1");
    localStorage.setItem("user_display", JSON.stringify({ firstName: "Test", lastName: "User", userId: USER_ID }));
}

beforeEach(() => {
    // loginAs() leaves the session hint and the auth cache behind; every test starts signed out.
    localStorage.clear();
    sessionStorage.clear();
    AuthMiddleware.clearAuthCache();
    resetErrorPagePayloadCache();
    _resetServerStatusForTests();
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    _resetServerStatusForTests();
});

describe("P1 — resolution cost", () => {
    it("10k resolutions over the 6-case matrix (max-length paths) finish well under 1.5 s", () => {
        signIn();
        recordLastLocation("/system/admin-management", USER_ID);
        const longSafe = `/${"a".repeat(RETURN_TO_MAX_LENGTH - 1)}`;
        const inputs = [longSafe, undefined, "//evil.example", `/${"b".repeat(RETURN_TO_MAX_LENGTH)}`, "/dashboard?page=3", null];
        const t0 = performance.now();
        for (let i = 0; i < 10_000; i += 1) smartHome.resolveHomeHref(inputs[i % inputs.length]);
        expect(performance.now() - t0).toBeLessThan(1500);
    });

    it("storage is read a constant number of times per resolution, independent of path length", () => {
        signIn();
        recordLastLocation("/system/admin-management", USER_ID);
        const getItem = vi.spyOn(Storage.prototype, "getItem");
        smartHome.resolveHomeHref(undefined);
        const short = getItem.mock.calls.length;
        getItem.mockClear();
        smartHome.resolveHomeHref(`/${"z".repeat(RETURN_TO_MAX_LENGTH - 1)}`);
        expect(getItem.mock.calls.length).toBeLessThanOrEqual(short);
        expect(short).toBeLessThanOrEqual(6);
    });
});

describe("P2 — 429 page render budget", () => {
    it("a 5 s countdown commits ~one render per second, and Try again resolves home without re-rendering", () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        signIn();
        stashErrorPagePayload({ code: 429, retryAfter: 5, returnTo: "/dashboard" });
        const go = vi.spyOn(smartHome.homeNavigation, "go").mockImplementation(() => {});
        let commits = 0;

        renderWithProviders(
            <Profiler id="429" onRender={() => (commits += 1)}>
                <TooManyRequests />
            </Profiler>,
            { initialEntries: [ERROR_PAGE_ROUTES[429]], strict: false, withVersion: false }, // strict off: counting commits exactly
        );
        const afterMount = commits;
        // 100 ms per act so a faster-than-1 Hz ticker cannot hide behind React batching
        for (let s = 0; s < 51; s += 1) act(() => vi.advanceTimersByTime(100));
        const tickCommits = commits - afterMount;
        expect(tickCommits).toBeGreaterThanOrEqual(5);
        expect(tickCommits).toBeLessThanOrEqual(7);

        const beforeClick = commits;
        act(() => screen.getByRole("button", { name: /try again/i }).click());
        expect(go).toHaveBeenCalledTimes(1);
        expect(commits - beforeClick).toBe(0);
    });
});

describe("P3 — last-location writes", () => {
    function Nav() {
        const navigate = useNavigate();
        return (
            <>
                {Array.from({ length: 20 }, (_, i) => (
                    <button key={i} type="button" onClick={() => navigate(`/dashboard?page=${i}`)}>
                        go{i}
                    </button>
                ))}
            </>
        );
    }

    it("20 in-app navigations under one guard → about 20 writes, never a write storm", async () => {
        loginAs("ADMIN");
        renderWithProviders(
            <Routes>
                <Route element={<ProtectedRoute />}>
                    <Route
                        path="/dashboard"
                        element={
                            <>
                                <div>Dashboard Page</div>
                                <Nav />
                            </>
                        }
                    />
                </Route>
            </Routes>,
            { initialEntries: ["/dashboard"], strict: false, withVersion: false }, // strict off: counting effect runs exactly
        );
        expect(await screen.findByText("Dashboard Page")).toBeInTheDocument();
        const setItem = vi.spyOn(Storage.prototype, "setItem");
        for (let i = 0; i < 20; i += 1) act(() => screen.getByText(`go${i}`).click());
        await waitFor(() => expect(JSON.parse(sessionStorage.getItem(LAST_LOCATION_KEY)).path).toBe("/dashboard?page=19"));
        const writes = setItem.mock.calls.filter(([k]) => k === LAST_LOCATION_KEY).length;
        expect(writes).toBeGreaterThanOrEqual(20);
        expect(writes).toBeLessThanOrEqual(21);
    });

    it("30 re-renders of the guard on the same page → zero extra writes", async () => {
        loginAs("ADMIN");
        const tree = (n) => (
            <Routes>
                <Route element={<ProtectedRoute />}>
                    <Route path="/dashboard" element={<div>Dashboard Page {n}</div>} />
                </Route>
            </Routes>
        );
        // Spy from BEFORE mount and wait for the mount's own write. The write is a
        // passive effect: under full-suite load "Dashboard Page 0" can be on screen
        // before it runs, so spying after findByText caught the legitimate mount
        // write and read it as a re-render write.
        const setItem = vi.spyOn(Storage.prototype, "setItem");
        const writes = () => setItem.mock.calls.filter(([k]) => k === LAST_LOCATION_KEY);
        const { rerender } = renderWithProviders(tree(0), { initialEntries: ["/dashboard"], strict: false, withVersion: false });
        expect(await screen.findByText("Dashboard Page 0")).toBeInTheDocument();
        await waitFor(() => expect(writes()).toHaveLength(1)); // control: the mount write happened, exactly once
        expect(JSON.parse(writes()[0][1]).path).toBe("/dashboard");
        for (let i = 1; i <= 30; i += 1) rerender(tree(i));
        expect(screen.getByText("Dashboard Page 30")).toBeInTheDocument();
        await act(async () => {}); // flush any passive effects the re-renders scheduled
        expect(writes()).toHaveLength(1); // zero extra writes from 30 re-renders
    });
});

describe("P4 — signed-in redirect request cost", () => {
    it("signed in: /auth makes exactly one auth/me", async () => {
        const user = loginAs("ADMIN");
        let calls = 0;
        server.use(
            http.get(apiUrl("auth/me"), () => {
                calls += 1;
                return HttpResponse.json(ok("Data fetched successfully.", user));
            }),
        );
        recordLastLocation("/dashboard", user.userId);
        renderWithProviders(
            <Routes>
                <Route path="/auth" element={<LoginView />} />
                <Route path="/dashboard" element={<div>Dashboard Page</div>} />
            </Routes>,
            { initialEntries: ["/auth"] },
        );
        expect(await screen.findByText("Dashboard Page")).toBeInTheDocument();
        expect(calls).toBe(1);
    });

    it("signed out: /auth makes no auth/me at all", async () => {
        let calls = 0;
        server.use(
            http.get(apiUrl("auth/me"), () => {
                calls += 1;
                return HttpResponse.json(ok("x", null));
            }),
        );
        renderWithProviders(
            <Routes>
                <Route path="/auth" element={<LoginView />} />
            </Routes>,
            { initialEntries: ["/auth"] },
        );
        expect(await screen.findByRole("button", { name: /sign in/i })).toBeInTheDocument();
        await new Promise((r) => setTimeout(r, 100));
        expect(calls).toBe(0);
    });
});
