/**
 * serverLock.perf.test.jsx — applyServerLock is one O(N) scan; the banner re-renders ~1x/second while counting.
 */
import { act, cleanup, render } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ServerStatusBanner } from "../../src/components/shared/serverStatus";
import { applyServerLock } from "../../src/components/shared/serverStatus/serverLockDom";
import { _resetServerLockForTests } from "../../src/components/shared/serverStatus/useServerLock";
import { SERVER_STATUS_KIND as K, _resetServerStatusForTests, reportServerStatus } from "../../src/utils/serverStatus.js";

afterEach(() => {
    cleanup();
    _resetServerLockForTests();
    _resetServerStatusForTests();
    vi.useRealTimers();
    document.body.innerHTML = "";
});

describe("server lock performance", () => {
    it("applyServerLock + release on 2,000 buttons stays within a generous budget (O(N))", () => {
        document.body.innerHTML = Array.from({ length: 2000 }, (_, i) => `<button id="b${i}">b</button>`).join("");
        const t0 = performance.now();
        const release = applyServerLock(document);
        const applyMs = performance.now() - t0;
        expect(document.querySelectorAll("[inert]")).toHaveLength(2000);
        release();
        expect(document.querySelectorAll("[inert]")).toHaveLength(0);
        expect(applyMs).toBeLessThan(1000);
    });

    describe("banner while counting", () => {
        beforeEach(() => vi.useFakeTimers());

        it("commits at most once per second", () => {
            let commits = 0;
            render(
                <Profiler id="banner" onRender={() => (commits += 1)}>
                    <ServerStatusBanner />
                </Profiler>,
            );
            act(() => reportServerStatus(K.SHUTDOWN));
            const before = commits;
            for (let i = 0; i < 10; i += 1) act(() => vi.advanceTimersByTime(1000));
            expect(commits - before).toBeLessThanOrEqual(12);
        });
    });
});
