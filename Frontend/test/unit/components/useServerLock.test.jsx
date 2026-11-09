/**
 * useServerLock.test.jsx — derivation table, countdown clock, StrictMode.
 */
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deriveServerLock, useServerLock, _resetServerLockForTests } from "../../../src/components/shared/serverStatus/useServerLock";
import { SERVER_DANGER_AFTER_MS, SERVER_SHOW_AFTER_MS, SERVER_STATUS_KIND as K, _resetServerStatusForTests, getServerStatusSnapshot, reportServerStatus } from "../../../src/utils/serverStatus.js";

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});
afterEach(() => {
    cleanup();
    _resetServerLockForTests();
    _resetServerStatusForTests();
    vi.useRealTimers();
});

const emit = (kind, meta) => act(() => reportServerStatus(kind, meta));
const snap = (over) => ({ phase: "idle", severity: null, visible: false, outage: false, cause: null, ...over });

describe("deriveServerLock (pure)", () => {
    const FIRST = 1_000_000;
    it.each([
        ["idle", snap(), false, false, null],
        ["pending", snap({ phase: "pending" }), false, false, null],
        ["restarting", snap({ phase: "restarting", severity: "warning", visible: true }), true, false, 60000],
        ["unavailable warning", snap({ phase: "unavailable", severity: "warning", visible: true, cause: "server" }), true, false, 60000],
        ["unavailable danger", snap({ phase: "unavailable", severity: "danger", visible: true }), true, true, 60000],
        ["recovered", snap({ phase: "recovered", severity: "success", visible: true }), false, false, null],
    ])("%s", (_n, s, locked, shouldRedirect, inMs) => {
        const d = deriveServerLock(s, FIRST, FIRST);
        expect(d.locked).toBe(locked);
        expect(d.shouldRedirect).toBe(shouldRedirect);
        expect(d.redirectInMs).toBe(inMs);
    });

    it("floors redirectInMs at 0 and passes the cause through", () => {
        const d = deriveServerLock(snap({ phase: "unavailable", severity: "warning", visible: true, cause: "database" }), FIRST, FIRST + 99_999);
        expect(d.redirectInMs).toBe(0);
        expect(d.cause).toBe("database");
    });
});

describe("useServerLock", () => {
    it("is unlocked with null countdown when idle", () => {
        const { result } = renderHook(() => useServerLock());
        expect(result.current).toEqual({ locked: false, shouldRedirect: false, redirectInMs: null, cause: null });
    });

    it("locks at the reveal with 57 s left, then counts down once per second", () => {
        const { result } = renderHook(() => useServerLock());
        emit(K.NETWORK_FAILURE);
        expect(result.current.locked).toBe(false);
        act(() => vi.advanceTimersByTime(SERVER_SHOW_AFTER_MS));
        expect(result.current.locked).toBe(true);
        expect(Math.ceil(result.current.redirectInMs / 1000)).toBe(57);
        act(() => vi.advanceTimersByTime(1010));
        expect(Math.ceil(result.current.redirectInMs / 1000)).toBe(56);
        act(() => vi.advanceTimersByTime(5050));
        expect(Math.ceil(result.current.redirectInMs / 1000)).toBe(51);
    });

    it("re-renders about once per second while counting, not more", () => {
        let renders = 0;
        renderHook(() => {
            renders += 1;
            return useServerLock();
        });
        emit(K.SHUTDOWN);
        const before = renders;
        for (let i = 0; i < 10; i += 1) act(() => vi.advanceTimersByTime(1000));
        expect(renders - before).toBeLessThanOrEqual(11);
        expect(renders - before).toBeGreaterThanOrEqual(9);
    });

    it("flips to shouldRedirect at danger and stops ticking", () => {
        const { result } = renderHook(() => useServerLock());
        emit(K.SHUTDOWN);
        act(() => vi.advanceTimersByTime(SERVER_DANGER_AFTER_MS + 10));
        expect(getServerStatusSnapshot().severity).toBe("danger");
        expect(result.current.shouldRedirect).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("does not tick when not counting", () => {
        renderHook(() => useServerLock());
        expect(vi.getTimerCount()).toBe(0);
    });

    it("{ tick: false } never starts the display clock (only the store's own danger timer remains)", () => {
        let renders = 0;
        renderHook(() => {
            renders += 1;
            return useServerLock({ tick: false });
        });
        emit(K.SHUTDOWN);
        const before = renders;
        expect(vi.getTimerCount()).toBe(1);
        for (let i = 0; i < 5; i += 1) act(() => vi.advanceTimersByTime(1000));
        expect(renders).toBe(before);
    });

    it("StrictMode mount keeps a single clock timer (plus the store's own timers)", () => {
        const Probe = () => {
            useServerLock();
            return null;
        };
        render(
            <StrictMode>
                <Probe />
            </StrictMode>,
        );
        emit(K.SHUTDOWN); // restarting is visible at once; store arms 1 danger timer
        expect(vi.getTimerCount()).toBe(2);
    });

    it("a late-mounted consumer never shows more than 60 s", () => {
        emit(K.SHUTDOWN);
        const { result } = renderHook(() => useServerLock());
        expect(result.current.redirectInMs).toBeLessThanOrEqual(SERVER_DANGER_AFTER_MS);
    });
});
