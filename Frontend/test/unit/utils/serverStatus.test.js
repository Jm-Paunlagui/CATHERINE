/**
 * serverStatus.test.js — every row of the state machine, stale-OK rule, no-op silence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    SERVER_DANGER_AFTER_MS,
    SERVER_RECOVERED_MS,
    SERVER_SHOW_AFTER_MS,
    SERVER_STATUS_KIND as K,
    _resetServerStatusForTests,
    getServerEpisode,
    getServerStatusSnapshot,
    onServerRecovered,
    reportServerStatus as report,
    subscribeServerStatus,
} from "../../../src/utils/serverStatus.js";
import { checkNow } from "../../../src/components/shared/serverStatus/useServerStatus.js";

const phase = () => getServerStatusSnapshot().phase;

beforeEach(() => {
    vi.useFakeTimers(); // mocks Date too (sentAt)
    vi.setSystemTime(1_000_000);
    _resetServerStatusForTests();
});
afterEach(() => {
    _resetServerStatusForTests();
    vi.useRealTimers();
});

describe("serverStatus state machine", () => {
    it("starts idle, invisible, frozen", () => {
        const s = getServerStatusSnapshot();
        expect(s).toMatchObject({ phase: "idle", severity: null, visible: false });
        expect(Object.isFrozen(s)).toBe(true);
    });

    it("idle + OK is a silent no-op", () => {
        const fn = vi.fn();
        subscribeServerStatus(fn);
        const before = getServerStatusSnapshot();
        report(K.OK);
        expect(getServerStatusSnapshot()).toBe(before);
        expect(fn).not.toHaveBeenCalled();
    });

    it("idle + NETWORK_FAILURE -> pending (invisible) -> unavailable after 3 s", () => {
        report(K.NETWORK_FAILURE);
        expect(phase()).toBe("pending");
        expect(getServerStatusSnapshot().visible).toBe(false);
        vi.advanceTimersByTime(SERVER_SHOW_AFTER_MS - 1);
        expect(phase()).toBe("pending");
        vi.advanceTimersByTime(1);
        expect(getServerStatusSnapshot()).toMatchObject({ phase: "unavailable", severity: "warning", visible: true });
    });

    it("pending + NETWORK_FAILURE is a no-op (timer not restarted)", () => {
        report(K.NETWORK_FAILURE);
        vi.advanceTimersByTime(2000);
        report(K.NETWORK_FAILURE);
        vi.advanceTimersByTime(1000);
        expect(phase()).toBe("unavailable");
    });

    it("pending + OK -> idle, never shown", () => {
        const seen = [];
        subscribeServerStatus(() => seen.push(getServerStatusSnapshot().visible));
        report(K.NETWORK_FAILURE);
        report(K.OK);
        expect(phase()).toBe("idle");
        vi.advanceTimersByTime(10_000);
        expect(phase()).toBe("idle");
        expect(seen.every((v) => v === false)).toBe(true);
    });

    it.each(["idle", "pending", "unavailable", "recovered"])("%s + SHUTDOWN -> restarting at once", (from) => {
        if (from === "pending") report(K.NETWORK_FAILURE);
        if (from === "unavailable") {
            report(K.NETWORK_FAILURE);
            vi.advanceTimersByTime(SERVER_SHOW_AFTER_MS);
        }
        if (from === "recovered") {
            report(K.SHUTDOWN);
            report(K.OK);
            expect(phase()).toBe("recovered");
        }
        report(K.SHUTDOWN);
        expect(getServerStatusSnapshot()).toMatchObject({ phase: "restarting", visible: true });
        vi.advanceTimersByTime(SERVER_SHOW_AFTER_MS * 2); // show timer was cleared
        expect(phase()).toBe("restarting");
    });

    it("restarting/unavailable + NETWORK_FAILURE is a no-op (restarting copy kept)", () => {
        report(K.SHUTDOWN);
        const snap = getServerStatusSnapshot();
        report(K.NETWORK_FAILURE);
        expect(getServerStatusSnapshot()).toBe(snap);

        _resetServerStatusForTests();
        report(K.NETWORK_FAILURE);
        vi.advanceTimersByTime(SERVER_SHOW_AFTER_MS);
        const snap2 = getServerStatusSnapshot();
        report(K.NETWORK_FAILURE);
        expect(getServerStatusSnapshot()).toBe(snap2);
    });

    it("restarting escalates to danger 60 s after the first failure", () => {
        report(K.SHUTDOWN);
        vi.advanceTimersByTime(SERVER_DANGER_AFTER_MS - 1);
        expect(getServerStatusSnapshot().severity).toBe("warning");
        vi.advanceTimersByTime(1);
        expect(getServerStatusSnapshot()).toMatchObject({ phase: "restarting", severity: "danger" });
    });

    it("unavailable escalates at firstAt + 60 s, not show-time + 60 s", () => {
        report(K.NETWORK_FAILURE);
        vi.advanceTimersByTime(SERVER_DANGER_AFTER_MS - 1);
        expect(getServerStatusSnapshot().severity).toBe("warning");
        vi.advanceTimersByTime(1);
        expect(getServerStatusSnapshot()).toMatchObject({ phase: "unavailable", severity: "danger" });
    });

    it("unavailable -> restarting keeps escalation clock and danger severity", () => {
        report(K.NETWORK_FAILURE);
        vi.advanceTimersByTime(SERVER_DANGER_AFTER_MS);
        report(K.SHUTDOWN);
        expect(getServerStatusSnapshot()).toMatchObject({ phase: "restarting", severity: "danger" });
    });

    it.each(["restarting", "unavailable"])("%s + fresh OK -> recovered, callbacks fire, then idle after 3 s", (from) => {
        if (from === "restarting") report(K.SHUTDOWN);
        else {
            report(K.NETWORK_FAILURE);
            vi.advanceTimersByTime(SERVER_SHOW_AFTER_MS);
        }
        const rec = vi.fn();
        onServerRecovered(rec);
        report(K.OK, { sentAt: Date.now() });
        expect(getServerStatusSnapshot()).toMatchObject({ phase: "recovered", severity: "success", visible: true });
        expect(rec).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(SERVER_RECOVERED_MS);
        expect(phase()).toBe("idle");
    });

    it("recovered + NETWORK_FAILURE -> pending (recovery timer cancelled)", () => {
        report(K.SHUTDOWN);
        report(K.OK);
        report(K.NETWORK_FAILURE);
        expect(phase()).toBe("pending");
        vi.advanceTimersByTime(SERVER_RECOVERED_MS - 1);
        expect(phase()).toBe("pending");
    });

    it("recovered + OK is a no-op", () => {
        report(K.SHUTDOWN);
        report(K.OK);
        const snap = getServerStatusSnapshot();
        report(K.OK);
        expect(getServerStatusSnapshot()).toBe(snap);
    });

    it("OK sent before the last SHUTDOWN is ignored; OK sent after clears", () => {
        const sentEarly = Date.now();
        vi.advanceTimersByTime(10);
        report(K.SHUTDOWN);
        report(K.OK, { sentAt: sentEarly });
        expect(phase()).toBe("restarting");
        report(K.OK, { sentAt: Date.now() });
        expect(phase()).toBe("recovered");
    });

    it("a repeated SHUTDOWN moves the stale boundary forward", () => {
        report(K.SHUTDOWN);
        vi.advanceTimersByTime(500);
        const mid = Date.now();
        vi.advanceTimersByTime(500);
        report(K.SHUTDOWN);
        report(K.OK, { sentAt: mid });
        expect(phase()).toBe("restarting");
    });

    it("no-op transitions notify nobody; real ones notify once", () => {
        const fn = vi.fn();
        subscribeServerStatus(fn);
        report(K.SHUTDOWN);
        expect(fn).toHaveBeenCalledTimes(1);
        report(K.SHUTDOWN);
        report(K.NETWORK_FAILURE);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("unsubscribe stops notifications; unknown kind ignored", () => {
        const fn = vi.fn();
        const off = subscribeServerStatus(fn);
        off();
        report(K.SHUTDOWN);
        report("bogus");
        expect(fn).not.toHaveBeenCalled();
    });

    it("onServerRecovered unsubscribe works", () => {
        const rec = vi.fn();
        onServerRecovered(rec)();
        report(K.SHUTDOWN);
        report(K.OK);
        expect(rec).not.toHaveBeenCalled();
    });
});

describe("episode stability (the countdown relies on a fixed firstAt)", () => {
    it("SHUTDOWN while unavailable keeps firstAt and the episode id", () => {
        report(K.NETWORK_FAILURE);
        vi.advanceTimersByTime(SERVER_SHOW_AFTER_MS);
        const before = getServerEpisode();
        vi.advanceTimersByTime(5000);
        report(K.SHUTDOWN);
        expect(getServerEpisode()).toEqual(before);
    });

    it("OUTAGE while restarting keeps firstAt and the episode id", () => {
        report(K.SHUTDOWN);
        const before = getServerEpisode();
        vi.advanceTimersByTime(7000);
        report(K.OUTAGE);
        expect(getServerEpisode()).toEqual(before);
    });

    it("repeated SHUTDOWN does not move firstAt", () => {
        report(K.SHUTDOWN);
        const before = getServerEpisode();
        vi.advanceTimersByTime(4000);
        report(K.SHUTDOWN);
        report(K.SHUTDOWN);
        expect(getServerEpisode()).toEqual(before);
    });

    it("checkNow() (probe loop restart) leaves the episode untouched", () => {
        report(K.SHUTDOWN);
        const before = getServerEpisode();
        checkNow();
        expect(getServerEpisode()).toEqual(before);
    });
});
