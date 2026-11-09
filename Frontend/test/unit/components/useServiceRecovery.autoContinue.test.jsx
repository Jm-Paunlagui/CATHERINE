/**
 * useServiceRecovery.autoContinue.test.jsx — unattended public screens registered in
 * AUTO_CONTINUE_PATHS auto-continue on recovery; every other route keeps the manual Continue.
 *
 * The template ships AUTO_CONTINUE_PATHS EMPTY (no unattended route), so:
 *   1. the default is proven directly: nothing auto-continues, Continue stays manual;
 *   2. the mechanism is proven by registering a sample route for the test. The list is a frozen,
 *      module-local array the hook reads with `.includes`, so the test answers `.includes` on THAT
 *      array (matched by identity via the export) from a test-owned list — no other array is touched.
 */
import { act, renderHook } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { serviceRecoveryNavigation, useServiceRecovery } from "../../../src/components/shared/serverStatus";
import { AUTO_CONTINUE_PATHS } from "../../../src/components/shared/serverStatus/useServiceRecovery";
import { SERVER_STATUS_KIND as K, _resetServerStatusForTests, reportServerStatus } from "../../../src/utils/serverStatus.js";
import { apiUrl } from "../../helpers/msw/api.js";
import { server } from "../../helpers/msw/server.js";

/** Sample unattended route a project might register. */
const BOARD = "/wall/board";

let go;
beforeEach(() => {
    _resetServerStatusForTests();
    vi.spyOn(Math, "random").mockReturnValue(0);
    server.use(http.get(apiUrl("health/ready"), () => new HttpResponse("<html>x</html>", { status: 503, headers: { "content-type": "text/html", "retry-after": "30" } })));
    go = vi.spyOn(serviceRecoveryNavigation, "go").mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
    _resetServerStatusForTests();
});

const recover = () => act(() => reportServerStatus(K.OK, { sentAt: Date.now(), healthy: true }));

/** Make the hook see `paths` as the registered AUTO_CONTINUE_PATHS for this test only. */
function registerAutoContinue(paths) {
    const realIncludes = Array.prototype.includes;
    vi.spyOn(Array.prototype, "includes").mockImplementation(function includes(...args) {
        return this === AUTO_CONTINUE_PATHS ? realIncludes.apply(paths, args) : realIncludes.apply(this, args);
    });
}

describe("useServiceRecovery — template default (AUTO_CONTINUE_PATHS is empty)", () => {
    it("ships an empty, frozen list", () => {
        expect(AUTO_CONTINUE_PATHS).toEqual([]);
        expect(Object.isFrozen(AUTO_CONTINUE_PATHS)).toBe(true);
    });

    it.each(["/dashboard", "/dashboard?tab=2", "/home", BOARD, "/", undefined])("never auto-continues to %s; Continue stays manual", (rt) => {
        const { result } = renderHook(() => useServiceRecovery({ returnTo: rt }));
        recover();
        expect(result.current.status).toBe("available");
        expect(go).not.toHaveBeenCalled();
        act(() => result.current.continueToApp());
        expect(go).toHaveBeenCalledTimes(1);
    });
});

describe("useServiceRecovery — auto-continue mechanism (a registered unattended route)", () => {
    beforeEach(() => registerAutoContinue([BOARD]));

    it.each([BOARD, `${BOARD}?station=2`])("auto-continues to %s on recovery, exactly once", (rt) => {
        const { result, rerender } = renderHook(() => useServiceRecovery({ returnTo: rt }));
        expect(go).not.toHaveBeenCalled();
        recover();
        expect(result.current.status).toBe("available");
        expect(go).toHaveBeenCalledTimes(1);
        expect(go).toHaveBeenCalledWith(rt);
        rerender();
        expect(go).toHaveBeenCalledTimes(1);
    });

    it("does not navigate while the service is still down", () => {
        renderHook(() => useServiceRecovery({ returnTo: BOARD }));
        expect(go).not.toHaveBeenCalled();
    });

    it.each(["/dashboard?x=1", `${BOARD}/extra`, `${BOARD}s`, "/", "//evil.com", "/\\wall/board", undefined, null])("stays manual for %s", (rt) => {
        const { result } = renderHook(() => useServiceRecovery({ returnTo: rt }));
        recover();
        expect(result.current.status).toBe("available");
        expect(go).not.toHaveBeenCalled();
        act(() => result.current.continueToApp());
        expect(go).toHaveBeenCalledTimes(1);
    });
});
