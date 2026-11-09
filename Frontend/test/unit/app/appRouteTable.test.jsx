/**
 * appRouteTable.test.jsx — src/App.jsx's route table, rendered.
 *
 * WHAT IS REAL HERE
 *   The <Routes> tree, every <ProtectedRoute> wrapper, AuthMiddleware.isAuth()
 *   over MSW, Suspense, the per-pathname ErrorBoundary, and all chrome
 *   components (including the server-status banner/watch and ServerLockGuard).
 *
 * WHAT IS STUBBED, AND WHY
 *   The `lazy()` feature views (test/helpers/routeViewStub.jsx). The question
 *   this file answers is "does path X resolve to module Y behind gate Z"; the
 *   views' own behaviour is covered by their feature suites. The marker's TEXT
 *   is what is asserted — never that a mock was called.
 *
 *   The eight error screens are NOT stubbed: they are static imports, cheap,
 *   and their status code in the <h1> is the cleanest proof the right element
 *   rendered.
 *
 * ROLE MATRIX — copied from src/App.jsx. Every route is driven once per role
 * its wrapper admits, so a role silently dropped from an array fails here.
 *
 * Layout preference is pinned to "top" (localStorage `aumovio-layout`) so
 * every route here renders the same chrome; LayoutContext's real default is
 * "sidebar".
 */

import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AuthMiddleware from "../../../src/middleware/authentication/AuthMiddleware.js";
import { loginAs } from "../../helpers/auth.js";
import { _resetServerStatusForTests } from "../../../src/utils/serverStatus.js";
import { ok } from "../../helpers/fixtures/contract.js";
import { apiUrl } from "../../helpers/msw/api.js";
import { server } from "../../helpers/msw/server.js";
import { renderWithProviders } from "../../helpers/renderWithProviders.jsx";

// ── The lazy view modules, each replaced by a text marker ───────────────────
vi.mock("../../../src/features/auth/Login.view", async () => ({ default: (await import("../../helpers/routeViewStub.jsx")).makeStubView("auth/Login") }));
vi.mock("../../../src/features/auth/Logout.view", async () => ({ default: (await import("../../helpers/routeViewStub.jsx")).makeStubView("auth/Logout") }));
vi.mock("../../../src/features/auth/ChangePassword.view", async () => ({ default: (await import("../../helpers/routeViewStub.jsx")).makeStubView("auth/ChangePassword") }));
vi.mock("../../../src/features/dashboard/Dashboard.view", async () => ({ default: (await import("../../helpers/routeViewStub.jsx")).makeStubView("dashboard/Dashboard") }));
vi.mock("../../../src/features/home/Home.view", async () => ({ default: (await import("../../helpers/routeViewStub.jsx")).makeStubView("home/Home") }));
vi.mock("../../../src/features/other/gettingstarted/GettingStarted.view", async () => ({ default: (await import("../../helpers/routeViewStub.jsx")).makeStubView("other/GettingStarted") }));
vi.mock("../../../src/features/other/databaseconnection/DatabaseConnection.view", async () => ({ default: (await import("../../helpers/routeViewStub.jsx")).makeStubView("other/DatabaseConnection") }));
vi.mock("../../../src/features/other/miraorm/MiraOrm.view", async () => ({ default: (await import("../../helpers/routeViewStub.jsx")).makeStubView("other/MiraOrm") }));
vi.mock("../../../src/features/other/money/Money.view", async () => ({ default: (await import("../../helpers/routeViewStub.jsx")).makeStubView("other/Money") }));
vi.mock("../../../src/features/other/corssetup/CORSSetup.view", async () => ({ default: (await import("../../helpers/routeViewStub.jsx")).makeStubView("other/CORSSetup") }));
vi.mock("../../../src/features/systemadmin/adminmanagement/AdminManagement.view", async () => ({ default: (await import("../../helpers/routeViewStub.jsx")).makeStubView("systemadmin/AdminManagement") }));
vi.mock("../../../src/features/systemadmin/logsmanagement/LogsManagement.view", async () => ({ default: (await import("../../helpers/routeViewStub.jsx")).makeStubView("systemadmin/LogsManagement") }));
vi.mock("../../../src/features/systemadmin/integrity/IntegrityCenter.view", async () => ({ default: (await import("../../helpers/routeViewStub.jsx")).makeStubView("systemadmin/IntegrityCenter") }));
vi.mock("../../../src/features/systemadmin/datapurge/DataPurge.view", async () => ({ default: (await import("../../helpers/routeViewStub.jsx")).makeStubView("systemadmin/DataPurge") }));
vi.mock("../../../src/features/support/changelog/Changelog.view", async () => ({ default: (await import("../../helpers/routeViewStub.jsx")).makeStubView("support/Changelog") }));
vi.mock("../../../src/features/support/help/Help.view", async () => ({ default: (await import("../../helpers/routeViewStub.jsx")).makeStubView("support/Help") }));
vi.mock("../../../src/features/support/devdocs/DevDocs.view", async () => ({ default: (await import("../../helpers/routeViewStub.jsx")).makeStubView("support/DevDocs") }));
vi.mock("../../../src/features/support/architecture/Architecture.view", async () => ({ default: (await import("../../helpers/routeViewStub.jsx")).makeStubView("support/Architecture") }));
vi.mock("../../../src/features/support/runtime/Runtime.view", async () => ({ default: (await import("../../helpers/routeViewStub.jsx")).makeStubView("support/Runtime") }));

// Imported AFTER the mocks.
const { default: App } = await import("../../../src/App.jsx");

// Mirrors App.jsx ROLES verbatim (ROLES is not exported).
const ROLES = { SADMIN: "SUPER_ADMIN", ADMIN: "ADMIN", USER: "USER" };
const ALL_ROLES = [ROLES.USER, ROLES.ADMIN, ROLES.SADMIN];

beforeEach(() => {
    // A previous test's loginAs() leaves the session hint behind; signed-out tests must start signed out.
    localStorage.clear();
    sessionStorage.clear();
    AuthMiddleware.clearAuthCache();
    // Pin the layout preference; LayoutContext.loadLayout() reads this key and
    // otherwise falls back to "sidebar".
    localStorage.setItem("aumovio-layout", "top");
    // VersionProvider resolves the badge from the public latest-entry endpoint.
    server.use(
        http.get(apiUrl("changelog/public/latest"), () => HttpResponse.json(ok("Data fetched successfully.", null))),
        // The 523 page probes readiness on mount.
        http.get(apiUrl("health/ready"), () => HttpResponse.json(ok("Service ready", { ready: true }))),
    );
    // jsdom implements window.scrollTo (as a not-implemented stub) but not Element#scrollTo;
    // App's ScrollToTop calls both on every route change.
    if (typeof Element.prototype.scrollTo !== "function") Element.prototype.scrollTo = () => {};
});

afterEach(() => {
    // The 523 page seeds an OUTAGE on mount; without this the store leaks into the next test and the
    // server lock (correctly) makes that test's controls inert.
    _resetServerStatusForTests();
});

/** Routes with no ProtectedRoute wrapper at all. */
const PUBLIC_ROUTES = [
    { path: "/home", view: "home/Home" },
    { path: "/auth", view: "auth/Login" },
    { path: "/user/logout", view: "auth/Logout" },
    { path: "/about/getting-started", view: "other/GettingStarted" },
    { path: "/about/database-connection", view: "other/DatabaseConnection" },
    { path: "/about/mira-orm", view: "other/MiraOrm" },
    { path: "/about/money", view: "other/Money" },
    { path: "/about/cors-setup", view: "other/CORSSetup" },
    { path: "/about/changelog", view: "support/Changelog" },
    { path: "/about/help", view: "support/Help" },
];

/** Every route behind a <ProtectedRoute>, with the exact role array guarding it. */
const GATED_ROUTES = [
    { path: "/auth/change-password", view: "auth/ChangePassword", allow: ALL_ROLES },
    { path: "/dashboard", view: "dashboard/Dashboard", allow: ALL_ROLES },
    { path: "/system/admin-management", view: "systemadmin/AdminManagement", allow: [ROLES.SADMIN] },
    { path: "/system/logging-and-observability", view: "systemadmin/LogsManagement", allow: [ROLES.SADMIN] },
    { path: "/system/data-integrity", view: "systemadmin/IntegrityCenter", allow: [ROLES.SADMIN] },
    { path: "/system/data-purge", view: "systemadmin/DataPurge", allow: [ROLES.SADMIN] },
    { path: "/support/dev-docs", view: "support/DevDocs", allow: [ROLES.ADMIN, ROLES.SADMIN] },
    { path: "/support/architecture", view: "support/Architecture", allow: [ROLES.SADMIN] },
    { path: "/support/runtime", view: "support/Runtime", allow: [ROLES.SADMIN] },
];

/** Flattened (route, allowed-role) pairs — one test each. */
const ALLOWED_PAIRS = GATED_ROUTES.flatMap(({ path, view, allow }) => allow.map((role) => ({ path, view, role })));

/** The eight error screens, each a static (non-lazy) import in App.jsx. */
const ERROR_ROUTES = [
    { path: "/bad-request", code: "400" },
    { path: "/unauthorized", code: "401" },
    { path: "/page-not-found", code: "404" },
    { path: "/signature-mismatch", code: "422" },
    { path: "/too-many-requests", code: "429" },
    { path: "/login-timeout", code: "440" },
    { path: "/invalid-token", code: "498" },
    { path: "/service-is-currently-unavailable", code: "523" },
];

describe("App route table — public routes (no ProtectedRoute wrapper)", () => {
    it.each(PUBLIC_ROUTES)("$path renders $view for an unauthenticated visitor", async ({ path, view }) => {
        renderWithProviders(<App />, { initialEntries: [path] });
        expect(await screen.findByText(`view:${view}`)).toBeInTheDocument();
    });

    it('"/" redirects to /home', async () => {
        renderWithProviders(<App />, { initialEntries: ["/"] });
        expect(await screen.findByText("view:home/Home")).toBeInTheDocument();
    });
});

describe("App route table — gated routes render for every role the wrapper admits", () => {
    it.each(ALLOWED_PAIRS)("$path renders $view for $role", async ({ path, view, role }) => {
        loginAs(role);
        renderWithProviders(<App />, { initialEntries: [path] });
        expect(await screen.findByText(`view:${view}`)).toBeInTheDocument();
    });
});

describe("App route table — error screens (static imports, not lazy)", () => {
    it.each(ERROR_ROUTES)("$path renders the $code screen", async ({ path, code }) => {
        const { container } = renderWithProviders(<App />, { initialEntries: [path] });
        // The ambient decorations render loose digits, so the <h1> display is the unambiguous target.
        await screen.findByRole("heading", { level: 1 });
        expect(container.querySelector("h1")?.textContent).toBe(code);
    });
});

describe("App route table — the catch-all", () => {
    const UNKNOWN_PATHS = [["/nope"], ["/system"], ["/support"], ["/about"], ["/a/b/c/d"]];

    it.each(UNKNOWN_PATHS)('%s falls through path="*" to the 404 screen', async (path) => {
        const { container } = renderWithProviders(<App />, { initialEntries: [path] });
        await screen.findByRole("heading", { level: 1 });
        expect(container.querySelector("h1")?.textContent).toBe("404");
    });

    it("an unknown path under an existing prefix still lands on 404, not on the prefix's view", async () => {
        // `/about/help/anything` must not render support/Help — react-router only
        // matches `about/help` exactly, so the catch-all owns it.
        renderWithProviders(<App />, { initialEntries: ["/about/help/anything"] });
        await screen.findByRole("heading", { level: 1 });
        expect(screen.queryByText("view:support/Help")).not.toBeInTheDocument();
    });
});

describe("App route table — navigating inside one mounted app", () => {
    // Every assertion above mounts a FRESH tree. This one keeps a single tree
    // mounted across navigations, which is the only way to exercise the route
    // table on a re-render. A route table that renders correctly on first mount
    // but not after a navigation is a real and common failure (a mis-keyed
    // ErrorBoundary is exactly that bug).
    it("follows the real navbar links from Help to Home to the sign-in screen", async () => {
        const user = userEvent.setup();
        renderWithProviders(<App />, { initialEntries: ["/about/help"] });

        expect(await screen.findByText("view:support/Help")).toBeInTheDocument();

        // Several "Home" links may be on screen (navbar, breadcrumb root). Pick by destination.
        const navbarHome = screen.getAllByRole("link", { name: "Home" }).find((a) => a.getAttribute("href") === "/home");
        expect(navbarHome, "navbar Home link").toBeDefined();
        await user.click(navbarHome);
        expect(await screen.findByText("view:home/Home")).toBeInTheDocument();

        // Chrome -> bare. All chrome goes.
        await user.click(screen.getAllByRole("link", { name: "Sign In" })[0]);
        expect(await screen.findByText("view:auth/Login")).toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "Sign In" })).not.toBeInTheDocument();
    });

    it("keeps the 404 screen's way out working (the catch-all is not a dead end)", async () => {
        const user = userEvent.setup();
        renderWithProviders(<App />, { initialEntries: ["/nope"] });

        await screen.findByRole("heading", { level: 1 });
        await user.click(screen.getByRole("link", { name: "Beam me home" }));
        expect(await screen.findByText("view:home/Home")).toBeInTheDocument();
    });

    it.each([["top"], ["sidebar"]])('re-rendering the tree in place ("%s" layout) resolves the same route, not a stale or duplicated one', async (mode) => {
        localStorage.setItem("aumovio-layout", mode);
        loginAs(ROLES.SADMIN);
        const { rerender } = renderWithProviders(<App />, { initialEntries: ["/system/data-purge"] });

        expect(await screen.findByText("view:systemadmin/DataPurge")).toBeInTheDocument();

        rerender(<App />);

        expect(await screen.findByText("view:systemadmin/DataPurge")).toBeInTheDocument();
        expect(screen.getAllByTestId("route-view")).toHaveLength(1);
    });
});

describe("App route table — exactly one route element renders per path", () => {
    it.each(PUBLIC_ROUTES)("$path renders exactly one route view, and it is $view", async ({ path, view }) => {
        renderWithProviders(<App />, { initialEntries: [path] });
        await screen.findByText(`view:${view}`);
        expect(screen.getAllByTestId("route-view")).toHaveLength(1);
    });
});
