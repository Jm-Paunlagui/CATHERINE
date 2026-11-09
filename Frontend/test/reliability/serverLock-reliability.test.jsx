/**
 * serverLock-reliability.test.jsx — rapid lock/unlock flips never leak inert/attributes; the clock dies with its consumers.
 */
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ServerLockGuard } from "../../src/components/shared/serverStatus";
import { _resetOutageRedirectForTests } from "../../src/components/shared/serverStatus/useOutageRedirect";
import { _resetServerLockForTests } from "../../src/components/shared/serverStatus/useServerLock";
import { SERVER_STATUS_KIND as K, _resetServerStatusForTests, reportServerStatus } from "../../src/utils/serverStatus.js";

beforeEach(() => {
    vi.useFakeTimers();
});
afterEach(() => {
    cleanup();
    _resetServerLockForTests();
    _resetOutageRedirectForTests();
    _resetServerStatusForTests();
    vi.useRealTimers();
});

const emit = (kind) => act(() => reportServerStatus(kind));

describe("server lock reliability", () => {
    it("50 rapid lock/unlock flips leave zero [inert] and no data-server-locked", () => {
        render(
            <MemoryRouter>
                <ServerLockGuard />
                <button type="button">a</button>
                <input aria-label="b" />
            </MemoryRouter>,
        );
        for (let i = 0; i < 50; i += 1) {
            emit(K.SHUTDOWN);
            expect(document.documentElement).toHaveAttribute("data-server-locked");
            emit(K.OK);
            expect(document.documentElement).not.toHaveAttribute("data-server-locked");
            act(() => vi.advanceTimersByTime(4000)); // recovered -> idle
        }
        expect(document.querySelectorAll("[inert]")).toHaveLength(0);
        expect(document.documentElement).not.toHaveAttribute("data-server-locked");
    });

    it("unmounting while locked releases the lock, and the countdown clock leaves no pending timer", () => {
        const { unmount } = render(
            <MemoryRouter>
                <ServerLockGuard />
                <button type="button">a</button>
            </MemoryRouter>,
        );
        emit(K.SHUTDOWN);
        expect(document.querySelectorAll("[inert]")).toHaveLength(1);
        unmount();
        expect(document.querySelectorAll("[inert]")).toHaveLength(0);
        expect(document.documentElement).not.toHaveAttribute("data-server-locked");
        _resetServerStatusForTests(); // clears the store's own timers
        expect(vi.getTimerCount()).toBe(0);
    });
});
