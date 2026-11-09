/**
 * serverLockGuard.test.jsx — ServerLockGuard: lock lifecycle + once-per-episode SPA redirect to the 523 route.
 *
 * The outage route is a stub here (the real page is covered by serviceUnavailable.recovery); what matters is
 * the path, the navigation type, and the stash the page reads.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ServerLockGuard } from "../../../src/components/shared/serverStatus";
import { _resetOutageRedirectForTests } from "../../../src/components/shared/serverStatus/useOutageRedirect";
import { _resetServerLockForTests } from "../../../src/components/shared/serverStatus/useServerLock";
import { SERVER_DANGER_AFTER_MS, SERVER_SHOW_AFTER_MS, SERVER_STATUS_KIND as K, _resetServerStatusForTests, reportServerStatus } from "../../../src/utils/serverStatus.js";
import { consumeErrorPagePayload, resetErrorPagePayloadCache } from "../../../src/utils/storage.js";

const OUTAGE = "/service-is-currently-unavailable";

function Where() {
    const { pathname, search } = useLocation();
    const type = useNavigationType();
    const navigate = useNavigate();
    return (
        <div>
            <span data-testid="where">{`${pathname}${search}`}</span>
            <span data-testid="navtype">{type}</span>
            <button type="button" data-lock-exempt data-testid="go-home" onClick={() => navigate("/")} />
        </div>
    );
}

function Tree({ start = "/system/data-purge?page=3", strict = false }) {
    const ui = (
        <MemoryRouter initialEntries={[start]}>
            <ServerLockGuard />
            <Where />
            <Routes>
                <Route path={OUTAGE} element={<div data-testid="outage-page">outage</div>} />
                <Route path="*" element={<button type="button">page action</button>} />
            </Routes>
        </MemoryRouter>
    );
    return strict ? <StrictMode>{ui}</StrictMode> : ui;
}

const emit = (kind, meta) => act(() => reportServerStatus(kind, meta));
const advance = (ms) => act(() => vi.advanceTimersByTime(ms));
const where = () => screen.getByTestId("where").textContent;
const locked = () => document.documentElement.hasAttribute("data-server-locked");

beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    resetErrorPagePayloadCache();
});
afterEach(() => {
    cleanup();
    _resetServerLockForTests();
    _resetOutageRedirectForTests();
    _resetServerStatusForTests();
    resetErrorPagePayloadCache();
    sessionStorage.clear();
    vi.useRealTimers();
});

describe("ServerLockGuard — lock", () => {
    it("locks when the banner appears (3 s), not before, and inerts page controls", () => {
        render(<Tree />);
        emit(K.NETWORK_FAILURE);
        advance(SERVER_SHOW_AFTER_MS - 1);
        expect(locked()).toBe(false);
        advance(1);
        expect(locked()).toBe(true);
        expect(screen.getByRole("button", { name: "page action", hidden: true })).toHaveAttribute("inert");
        expect(screen.getByTestId("go-home")).not.toHaveAttribute("inert");
    });

    it("locks during restarting at once and unlocks on recovery", () => {
        render(<Tree />);
        emit(K.SHUTDOWN);
        expect(locked()).toBe(true);
        emit(K.OK);
        expect(locked()).toBe(false);
        expect(document.querySelectorAll("[inert]")).toHaveLength(0);
    });

    it("does not lock on the outage route", () => {
        render(<Tree start={OUTAGE} />);
        emit(K.SHUTDOWN);
        expect(locked()).toBe(false);
    });
});

describe("ServerLockGuard — redirect", () => {
    it("at danger: SPA-replace navigates to the outage route and stashes returnTo from the router", () => {
        render(<Tree />);
        emit(K.NETWORK_FAILURE);
        advance(SERVER_SHOW_AFTER_MS);
        advance(SERVER_DANGER_AFTER_MS - SERVER_SHOW_AFTER_MS);
        expect(where()).toBe(OUTAGE);
        expect(screen.getByTestId("navtype")).toHaveTextContent("REPLACE");
        expect(locked()).toBe(false); // the outage route is never locked
        expect(consumeErrorPagePayload()).toEqual({ code: 523, title: null, message: null, requestId: null, retryAfter: null, returnTo: "/system/data-purge?page=3" });
    });

    it("a stale cached (null) payload from an earlier error page does not hide the hand-off", () => {
        expect(consumeErrorPagePayload()).toBeNull(); // memoised null, as after any earlier error page
        render(<Tree />);
        emit(K.SHUTDOWN);
        advance(SERVER_DANGER_AFTER_MS);
        expect(consumeErrorPagePayload()).toMatchObject({ code: 523, returnTo: "/system/data-purge?page=3" });
    });

    it("recovery before danger: no navigation", () => {
        render(<Tree />);
        emit(K.SHUTDOWN);
        advance(SERVER_DANGER_AFTER_MS - 1000);
        emit(K.OK);
        advance(SERVER_DANGER_AFTER_MS);
        expect(where()).toBe("/system/data-purge?page=3");
    });

    it("once per episode: going back during the same episode does not redirect again; a new episode does", () => {
        render(<Tree />);
        emit(K.SHUTDOWN);
        advance(SERVER_DANGER_AFTER_MS);
        expect(where()).toBe(OUTAGE);
        act(() => screen.getByTestId("go-home").click());
        expect(where()).toBe("/");
        advance(5000);
        expect(where()).toBe("/");

        emit(K.OK);
        advance(5000); // recovered -> idle
        emit(K.SHUTDOWN);
        advance(SERVER_DANGER_AFTER_MS);
        expect(where()).toBe(OUTAGE);
    });

    it("danger while already on the outage route: no navigation, and leaving later does not bounce", () => {
        render(<Tree start={OUTAGE} />);
        emit(K.SHUTDOWN);
        advance(SERVER_DANGER_AFTER_MS);
        expect(where()).toBe(OUTAGE);
        expect(sessionStorage.length).toBe(0);
        act(() => screen.getByTestId("go-home").click());
        advance(1000);
        expect(where()).toBe("/");
    });

    it("StrictMode: a single navigation", () => {
        render(<Tree strict />);
        emit(K.SHUTDOWN);
        advance(SERVER_DANGER_AFTER_MS);
        expect(where()).toBe(OUTAGE);
        expect(screen.getByTestId("navtype")).toHaveTextContent("REPLACE");
    });
});
