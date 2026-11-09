/**
 * serviceUnavailable.recovery.test.jsx — the 523 page as a live status screen:
 * per-state copy and classes, the available swap, the persistent primary
 * button, cooldown, offline, dark parity, illustration semantics.
 *
 * Copy comes from the frozen constants (never from the server); a few literals
 * are asserted too so a silent edit of the constants cannot pass.
 */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { serviceRecoveryNavigation } from "../../../src/components/shared/serverStatus";
import { SERVER_DANGER_AFTER_MS, SERVER_STATUS_KIND as K, _resetServerStatusForTests, reportServerStatus } from "../../../src/utils/serverStatus.js";
import { consumeErrorPagePayload, handOffErrorPagePayload, resetErrorPagePayloadCache, stashErrorPagePayload } from "../../../src/utils/storage.js";
import { SERVICE_STATUS_COPY, SERVICE_STATUS_TEST_IDS } from "../../../src/views/errors/serviceStatus.copy.js";
import { BadRequest, InvalidToken, LoginTimeOut, PageNotFound, ServiceUnavailable, SignatureMismatch, TooManyRequests, Unauthorized } from "../../../src/views/errors/ClientErrorResponses.jsx";
import { fail } from "../../helpers/fixtures/contract.js";
import { POOL_SECRETS, dbDownBody } from "../../helpers/fixtures/healthBodies.js";
import { apiUrl } from "../../helpers/msw/api.js";
import { server } from "../../helpers/msw/server.js";
import { renderWithProviders } from "../../helpers/renderWithProviders.jsx";

const T = SERVICE_STATUS_TEST_IDS;
const down = (retryAfter = 30) => new HttpResponse("<html>x</html>", { status: 503, headers: { "content-type": "text/html", "retry-after": String(retryAfter) } });
const draining = () => HttpResponse.json(fail("d", 503, { type: "ServerShuttingDown" }), { status: 503, headers: { "retry-after": "30" } });
const never = () => new Promise(() => {});
const probe = (resolver) => server.use(http.get(apiUrl("health/ready"), resolver));
const setOnline = (v) => Object.defineProperty(navigator, "onLine", { configurable: true, get: () => v });
const panel = () => screen.getByTestId(T.panel);
const liveRegion = () => document.querySelector('[role="status"][aria-live="polite"]');
const renderPage = (props) => renderWithProviders(<ServiceUnavailable {...props} />, { initialEntries: ["/service-is-currently-unavailable"] });

beforeEach(() => {
    _resetServerStatusForTests();
    resetErrorPagePayloadCache();
    vi.spyOn(Math, "random").mockReturnValue(0);
    setOnline(true);
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    _resetServerStatusForTests();
    setOnline(true);
});

describe("ServiceUnavailable — down states", () => {
    it("checking: code 523, default headline, kicker, lead, 'Checking the server…' card, 'If this keeps happening' list, no meta", () => {
        probe(never);
        const { container } = renderPage();
        expect(panel()).toHaveAttribute("data-service-status", "checking");
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("523");
        expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Service Unavailable");
        expect(screen.getByText("The server is napping.")).toBeInTheDocument();
        expect(within(panel()).getByText("Checking the server…")).toBeInTheDocument();
        expect(within(panel()).getByText("Asking the server if it's awake. You don't need to refresh.")).toBeInTheDocument();
        expect(screen.getByText(/If this keeps happening/)).toBeInTheDocument();
        expect(screen.queryByTestId(T.check)).toBeNull();
        expect(liveRegion()).toHaveTextContent("Checking whether the service is back.");
        expect(liveRegion()).toHaveAttribute("aria-atomic", "true");
        expect(container.querySelector("[data-service-illustration]")).toHaveAttribute("aria-hidden", "true");
    });

    it("unavailable: card, meta line (last checked / attempt / next check) and a progress cue", async () => {
        probe(() => down());
        renderPage();
        await waitFor(() => expect(panel()).toHaveAttribute("data-service-status", "unavailable"));
        expect(within(panel()).getByText("Retrying automatically")).toBeInTheDocument();
        expect(within(panel()).getByText("We'll keep checking every few seconds.")).toBeInTheDocument();
        const meta = screen.getByTestId(T.check);
        expect(meta).toHaveTextContent(/Last checked \d{2}:\d{2}:\d{2}/);
        expect(meta).toHaveTextContent(/Attempt 1/);
        expect(meta).toHaveTextContent(/Next check in \d+ s/); // no "~": drawn like a minus in the Aumovio face
        expect(meta.querySelector("[aria-live]")).toBeNull(); // the meta line is outside the live region
        expect(liveRegion()).toHaveTextContent("Service unavailable. Retrying automatically.");
        expect(meta.className).toMatch(/text-grey-600/);
        expect(meta.className).toMatch(/dark:text-grey-400/);
    });

    it("restarting: copy and accent stripe", async () => {
        probe(() => draining());
        renderPage();
        await waitFor(() => expect(panel()).toHaveAttribute("data-service-status", "restarting"));
        expect(within(panel()).getByText("The server is restarting")).toBeInTheDocument();
        expect(within(panel()).getByText("This usually takes under a minute. We'll reconnect on our own.")).toBeInTheDocument();
        expect(panel().className).toContain("border-l-(--accent)");
        expect(liveRegion()).toHaveTextContent("The server is restarting. Retrying automatically.");
    });

    it("danger after 60 s: copy, danger stripe and the system-administrator hint", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        probe(never);
        renderPage();
        await act(async () => {
            vi.advanceTimersByTime(SERVER_DANGER_AFTER_MS);
        });
        expect(panel()).toHaveAttribute("data-service-status", "danger");
        expect(within(panel()).getByText("Still unavailable")).toBeInTheDocument();
        expect(panel()).toHaveTextContent(/contact your system administrator and quote the Request ID below/);
        expect(panel().className).toContain("border-l-(--status-danger-base)");
        expect(liveRegion()).toHaveTextContent("Service still unavailable. Retrying. Contact your system administrator if this continues.");
        vi.useRealTimers();
    });

    it("offline: copy, warning stripe, and the primary button is disabled", () => {
        setOnline(false);
        probe(never);
        renderPage();
        expect(panel()).toHaveAttribute("data-service-status", "offline");
        expect(within(panel()).getByText("You're offline")).toBeInTheDocument();
        expect(within(panel()).getByText("We'll retry as soon as your connection is back.")).toBeInTheDocument();
        expect(screen.getByTestId(T.cta)).toHaveAttribute("aria-disabled", "true"); // never natively disabled (Q1: focus)
        expect(panel().className).toContain("border-l-(--status-warning-base)");
        expect(liveRegion()).toHaveTextContent("You are offline. Retrying when your connection returns.");
    });

    it.each([
        ["checking", "border-l-(--accent)", "text-(--accent-foreground)"],
        ["unavailable", "border-l-(--status-warning-base)", "text-(--status-warning-text)"],
    ])("%s card tokens", async (state, stripe, title) => {
        probe(state === "checking" ? never : () => down());
        renderPage();
        await waitFor(() => expect(panel()).toHaveAttribute("data-service-status", state));
        expect(panel().className).toContain(stripe);
        expect(panel().innerHTML).toContain(title);
    });

    it("card container is token-styled with dark parity", () => {
        probe(never);
        renderPage();
        const c = panel().className;
        for (const cls of ["p-4", "rounded-xl", "border", "border-(--color-card-surface-border)", "bg-white/60", "dark:bg-white/5", "border-l-4", "transition-colors-fast"]) expect(c).toContain(cls);
    });

    it("primary action is 'Check again' (outline) with a secondary 'Go to home' link", () => {
        probe(never);
        renderPage();
        expect(screen.getByTestId(T.cta)).toHaveTextContent("Check again");
        expect(screen.getByRole("link", { name: "Go to home" })).toHaveAttribute("href", "/");
        expect(screen.queryByRole("link", { name: "Try the home page" })).toBeNull();
    });

    it("a valid returnTo turns the secondary into 'Try anyway'", () => {
        stashErrorPagePayload({ code: 503, title: null, message: null, requestId: null, returnTo: "/system/data-purge?tab=1" });
        probe(never);
        renderPage();
        expect(screen.getByRole("button", { name: "Try anyway" })).toBeInTheDocument(); // button, not a link carrying the query
    });

    it("an invalid returnTo is ignored (no off-origin link)", () => {
        stashErrorPagePayload({ code: 503, title: null, message: null, requestId: null, returnTo: "//evil.com" });
        probe(never);
        const { container } = renderPage();
        expect(container.innerHTML).not.toContain("evil.com");
        expect(screen.getByRole("link", { name: "Go to home" })).toHaveAttribute("href", "/");
    });

    it("Check again: probes at once, button shows busy + disabled during the cooldown", async () => {
        const user = userEvent.setup();
        let hits = 0;
        probe(() => ((hits += 1), down()));
        renderPage();
        await waitFor(() => expect(hits).toBe(1));
        const cta = screen.getByTestId(T.cta);
        await user.click(cta);
        expect(cta).toHaveAttribute("aria-disabled", "true");
        await waitFor(() => expect(hits).toBe(2), { timeout: 1500 });
    });
});

describe("ServiceUnavailable — payload and code label", () => {
    it("shows the stashed real status (503) as the code and renders the Request ID", () => {
        stashErrorPagePayload({ code: 503, title: "Database down", message: "Pool exhausted.", requestId: "REQ-503-A" });
        probe(never);
        renderPage();
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("503");
        expect(screen.getByText(/REQ-503-A/)).toBeInTheDocument();
        expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Database down");
        expect(screen.getByText("Pool exhausted.")).toBeInTheDocument();
    });

    it.each([502, 503, 504, 523])("accepts a stash whose code is %i", (code) => {
        stashErrorPagePayload({ code, title: `T${code}`, message: "m", requestId: `R${code}` });
        probe(never);
        renderPage();
        expect(screen.getByText(`R${code}`, { exact: false })).toBeInTheDocument();
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(String(code));
    });

    it("ignores a stash for another page (440): default headline and code 523", () => {
        stashErrorPagePayload({ code: 440, title: "Session over", message: "x", requestId: "R440" });
        probe(never);
        renderPage();
        expect(screen.queryByText("Session over")).toBeNull();
        expect(screen.queryByText(/R440/)).toBeNull();
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("523");
    });
});

describe("ServiceUnavailable — available", () => {
    it("swaps code/label/headline/lead/actions, drops the kicker and the list; server headline loses to 'Service Available'", async () => {
        stashErrorPagePayload({ code: 503, title: "Database down", message: "Pool exhausted.", requestId: "REQ-X", returnTo: "/dashboard" });
        let up = false;
        probe(() => (up ? HttpResponse.json({ status: "ready" }) : down(1)));
        renderPage();
        await waitFor(() => expect(panel()).toHaveAttribute("data-service-status", "unavailable"));
        const cta = screen.getByTestId(T.cta);
        expect(cta).toHaveTextContent("Check again");

        up = true;
        await waitFor(() => expect(panel()).toHaveAttribute("data-service-status", "available"), { timeout: 5000 });
        expect(screen.getByTestId(T.cta)).toBe(cta); // same DOM node: focus and ripple survive
        expect(cta).toHaveTextContent("Continue where you left off");
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("200");
        expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Service Available");
        expect(screen.queryByText("Database down")).toBeNull();
        expect(screen.getByText("The server is back. Nothing else to do.")).toBeInTheDocument();
        expect(screen.queryByText("The server is napping.")).toBeNull();
        expect(screen.queryByText(/If this keeps happening/)).toBeNull();
        expect(within(panel()).getByText(/Back online at \d{2}:\d{2}:\d{2}/)).toBeInTheDocument();
        expect(within(panel()).getByText(/Down for .*\. Pick up where you left off\./)).toBeInTheDocument();
        expect(screen.getByText("Returns you to /dashboard")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Go to home" })).toBeInTheDocument();
        expect(screen.queryByTestId(T.check)).toBeNull();
        expect(panel().className).toContain("border-l-(--status-success-base)");
        expect(liveRegion()).toHaveTextContent("Service available. You can continue.");
        expect(screen.getByText("Status")).toBeInTheDocument();
    }, 15_000);

    it("Continue navigates through the seam to the validated returnTo", async () => {
        const go = vi.spyOn(serviceRecoveryNavigation, "go").mockImplementation(() => {});
        const user = userEvent.setup();
        stashErrorPagePayload({ code: 503, title: null, message: null, requestId: null, returnTo: "/dashboard" });
        probe(() => HttpResponse.json({ status: "ready" }));
        renderPage();
        await waitFor(() => expect(panel()).toHaveAttribute("data-service-status", "available"), { timeout: 5000 });
        await user.click(screen.getByTestId(T.cta));
        expect(go).toHaveBeenCalledWith("/dashboard");
    });

    it("entered by SPA navigation (server-lock hand-off after an earlier error page): Continue returns to the stashed path + query", async () => {
        const go = vi.spyOn(serviceRecoveryNavigation, "go").mockImplementation(() => {});
        const user = userEvent.setup();
        consumeErrorPagePayload(); // an earlier error page in this document memoised "no payload"
        handOffErrorPagePayload({ code: 523, title: null, message: null, requestId: null, retryAfter: null, returnTo: "/system/data-purge?page=3" });
        probe(() => HttpResponse.json({ status: "ready" }));
        renderPage();
        await waitFor(() => expect(panel()).toHaveAttribute("data-service-status", "available"), { timeout: 5000 });
        await user.click(screen.getByTestId(T.cta));
        expect(go).toHaveBeenCalledWith("/system/data-purge?page=3");
    });

    it("Continue falls back to '/' and shows no helper path when there is no returnTo", async () => {
        const go = vi.spyOn(serviceRecoveryNavigation, "go").mockImplementation(() => {});
        const user = userEvent.setup();
        probe(() => HttpResponse.json({ status: "ready" }));
        renderPage();
        await waitFor(() => expect(panel()).toHaveAttribute("data-service-status", "available"), { timeout: 5000 });
        expect(screen.queryByText(/Returns you to/)).toBeNull();
        await user.click(screen.getByTestId(T.cta));
        expect(go).toHaveBeenCalledWith("/");
    });

    it("success code uses the success token", async () => {
        probe(() => HttpResponse.json({ status: "ready" }));
        renderPage();
        await waitFor(() => expect(panel()).toHaveAttribute("data-service-status", "available"), { timeout: 5000 });
        expect(screen.getByRole("heading", { level: 1 }).className).toContain("text-(--status-success-text)");
    });
});

describe("ServiceUnavailable — structure and hygiene", () => {
    it("the other seven pages render no status panel and keep their NavLink button", () => {
        for (const Page of [BadRequest, Unauthorized, PageNotFound, SignatureMismatch, TooManyRequests, LoginTimeOut, InvalidToken]) {
            const { unmount } = renderWithProviders(<Page />);
            expect(screen.queryByTestId(T.panel)).toBeNull();
            expect(screen.queryByTestId(T.cta)).toBeNull();
            unmount();
        }
    });

    it("never renders server text inside the panel (copy constants only)", () => {
        stashErrorPagePayload({ code: 503, title: "<b>EVIL-TITLE</b>", message: "EVIL-MESSAGE", requestId: "r" });
        probe(never);
        renderPage();
        expect(panel().textContent).not.toMatch(/EVIL/);
        expect(panel().textContent).toContain(SERVICE_STATUS_COPY.checking.cardTitle);
    });

    it("no raw palette-anchor foregrounds (text-purple-*/text-orange-*) anywhere on the page", () => {
        probe(never);
        const { container } = renderPage();
        expect(container.innerHTML).not.toMatch(/\btext-(purple|orange)-\d{2,3}\b/);
    });

    it("the page keeps its animated entrance wrappers with a reduced-motion-safe illustration", () => {
        probe(never);
        const { container } = renderPage();
        const illus = container.querySelector("[data-service-illustration]");
        expect(illus).not.toBeNull();
        expect(illus.querySelector('[class*="motion-reduce:hidden"], [class*="motion-reduce:animate-none"]')).not.toBeNull();
    });
});

describe("ServiceUnavailable — database cause", () => {
    const dbDown = () => HttpResponse.json(dbDownBody(), { status: 503, headers: { "retry-after": "30" } });

    it("database status: card, live text, warning tokens, meta line still shown", async () => {
        probe(() => dbDown());
        renderPage();
        await waitFor(() => expect(panel()).toHaveAttribute("data-service-status", "database"));
        expect(within(panel()).getByText("The database isn't responding")).toBeInTheDocument();
        expect(within(panel()).getByText("The server is up, but it can't reach its database. We'll keep checking.")).toBeInTheDocument();
        expect(panel().className).toContain("border-l-(--status-warning-base)");
        expect(panel().innerHTML).toContain("text-(--status-warning-text)");
        expect(liveRegion()).toHaveTextContent("Database unavailable. Retrying automatically.");
        expect(screen.getByTestId(T.check)).toHaveTextContent(/Attempt 1/);
        // Nothing stashed (opened directly) + API up / DB down = 503, not 523 "Origin Unreachable".
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("503");
    });

    it("database + 60 s: status danger, database danger copy, danger tokens", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        probe(() => new Promise(() => {}));
        renderPage();
        await act(async () => {
            vi.advanceTimersByTime(1);
        });
        act(() => reportServerStatus(K.OUTAGE, { cause: "database" }));
        await act(async () => {
            vi.advanceTimersByTime(SERVER_DANGER_AFTER_MS);
        });
        expect(panel()).toHaveAttribute("data-service-status", "danger");
        expect(within(panel()).getByText("The database still isn't responding")).toBeInTheDocument();
        expect(panel().className).toContain("border-l-(--status-danger-base)");
        expect(liveRegion()).toHaveTextContent("Database still unavailable. Retrying. Contact your system administrator if this continues.");
        vi.useRealTimers();
    });

    it("server down shows the server copy (never the database copy)", async () => {
        probe(() => down());
        renderPage();
        await waitFor(() => expect(panel()).toHaveAttribute("data-service-status", "unavailable"));
        expect(panel().textContent).not.toMatch(/database/i);
    });

    it("never renders pool names or check details", async () => {
        probe(() => dbDown());
        const { container } = renderPage();
        await waitFor(() => expect(panel()).toHaveAttribute("data-service-status", "database"));
        for (const s of POOL_SECRETS) expect(container.innerHTML).not.toContain(s);
    });
});
