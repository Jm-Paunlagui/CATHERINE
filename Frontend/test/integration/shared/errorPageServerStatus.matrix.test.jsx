/**
 * errorPageServerStatus.matrix.test.jsx — 6-matrix gap fill (integration column), through the real
 * App shell, store, HttpClient and probe loop. MSW is the only fake.
 *
 *   B2  an ordinary app request answering 200 during the outage (HttpClient reports OK WITHOUT
 *       `healthy`) does not recover the page; only the probe's 200 does.
 *   B3  a DB-down readiness body: page status "database", the banner names the database, the code
 *       is 503 (nothing stashed + DB down) and no pool name reaches the DOM.
 *   B6  real HttpClient takeover from /system/data-purge?tab=2 -> stash carries returnTo -> the page shows
 *       "Try anyway" to it, and after recovery Continue navigates there through the seam.
 *   B7  the same real stash carries the REAL status (503) and Request ID -> 503 code + Request ID shown.
 *   B8  on the 523 route inside App the banner is the status tone (warning fill, dark soft classes,
 *       palette hairline) and SILENT.
 *   B10 banner + page both mount the probe hook inside App: one probe in flight.
 *   B11 inside App on the 523 route exactly one polite region speaks (the page's).
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import httpClient from "../../../src/middleware/HttpClient";
import { SERVER_STATUS_MESSAGES, serviceRecoveryNavigation } from "../../../src/components/shared/serverStatus";
import { _resetServerStatusForTests, getServerStatusSnapshot } from "../../../src/utils/serverStatus.js";
import { resetErrorPagePayloadCache } from "../../../src/utils/storage.js";
import { fail } from "../../helpers/fixtures/contract.js";
import { POOL_SECRETS, dbDownBody } from "../../helpers/fixtures/healthBodies.js";
import { apiUrl } from "../../helpers/msw/api.js";
import { server } from "../../helpers/msw/server.js";
import { renderWithProviders } from "../../helpers/renderWithProviders.jsx";

const { default: App } = await import("../../../src/App.jsx");

const ROUTE = "/service-is-currently-unavailable";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const down = (retryAfter = 1) => new HttpResponse("<html>Bad gateway</html>", { status: 503, headers: { "content-type": "text/html", "retry-after": String(retryAfter) } });
const banner = () => screen.queryByTestId("server-status-banner");
const panel = () => screen.queryByTestId("service-status-panel");

beforeEach(() => {
    _resetServerStatusForTests();
    resetErrorPagePayloadCache();
    sessionStorage.clear();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(httpClient, "_navigate").mockImplementation(() => {});
    localStorage.setItem("aumovio-layout", "top");
    // VersionProvider resolves the badge from the public latest-entry endpoint.
    server.use(http.get(apiUrl("changelog/public/latest"), () => HttpResponse.json({ status: "success", code: 200, message: "ok", data: null })));
    // jsdom has no Element#scrollTo; App's ScrollToTop calls it on every route change.
    if (typeof Element.prototype.scrollTo !== "function") Element.prototype.scrollTo = () => {};
});
afterEach(() => {
    vi.restoreAllMocks();
    _resetServerStatusForTests();
    window.history.replaceState(null, "", "/");
});

describe("523 page in App — matrix gap fill", () => {
    it("B2: an ordinary app 200 during the outage does not recover the page; the probe 200 does", async () => {
        let up = false;
        server.use(
            http.get(apiUrl("health/ready"), () => (up ? HttpResponse.json({ status: "ready" }) : down(1))),
            http.get(apiUrl("matrix/ping"), () => HttpResponse.json({ status: "success", code: 200, message: "ok", data: {} })),
        );
        renderWithProviders(<App />, { initialEntries: [ROUTE] });
        await waitFor(() => expect(panel()).toHaveAttribute("data-service-status", "unavailable"));

        await httpClient.get("matrix/ping"); // HttpClient reports OK (no `healthy`) for any response < 500
        await sleep(300);
        expect(panel()).toHaveAttribute("data-service-status", "unavailable");
        expect(getServerStatusSnapshot()).toMatchObject({ phase: "unavailable", outage: true });

        up = true;
        await waitFor(() => expect(panel()).toHaveAttribute("data-service-status", "available"), { timeout: 6000 });
    }, 15_000);

    it("B3: DB-down readiness -> page 'database', banner names the database, code 503, no pool names in the DOM", async () => {
        server.use(http.get(apiUrl("health/ready"), () => HttpResponse.json(dbDownBody(), { status: 503, headers: { "retry-after": "30" } })));
        const { container } = renderWithProviders(<App />, { initialEntries: [ROUTE] });
        await waitFor(() => expect(panel()).toHaveAttribute("data-service-status", "database"));
        expect(banner()).toHaveTextContent(SERVER_STATUS_MESSAGES.databaseUnavailable);
        expect(getServerStatusSnapshot().cause).toBe("database");
        // Nothing stashed + API up / DB down = 503, not 523 "Origin Unreachable".
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("503");
        for (const s of POOL_SECRETS) expect(container.innerHTML).not.toContain(s);
    });

    it("B6+B7: real HttpClient takeover stash (503 DB outage from /system/data-purge?tab=2) drives code, Request ID, Try anyway and Continue", async () => {
        const go = vi.spyOn(serviceRecoveryNavigation, "go").mockImplementation(() => {});
        const user = userEvent.setup();
        window.history.replaceState(null, "", "/system/data-purge?tab=2");
        server.use(
            http.get(apiUrl("matrix/report"), () =>
                HttpResponse.json({ ...fail("Database unavailable.", 503, { type: "DatabaseUnavailableError" }), requestId: "REQ-MATRIX-503" }, { status: 503, headers: { "x-request-id": "REQ-MATRIX-503" } }),
            ),
        );
        await expect(httpClient.get("matrix/report")).rejects.toBeTruthy();
        expect(httpClient._navigate).toHaveBeenCalledWith(ROUTE);
        window.history.replaceState(null, "", ROUTE); // the hard navigation itself

        let up = false;
        server.use(http.get(apiUrl("health/ready"), () => (up ? HttpResponse.json({ status: "ready" }) : down(1))));
        renderWithProviders(<App />, { initialEntries: [ROUTE] });
        await waitFor(() => expect(panel()).toHaveAttribute("data-service-status", "unavailable"));
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("503");
        expect(screen.getByText(/REQ-MATRIX-503/)).toBeInTheDocument();
        // "Try anyway" is a button, so no query string sits in a DOM href.
        expect(screen.getByRole("button", { name: "Try anyway" })).toBeInTheDocument();

        up = true;
        await waitFor(() => expect(panel()).toHaveAttribute("data-service-status", "available"), { timeout: 6000 });
        expect(screen.getByText("Returns you to /system/data-purge")).toBeInTheDocument(); // pathname only
        await user.click(screen.getByTestId("service-status-cta"));
        expect(go).toHaveBeenCalledTimes(1);
        expect(go).toHaveBeenCalledWith("/system/data-purge?tab=2");
    }, 15_000);

    it("B8+B11: on the 523 route the banner is the silent status tone; only the page's region speaks", async () => {
        server.use(http.get(apiUrl("health/ready"), () => down(30)));
        renderWithProviders(<App />, { initialEntries: [ROUTE] });
        await waitFor(() => expect(panel()).toHaveAttribute("data-service-status", "unavailable"));
        const b = banner();
        expect(b).toHaveAttribute("aria-live", "off");
        expect(b).not.toHaveAttribute("role");
        for (const c of ["bg-warn-400", "dark:bg-(--status-warning-bg)", "after:h-0.5", "after:from-(--color-gradient-from)"]) expect(b.innerHTML).toContain(c);
        expect(b.innerHTML).not.toContain("after:animate-gradient"); // only while restarting
        const speaking = [...document.querySelectorAll('[aria-live="polite"], [aria-live="assertive"]')].filter((r) => r.textContent.trim() !== "");
        expect(speaking).toHaveLength(1);
        expect(speaking[0]).toHaveTextContent("Service unavailable. Retrying automatically.");
        expect(b.contains(speaking[0])).toBe(false);
    });

    it("on the 523 route there is no countdown, no lock, and still exactly one speaking region", async () => {
        server.use(http.get(apiUrl("health/ready"), () => down(30)));
        renderWithProviders(<App />, { initialEntries: [ROUTE] });
        await waitFor(() => expect(panel()).toHaveAttribute("data-service-status", "unavailable"));
        expect(screen.queryByTestId("server-status-countdown")).toBeNull();
        expect(document.documentElement).not.toHaveAttribute("data-server-locked");
        const speaking = [...document.querySelectorAll('[aria-live="polite"], [aria-live="assertive"]')].filter((r) => r.textContent.trim() !== "");
        expect(speaking).toHaveLength(1);
    });

    it("B10: banner and page both mount the probe hook inside App, yet one probe is in flight at a time", async () => {
        let inFlight = 0;
        let peak = 0;
        let hits = 0;
        server.use(
            http.get(apiUrl("health/ready"), async () => {
                hits += 1;
                inFlight += 1;
                peak = Math.max(peak, inFlight);
                await sleep(80);
                inFlight -= 1;
                return down(1);
            }),
        );
        renderWithProviders(<App />, { initialEntries: [ROUTE] });
        await waitFor(() => expect(hits).toBeGreaterThanOrEqual(2), { timeout: 5000 });
        expect(peak).toBe(1);
    }, 10_000);
});
