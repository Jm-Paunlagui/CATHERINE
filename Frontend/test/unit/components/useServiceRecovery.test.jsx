/**
 * useServiceRecovery.test.jsx — the state machine behind the 523 page:
 * checking -> unavailable|restarting|danger|offline -> available (latched).
 */
import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { serviceRecoveryNavigation, useServiceRecovery } from "../../../src/components/shared/serverStatus";
import { serverStatusApi } from "../../../src/components/shared/serverStatus/serverStatus.api.js";
import { CHECK_COOLDOWN_MS } from "../../../src/components/shared/serverStatus/useServiceRecovery.js";
import { SERVER_DANGER_AFTER_MS, SERVER_RECOVERED_MS, SERVER_STATUS_KIND as K, _resetServerStatusForTests, getServerEpisode, getServerStatusSnapshot, reportServerStatus, subscribeServerStatus } from "../../../src/utils/serverStatus.js";
import { fail } from "../../helpers/fixtures/contract.js";
import { apiUrl } from "../../helpers/msw/api.js";
import { server } from "../../helpers/msw/server.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const down = (retryAfter = 1) => new HttpResponse("<html>x</html>", { status: 503, headers: { "content-type": "text/html", "retry-after": String(retryAfter) } });
const draining = () => HttpResponse.json(fail("d", 503, { type: "ServerShuttingDown" }), { status: 503, headers: { "retry-after": "1" } });
const probe = (resolver) => server.use(http.get(apiUrl("health/ready"), resolver));
const setOnline = (v) => Object.defineProperty(navigator, "onLine", { configurable: true, get: () => v });

beforeEach(() => {
    _resetServerStatusForTests();
    vi.spyOn(Math, "random").mockReturnValue(0);
    setOnline(true);
});
afterEach(() => {
    vi.restoreAllMocks();
    _resetServerStatusForTests();
    setOnline(true);
});

describe("useServiceRecovery", () => {
    it("seeds the OUTAGE on mount and reports 'checking' until the first probe settles", async () => {
        probe(() => down(30));
        const { result } = renderHook(() => useServiceRecovery({}));
        expect(getServerStatusSnapshot()).toMatchObject({ phase: "unavailable", outage: true });
        expect(result.current.status).toBe("checking");
        await vi.waitFor(() => expect(result.current.status).toBe("unavailable"));
        expect(result.current.meta.attempt).toBeGreaterThanOrEqual(1);
    });

    it("restarting when a probe sees the drain", async () => {
        probe(() => draining());
        const { result } = renderHook(() => useServiceRecovery({}));
        await vi.waitFor(() => expect(result.current.status).toBe("restarting"));
    });

    it("entered with the store ALREADY in danger (SPA redirect): status is danger at once, same episode, strict", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        probe(() => down(30));
        reportServerStatus(K.SHUTDOWN);
        const before = getServerEpisode();
        await act(async () => {
            vi.advanceTimersByTime(SERVER_DANGER_AFTER_MS);
        });
        expect(getServerStatusSnapshot().severity).toBe("danger");
        const { result } = renderHook(() => useServiceRecovery({}));
        expect(result.current.status).toBe("danger");
        expect(result.current.meta.firstAt).toBe(before.firstAt);
        expect(getServerEpisode().id).toBe(before.id);
        expect(getServerStatusSnapshot().outage).toBe(true);
        vi.useRealTimers();
    });

    it("danger after 60 s of outage", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        probe(() => down(30));
        const { result } = renderHook(() => useServiceRecovery({}));
        await act(async () => {
            vi.advanceTimersByTime(SERVER_DANGER_AFTER_MS);
        });
        expect(result.current.status).toBe("danger");
        vi.useRealTimers();
    });

    it("offline overrides every down state and follows the online/offline events", async () => {
        probe(() => down(30));
        const { result } = renderHook(() => useServiceRecovery({}));
        await vi.waitFor(() => expect(result.current.status).toBe("unavailable"));
        setOnline(false);
        act(() => window.dispatchEvent(new Event("offline")));
        expect(result.current.status).toBe("offline");
        setOnline(true);
        act(() => window.dispatchEvent(new Event("online")));
        expect(result.current.status).not.toBe("offline");
    });

    it("latches 'available' on the 200, and the latch survives the store going idle and a later NETWORK_FAILURE", async () => {
        let up = false;
        probe(() => (up ? HttpResponse.json({ status: "ready" }) : down(1)));
        const { result } = renderHook(() => useServiceRecovery({}));
        await vi.waitFor(() => expect(result.current.status).toBe("unavailable"));
        up = true;
        await vi.waitFor(() => expect(result.current.status).toBe("available"), { timeout: 4000 });
        expect(result.current.meta.recoveredAt).toBeGreaterThan(0);
        expect(result.current.meta.firstAt).toBeGreaterThan(0);
        await vi.waitFor(() => expect(getServerStatusSnapshot().phase).toBe("idle"), { timeout: SERVER_RECOVERED_MS + 2000 });
        expect(result.current.status).toBe("available");
        act(() => reportServerStatus(K.NETWORK_FAILURE));
        expect(result.current.status).toBe("available");
    }, 15_000);

    it("does not recover on an envelope 503 (strict) even though the banner path would", async () => {
        probe(() => HttpResponse.json(fail("db", 503, { type: "ServiceUnavailableError" }), { status: 503, headers: { "retry-after": "1" } }));
        const { result } = renderHook(() => useServiceRecovery({}));
        await sleep(1800);
        expect(result.current.status).not.toBe("available");
    });

    it("checkNow probes again at once and enforces a cooldown", async () => {
        let hits = 0;
        probe(() => ((hits += 1), down(30)));
        const { result } = renderHook(() => useServiceRecovery({}));
        await vi.waitFor(() => expect(hits).toBe(1));
        expect(result.current.checkCooldown).toBe(false);
        act(() => result.current.checkNow());
        expect(result.current.checkCooldown).toBe(true);
        await vi.waitFor(() => expect(hits).toBe(2), { timeout: 1500 });
        act(() => result.current.checkNow()); // inside the cooldown: ignored
        await sleep(300);
        expect(hits).toBe(2);
    });

    describe("continueToApp", () => {
        let go;
        beforeEach(() => {
            go = vi.spyOn(serviceRecoveryNavigation, "go").mockImplementation(() => {});
        });

        it("goes to a valid returnTo", () => {
            probe(() => down(30));
            const { result } = renderHook(() => useServiceRecovery({ returnTo: "/dashboard?x=1" }));
            expect(result.current.returnTo).toBe("/dashboard?x=1");
            act(() => result.current.continueToApp());
            expect(go).toHaveBeenCalledWith("/dashboard?x=1");
        });

        it.each([["//evil.com"], ["/\\evil"], ["javascript:alert(1)"], ["/service-is-currently-unavailable"], ["/auth/x"], [undefined], [null]])("falls back to '/' for %s", (bad) => {
            probe(() => down(30));
            const { result } = renderHook(() => useServiceRecovery({ returnTo: bad }));
            expect(result.current.returnTo).toBeNull();
            act(() => result.current.continueToApp());
            expect(go).toHaveBeenCalledWith("/");
        });

        it("the default seam really navigates with location.replace (no new history entry)", () => {
            // Weak-test fix (6-matrix): this used to assert only `typeof go === "function"`, which cannot fail.
            // jsdom implements same-document (hash) navigations, so the REAL seam is observable through one.
            go.mockRestore();
            const before = window.history.length;
            const target = `${window.location.pathname}${window.location.search}#svc-seam-test`;
            serviceRecoveryNavigation.go(target);
            expect(window.location.hash).toBe("#svc-seam-test");
            expect(window.history.length).toBe(before); // replace, not assign/push
            window.history.replaceState(null, "", window.location.pathname + window.location.search);
        });
    });

    it("StrictMode: one loop, one OUTAGE episode", async () => {
        let inFlight = 0;
        let peak = 0;
        probe(async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await sleep(40);
            inFlight -= 1;
            return down(1);
        });
        // Weak-test fix (6-matrix): the old `first.phase === "idle"` read a snapshot taken BEFORE render and
        // could not fail. Record every episode id the store publishes: StrictMode's replayed seed must not
        // open a second episode.
        expect(getServerStatusSnapshot().phase).toBe("idle");
        const ids = new Set();
        const unsub = subscribeServerStatus(() => ids.add(getServerEpisode().id));
        const { result } = renderHook(() => useServiceRecovery({}), { wrapper: StrictMode });
        await sleep(1200);
        unsub();
        expect(peak).toBe(1);
        expect(result.current.status).toBe("unavailable");
        expect(ids.size).toBe(1);
        expect([...ids][0]).toBeGreaterThan(0);
    });

    it("subscribes to recovery BEFORE seeding: a synchronous healthy OK right after mount still latches", async () => {
        probe(() => down(30));
        const { result } = renderHook(() => useServiceRecovery({}));
        act(() => reportServerStatus(K.OK, { sentAt: Date.now(), healthy: true }));
        expect(result.current.status).toBe("available");
    });

    describe("Check again cooldown (6-matrix gap: B5 expiry + offline)", () => {
        const UNREACHABLE = { ready: false, healthy: false, draining: false, reachable: false, retryAfterMs: 30_000, cause: "server" };
        afterEach(() => vi.useRealTimers());

        it("the cooldown ends after exactly CHECK_COOLDOWN_MS and a second press then probes again", async () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
            const spy = vi.spyOn(serverStatusApi, "probeReady").mockResolvedValue(UNREACHABLE);
            const { result } = renderHook(() => useServiceRecovery({}));
            await act(async () => {
                await vi.advanceTimersByTimeAsync(10);
            });
            expect(spy).toHaveBeenCalledTimes(1);
            act(() => result.current.checkNow());
            await act(async () => {
                await vi.advanceTimersByTimeAsync(10);
            });
            expect(spy).toHaveBeenCalledTimes(2);
            await act(async () => {
                await vi.advanceTimersByTimeAsync(CHECK_COOLDOWN_MS - 50);
            });
            expect(result.current.checkCooldown).toBe(true);
            act(() => result.current.checkNow()); // still inside the window
            await act(async () => {
                await vi.advanceTimersByTimeAsync(10);
            });
            expect(spy).toHaveBeenCalledTimes(2);
            await act(async () => {
                await vi.advanceTimersByTimeAsync(60);
            });
            expect(result.current.checkCooldown).toBe(false);
            act(() => result.current.checkNow());
            await act(async () => {
                await vi.advanceTimersByTimeAsync(10);
            });
            expect(spy).toHaveBeenCalledTimes(3);
            expect(CHECK_COOLDOWN_MS).toBe(5000);
        });

        it("offline: checkNow is a no-op (no probe, no cooldown)", async () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
            const spy = vi.spyOn(serverStatusApi, "probeReady").mockResolvedValue(UNREACHABLE);
            setOnline(false);
            const { result } = renderHook(() => useServiceRecovery({}));
            await act(async () => {
                await vi.advanceTimersByTimeAsync(10);
            });
            const calls = spy.mock.calls.length;
            expect(result.current.status).toBe("offline");
            act(() => result.current.checkNow());
            await act(async () => {
                await vi.advanceTimersByTimeAsync(10);
            });
            expect(result.current.checkCooldown).toBe(false);
            expect(spy).toHaveBeenCalledTimes(calls);
        });

        it("unmount during the cooldown clears its timer (no state update after unmount)", async () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
            vi.spyOn(serverStatusApi, "probeReady").mockResolvedValue(UNREACHABLE);
            const err = vi.spyOn(console, "error").mockImplementation(() => {});
            const { result, unmount } = renderHook(() => useServiceRecovery({}));
            act(() => result.current.checkNow());
            expect(result.current.checkCooldown).toBe(true);
            unmount();
            await act(async () => {
                await vi.advanceTimersByTimeAsync(0);
            });
            // Right after unmount, inside the 5 s window: only the store's own 60 s danger timer may remain
            // (module state outlives the page by design); the cooldown timer and the probe-loop wait are gone.
            expect(vi.getTimerCount()).toBe(1);
            await act(async () => {
                await vi.advanceTimersByTimeAsync(CHECK_COOLDOWN_MS + 100);
            });
            expect(getServerStatusSnapshot().phase).toBe("unavailable");
            expect(err).not.toHaveBeenCalled();
        });
    });
});
