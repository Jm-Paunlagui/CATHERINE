/**
 * serverStatusBanner.test.jsx — copy, variants, live-region semantics, non-dismissable.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ServerStatusBanner, SERVER_STATUS_MESSAGES, SERVER_BANNER_EXIT_MS } from "../../../src/components/shared/serverStatus";
import { _resetServerLockForTests } from "../../../src/components/shared/serverStatus/useServerLock";
import { SERVER_DANGER_AFTER_MS, SERVER_RECOVERED_MS, SERVER_SHOW_AFTER_MS, SERVER_STATUS_KIND as K, _resetServerStatusForTests, reportServerStatus } from "../../../src/utils/serverStatus.js";
import { server } from "../../helpers/msw/server.js";
import { http, HttpResponse } from "msw";
import { apiUrl } from "../../helpers/msw/api.js";

beforeEach(() => {
    _resetServerStatusForTests();
    // Probe never answers during these tests; keep it from reaching the network.
    server.use(http.get(apiUrl("health/ready"), () => HttpResponse.json({}, { status: 503 })));
    vi.spyOn(Math, "random").mockReturnValue(0.99);
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    _resetServerStatusForTests();
});

const emit = (kind, meta) => act(() => reportServerStatus(kind, meta));

describe("<ServerStatusBanner>", () => {
    it("always mounts an empty polite, atomic live region when idle", () => {
        render(<ServerStatusBanner />);
        const region = screen.getByRole("status");
        expect(region).toHaveAttribute("aria-live", "polite");
        expect(region).toHaveAttribute("aria-atomic", "true");
        expect(region).toBeEmptyDOMElement();
    });

    // Deliberate design: restarting is no longer the amber warning fill. It is the
    // palette-aware "info" fill (solid secondary family, contrast token foreground) — the server
    // restarting is expected, not a fault. Unavailable/danger/recovered keep their semantic colours.
    it("restarting copy, info variant (secondary/palette fill)", () => {
        render(<ServerStatusBanner />);
        emit(K.SHUTDOWN);
        const region = screen.getByRole("status");
        expect(region).toHaveTextContent(SERVER_STATUS_MESSAGES.restarting);
        expect(region.innerHTML).toContain("bg-purple-400");
        expect(region.innerHTML).toContain("text-(--on-secondary-text)");
        expect(region.innerHTML).not.toContain("bg-warn-400");
        expect(region.querySelector("svg")).not.toBeNull();
    });

    it("renders no dismiss control", () => {
        render(<ServerStatusBanner />);
        emit(K.SHUTDOWN);
        expect(screen.queryByRole("button")).toBeNull();
        expect(screen.queryByLabelText(/dismiss/i)).toBeNull();
    });

    it("unavailable copy after 3 s of network failure, danger copy and variant after 60 s", () => {
        vi.useFakeTimers();
        render(<ServerStatusBanner />);
        emit(K.NETWORK_FAILURE);
        expect(screen.getByRole("status")).toBeEmptyDOMElement();
        act(() => vi.advanceTimersByTime(SERVER_SHOW_AFTER_MS));
        expect(screen.getByRole("status")).toHaveTextContent(SERVER_STATUS_MESSAGES.unavailable);
        act(() => vi.advanceTimersByTime(SERVER_DANGER_AFTER_MS));
        const region = screen.getByRole("status");
        expect(region).toHaveTextContent(SERVER_STATUS_MESSAGES.danger);
        expect(region.innerHTML).toContain("bg-danger-400");
    });

    it("recovered copy, success variant", () => {
        render(<ServerStatusBanner />);
        emit(K.SHUTDOWN);
        emit(K.OK);
        const region = screen.getByRole("status");
        expect(region).toHaveTextContent("Back online.");
        expect(region.innerHTML).toContain("bg-success-500");
    });

    it("copy is exactly the specified strings", () => {
        expect(SERVER_STATUS_MESSAGES).toEqual({
            restarting: "The server is restarting. We'll reconnect automatically. Please wait before saving.",
            unavailable: "Can't reach the server. Retrying…",
            // Shown while an OUTAGE episode (the 523 page) is unavailable.
            outage: "The service is unavailable. Retrying automatically…",
            databaseUnavailable: "The database isn't responding. We'll reconnect automatically. Please wait before saving.",
            databaseDanger: "Still can't reach the database. Retrying… If this continues, contact your system administrator.",
            danger: "Still can't reach the server. Retrying… If this continues, contact your system administrator.",
            recovered: "Back online.",
        });
    });
});

describe("<ServerStatusBanner> placement", () => {
    it("text starts at the page's left edge like the navbar logo (full width, px-4), not a centred max-w box", () => {
        render(<ServerStatusBanner />);
        emit(K.SHUTDOWN);
        const text = screen.getByText(SERVER_STATUS_MESSAGES.restarting);
        const inner = text.closest("div.flex")?.parentElement;
        expect(inner).toBeTruthy();
        expect(inner.className).not.toMatch(/\bmax-w-7xl\b/);
        expect(inner.className).not.toMatch(/\bmx-auto\b/);
        expect(inner.className).toMatch(/\bpx-4\b/);
        expect(inner.className).toMatch(/\bjustify-start\b/);
    });
});

describe("<ServerStatusBanner> motion", () => {
    const part = (n) => document.querySelector(`[data-part="${n}"]`);
    const svg = () => screen.getByRole("status").querySelector("svg");

    it("enter: collapse grows (grid rows + @starting-style), clip fades in, colours transition", () => {
        render(<ServerStatusBanner />);
        emit(K.SHUTDOWN);
        const wrap = part("collapse").className;
        expect(wrap).toMatch(/grid-rows-\[1fr\]/);
        expect(wrap).toContain("starting:grid-rows-[0fr]");
        expect(wrap).toContain("transition-[grid-template-rows]");
        expect(wrap).toContain("motion-reduce:transition-none!");
        const clip = part("clip").className;
        expect(clip).toMatch(/\banimate-fade-in\b/);
        expect(clip).toMatch(/\boverflow-hidden\b/);
        expect(clip).toMatch(/\bmin-h-0\b/);
        expect(clip).toContain("motion-reduce:animate-none!");
        expect(screen.getByRole("status").querySelector(".transition-colors-fast")).toBeTruthy();
    });

    it("icons: spin while restarting, pulse while unavailable, still in danger, bounce on recovery", () => {
        vi.useFakeTimers();
        render(<ServerStatusBanner />);
        emit(K.SHUTDOWN);
        expect(svg().getAttribute("class")).toContain("animate-spin-slow");
        expect(svg().getAttribute("class")).toContain("motion-reduce:animate-none!");
        emit(K.OK);
        expect(svg().getAttribute("class")).toContain("animate-bounce-in");
        act(() => vi.advanceTimersByTime(SERVER_RECOVERED_MS + SERVER_BANNER_EXIT_MS));
        emit(K.NETWORK_FAILURE);
        act(() => vi.advanceTimersByTime(SERVER_SHOW_AFTER_MS));
        expect(svg().getAttribute("class")).toContain("animate-pulse");
        act(() => vi.advanceTimersByTime(SERVER_DANGER_AFTER_MS));
        expect(svg().getAttribute("class")).not.toMatch(/animate-/);
        expect(screen.getByRole("status").querySelector(".bg-danger-400")).toBeTruthy();
    });

    it("exit: stays mounted (latched) and collapses/fades for SERVER_BANNER_EXIT_MS, then empties the same live region", () => {
        vi.useFakeTimers();
        render(<ServerStatusBanner />);
        const region = screen.getByRole("status");
        emit(K.SHUTDOWN);
        emit(K.OK);
        act(() => vi.advanceTimersByTime(SERVER_RECOVERED_MS));
        expect(region).toHaveTextContent(SERVER_STATUS_MESSAGES.recovered);
        expect(part("collapse").className).toMatch(/grid-rows-\[0fr\]/);
        expect(part("collapse").className).not.toContain("starting:");
        expect(part("clip").className).toMatch(/\banimate-fade-out\b/);
        act(() => vi.advanceTimersByTime(SERVER_BANNER_EXIT_MS - 1));
        expect(region).toHaveTextContent(SERVER_STATUS_MESSAGES.recovered);
        act(() => vi.advanceTimersByTime(1));
        expect(region).toBeEmptyDOMElement();
        expect(screen.getByRole("status")).toBe(region);
        expect(region).toHaveAttribute("aria-live", "polite");
        expect(region).toHaveAttribute("aria-atomic", "true");
    });

    it("re-entry during the exit cancels it and shows the new state", () => {
        vi.useFakeTimers();
        render(<ServerStatusBanner />);
        emit(K.SHUTDOWN);
        emit(K.OK);
        act(() => vi.advanceTimersByTime(SERVER_RECOVERED_MS + 100));
        emit(K.SHUTDOWN);
        expect(screen.getByRole("status")).toHaveTextContent(SERVER_STATUS_MESSAGES.restarting);
        expect(part("collapse").className).toMatch(/grid-rows-\[1fr\]/);
        act(() => vi.advanceTimersByTime(SERVER_BANNER_EXIT_MS));
        expect(screen.getByRole("status")).toHaveTextContent(SERVER_STATUS_MESSAGES.restarting);
    });

    it("no crossfade: one text node per state", () => {
        render(<ServerStatusBanner />);
        emit(K.SHUTDOWN);
        expect(screen.getAllByText(SERVER_STATUS_MESSAGES.restarting)).toHaveLength(1);
        emit(K.OK);
        expect(screen.getAllByText(SERVER_STATUS_MESSAGES.recovered)).toHaveLength(1);
        expect(screen.queryByText(SERVER_STATUS_MESSAGES.restarting)).toBeNull();
    });
});

describe("<ServerStatusBanner> motion QA", () => {
    it("pulse while retrying is capped to 3 cycles (WCAG 2.2.2: < 5 s of motion)", () => {
        vi.useFakeTimers();
        render(<ServerStatusBanner />);
        emit(K.NETWORK_FAILURE);
        act(() => vi.advanceTimersByTime(SERVER_SHOW_AFTER_MS));
        const cls = screen.getByRole("status").querySelector("svg").getAttribute("class");
        expect(cls).toContain("animate-pulse");
        expect(cls).toContain("[animation-iteration-count:3]!");
    });

    it("unmount during the exit window clears the timer (no state update after unmount)", () => {
        vi.useFakeTimers();
        const err = vi.spyOn(console, "error").mockImplementation(() => {});
        const { unmount } = render(<ServerStatusBanner />);
        emit(K.SHUTDOWN);
        emit(K.OK);
        act(() => vi.advanceTimersByTime(SERVER_RECOVERED_MS));
        unmount();
        expect(vi.getTimerCount()).toBe(0);
        expect(err).not.toHaveBeenCalled();
    });

    it("rapid flapping ends empty after one exit window", () => {
        vi.useFakeTimers();
        render(<ServerStatusBanner />);
        const region = screen.getByRole("status");
        for (let i = 0; i < 5; i++) {
            emit(K.SHUTDOWN);
            emit(K.OK);
            act(() => vi.advanceTimersByTime(SERVER_RECOVERED_MS + 50));
        }
        act(() => vi.advanceTimersByTime(SERVER_BANNER_EXIT_MS));
        expect(region).toBeEmptyDOMElement();
    });

    it("no empty actions box (it wrapped to a blank second line on narrow screens)", () => {
        render(<ServerStatusBanner />);
        emit(K.SHUTDOWN);
        const row = screen.getByText(SERVER_STATUS_MESSAGES.restarting).closest("div.flex").parentElement;
        expect(row.children).toHaveLength(1);
    });
});

describe("<ServerStatusBanner> status tone, palette hairline, 523 route", () => {
    const region = () => screen.getByTestId("server-status-banner");

    it("the live region carries data-testid and is polite + atomic everywhere but the 523 route", () => {
        render(
            <MemoryRouter initialEntries={["/dashboard"]}>
                <ServerStatusBanner />
            </MemoryRouter>,
        );
        expect(region()).toHaveAttribute("role", "status");
        expect(region()).toHaveAttribute("aria-live", "polite");
        expect(region()).toHaveAttribute("aria-atomic", "true");
    });

    it("on the 523 route the banner is visible but SILENT: aria-live off and no status role (the page owns announcements)", () => {
        render(
            <MemoryRouter initialEntries={["/service-is-currently-unavailable"]}>
                <ServerStatusBanner />
            </MemoryRouter>,
        );
        emit(K.OUTAGE);
        expect(region()).toHaveAttribute("aria-live", "off");
        expect(region()).not.toHaveAttribute("role");
        expect(region()).toHaveTextContent(SERVER_STATUS_MESSAGES.outage);
    });

    it("without a Router (isolated render) the banner still mounts", () => {
        render(<ServerStatusBanner />);
        expect(region()).toHaveAttribute("role", "status");
    });

    it("outage copy is used when the snapshot is an outage, plain unavailable copy otherwise", () => {
        vi.useFakeTimers();
        render(<ServerStatusBanner />);
        emit(K.OUTAGE);
        expect(region()).toHaveTextContent("The service is unavailable. Retrying automatically…");
        act(() => reportServerStatus(K.OK, { sentAt: Date.now(), healthy: true }));
        act(() => vi.advanceTimersByTime(SERVER_RECOVERED_MS + SERVER_BANNER_EXIT_MS + 50));
        emit(K.NETWORK_FAILURE);
        act(() => vi.advanceTimersByTime(SERVER_SHOW_AFTER_MS));
        expect(region()).toHaveTextContent(SERVER_STATUS_MESSAGES.unavailable);
    });

    it("dark soft treatment per semantic variant (warning / danger / success), light fill unchanged", () => {
        vi.useFakeTimers();
        render(<ServerStatusBanner />);
        emit(K.NETWORK_FAILURE);
        act(() => vi.advanceTimersByTime(SERVER_SHOW_AFTER_MS));
        let html = region().innerHTML;
        for (const c of ["bg-warn-400", "dark:bg-(--status-warning-bg)", "dark:text-(--status-warning-text)", "dark:border-(--status-warning-base)/50", "dark:text-(--status-warning-base)"]) expect(html).toContain(c);
        act(() => vi.advanceTimersByTime(SERVER_DANGER_AFTER_MS));
        html = region().innerHTML;
        for (const c of ["bg-danger-400", "dark:bg-(--status-danger-bg)", "dark:text-(--status-danger-text)", "dark:border-(--status-danger-base)/50"]) expect(html).toContain(c);
        emit(K.OK, { sentAt: Date.now() });
        html = region().innerHTML;
        for (const c of ["bg-success-500", "dark:bg-(--status-success-bg)", "dark:text-(--status-success-text)", "dark:border-(--status-success-base)/50"]) expect(html).toContain(c);
    });

    it("palette hairline on every state; it animates only while restarting and stops under reduced motion", () => {
        vi.useFakeTimers();
        render(<ServerStatusBanner />);
        emit(K.SHUTDOWN);
        let html = region().innerHTML;
        for (const c of ["after:absolute", "after:inset-x-0", "after:bottom-0", "after:h-0.5", "after:bg-linear-to-r", "after:from-(--color-gradient-from)", "after:to-(--color-gradient-to)"]) expect(html).toContain(c);
        expect(html).toContain("after:animate-gradient");
        expect(html).toContain("motion-reduce:after:animate-none!");
        emit(K.OK, { sentAt: Date.now() });
        html = region().innerHTML;
        expect(html).toContain("after:h-0.5");
        expect(html).not.toContain("after:animate-gradient");
    });
});

describe("<ServerStatusBanner> database cause", () => {
    it("shows the database copy, then the database danger copy after 60 s; semantic warning/danger colours", () => {
        vi.useFakeTimers();
        render(<ServerStatusBanner />);
        emit(K.OUTAGE, { cause: "database" });
        const region = screen.getByTestId("server-status-banner");
        expect(region).toHaveTextContent(SERVER_STATUS_MESSAGES.databaseUnavailable);
        expect(region.innerHTML).toContain("bg-warn-400");
        act(() => vi.advanceTimersByTime(SERVER_DANGER_AFTER_MS));
        expect(region).toHaveTextContent(SERVER_STATUS_MESSAGES.databaseDanger);
        expect(region.innerHTML).toContain("bg-danger-400");
    });

    it("switching the cause swaps the text in place", () => {
        render(<ServerStatusBanner />);
        emit(K.OUTAGE, { cause: "server" });
        expect(screen.getByTestId("server-status-banner")).toHaveTextContent(SERVER_STATUS_MESSAGES.outage);
        emit(K.OUTAGE, { cause: "database" });
        expect(screen.getByTestId("server-status-banner")).toHaveTextContent(SERVER_STATUS_MESSAGES.databaseUnavailable);
    });
});

describe("<ServerStatusBanner> info tone + public router API", () => {
    it("restarting (info) gets the dark soft treatment too, token-based", () => {
        render(<ServerStatusBanner />);
        emit(K.SHUTDOWN);
        const html = screen.getByTestId("server-status-banner").innerHTML;
        for (const c of ["bg-purple-400", "dark:bg-purple-400/15", "dark:text-(--secondary-foreground)", "dark:border-purple-400/40"]) expect(html).toContain(c);
    });

    it("does not use the UNSAFE_ router internals", async () => {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const src = fs.readFileSync(path.resolve(process.cwd(), "src/components/shared/serverStatus/ServerStatusBanner.jsx"), "utf8");
        expect(src).not.toMatch(/UNSAFE_/);
        expect(src).toMatch(/useInRouterContext/);
    });
});

describe("<ServerStatusBanner> outage countdown", () => {
    const countdown = () => screen.queryByTestId("server-status-countdown");
    const region = () => screen.getByTestId("server-status-banner");
    const srNotice = () => region().querySelector(".sr-only")?.textContent;
    const at = (path) => (
        <MemoryRouter initialEntries={[path]}>
            <ServerStatusBanner />
        </MemoryRouter>
    );

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    });
    afterEach(() => {
        cleanup();
        _resetServerLockForTests();
    });

    it("warning (unavailable): ' · Redirecting in 57s' follows the message; the message node stays exact", () => {
        render(<ServerStatusBanner />);
        emit(K.NETWORK_FAILURE);
        act(() => vi.advanceTimersByTime(SERVER_SHOW_AFTER_MS));
        expect(screen.getByText(SERVER_STATUS_MESSAGES.unavailable)).toBeInTheDocument();
        expect(countdown()).toHaveTextContent(/·\s*Redirecting in\s*57\s*s/);
        expect(countdown()).toHaveAttribute("data-seconds", "57");
    });

    it("info (restarting): countdown shown and counts down", () => {
        render(<ServerStatusBanner />);
        emit(K.SHUTDOWN);
        expect(countdown()).toHaveAttribute("data-seconds", "60");
        act(() => vi.advanceTimersByTime(5050));
        expect(countdown()).toHaveAttribute("data-seconds", "55");
    });

    it("the ticking group is aria-hidden and the sr-only notice never changes across ticks", () => {
        render(<ServerStatusBanner />);
        emit(K.SHUTDOWN);
        expect(countdown()).toHaveAttribute("aria-hidden", "true");
        const first = srNotice();
        expect(first).toMatch(/about a minute/);
        for (let i = 0; i < 5; i += 1) act(() => vi.advanceTimersByTime(1000));
        expect(srNotice()).toBe(first);
        expect(region().querySelectorAll(".sr-only")).toHaveLength(1);
    });

    it("says 'shortly' when the banner first appears with less than 45 s left", () => {
        emit(K.SHUTDOWN);
        act(() => vi.advanceTimersByTime(20_000));
        render(<ServerStatusBanner />);
        expect(srNotice()).toMatch(/shortly/);
        expect(countdown()).toHaveAttribute("data-seconds", "40");
    });

    it("visibilitychange resyncs the seconds after a throttled background tab", () => {
        render(<ServerStatusBanner />);
        emit(K.SHUTDOWN);
        vi.setSystemTime(Date.now() + 10_000); // timers were frozen; the wall clock moved
        act(() => {
            document.dispatchEvent(new Event("visibilitychange"));
        });
        expect(countdown()).toHaveAttribute("data-seconds", "50");
    });

    it("shows 'Redirecting…' at 0 before the store flips to danger", () => {
        render(<ServerStatusBanner />);
        emit(K.SHUTDOWN);
        vi.setSystemTime(Date.now() + SERVER_DANGER_AFTER_MS);
        act(() => {
            document.dispatchEvent(new Event("visibilitychange"));
        });
        expect(countdown()).toHaveTextContent("Redirecting…");
        expect(countdown()).toHaveAttribute("data-seconds", "0");
    });

    it("absent in danger (red), on the outage route, once recovered and in the exit latch", () => {
        const { unmount } = render(<ServerStatusBanner />);
        emit(K.SHUTDOWN);
        expect(countdown()).not.toBeNull();
        act(() => vi.advanceTimersByTime(SERVER_DANGER_AFTER_MS));
        expect(region()).toHaveTextContent(SERVER_STATUS_MESSAGES.danger);
        expect(countdown()).toBeNull();
        emit(K.OK);
        expect(countdown()).toBeNull();
        act(() => vi.advanceTimersByTime(SERVER_RECOVERED_MS + SERVER_BANNER_EXIT_MS));
        expect(countdown()).toBeNull();
        unmount();

        // restarting -> recovered: the latched exit payload carries no countdown
        render(<ServerStatusBanner />);
        emit(K.SHUTDOWN);
        emit(K.OK);
        expect(countdown()).toBeNull();
    });

    it("F6: re-picks the sr-only notice when the message changes while the countdown is showing", () => {
        render(<ServerStatusBanner />);
        emit(K.SHUTDOWN);
        expect(srNotice()).toMatch(/about a minute/);
        act(() => vi.advanceTimersByTime(20_000)); // 40 s left: below the "about a minute" threshold
        const before = region().textContent;
        emit(K.OUTAGE); // cause swap -> different message
        expect(region().textContent.split(" ·")[0]).not.toBe(before.split(" ·")[0]);
        expect(countdown()).not.toBeNull();
        expect(srNotice()).toMatch(/shortly/);
    });

    it("absent on the 523 route (silent banner)", () => {
        render(at("/service-is-currently-unavailable"));
        emit(K.OUTAGE);
        expect(region()).toHaveTextContent(SERVER_STATUS_MESSAGES.outage);
        expect(countdown()).toBeNull();
        expect(region().querySelector(".sr-only")).toBeNull();
    });
});

