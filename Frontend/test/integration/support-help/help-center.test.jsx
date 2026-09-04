/**
 * help-center.test.jsx — end-to-end integration of the real Help Center page
 * (HelpView) rendered through the app's providers, at the real /about/help route.
 *
 * This is the highest-fidelity test in the Help suite: the actual page, the
 * actual hook, the actual search engine, the actual role filter, wired to auth
 * ONLY through the MSW network boundary (loginAs). Nothing about the feature is
 * stubbed — a break here is a break a user would see.
 *
 * WHAT IS PROVEN
 * ──────────────
 * 1. Role-scoped visibility on the real page: a System category
 *    ("Metrics & Observability", SUPER_ADMIN allow-list) is present for a
 *    SUPER_ADMIN, and absent for ADMIN, USER, and unauthenticated viewers —
 *    while a general category ("Account & Login") is always present.
 * 2. Page furniture: the "Help categories" nav landmark and the "Search help…"
 *    search box render.
 * 3. Live search finds real CATHERINE content and shows the result summary.
 * 4. A miss shows the "couldn't find anything" copy.
 * 5. An article expands via its accordion button (aria-expanded toggles).
 *
 * PORT NOTE (MEAL → CATHERINE):
 *   - Route is /about/help (MEAL: /help). Page is HelpView (default export).
 *   - The privileged category asserted is a CATHERINE System category
 *     ("Metrics & Observability") — MEAL's excess-fund/vendor categories don't exist.
 *   - Search queries use REAL CATHERINE corpus vocabulary (sessions, caching…).
 *   - No peso anywhere.
 *
 * HARNESS: renderWithProviders mounts MemoryRouter + version/toast providers and
 * shims matchMedia; we pass route:"/about/help" so useHelp's URL sync sees the
 * real path. invalidateCache() in beforeEach prevents a prior test's cached
 * auth/me from leaking a stale role.
 */

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import HelpView from "../../../src/features/support/help/Help.view";
import { loginAs, logoutUser } from "../../helpers/auth.js";
import { renderWithProviders } from "../../helpers/renderWithProviders.jsx";
import { invalidateCache } from "../../../src/hooks/useRequest";

const SYSTEM_CATEGORY = "Metrics & Observability"; // SUPER_ADMIN-only (roles allow-list)
const GENERAL_CATEGORY = "Account & Login"; // tier 0, always visible

/** The category rail landmark; category labels render in both the rail and the
 * article panel, so all visibility assertions are scoped to the rail to avoid
 * ambiguous multi-match. */
function nav() {
    return within(screen.getByRole("navigation", { name: "Help categories" }));
}

/** Mount the real Help Center at its real route and wait for the skeleton to clear. */
async function renderHelp() {
    const utils = renderWithProviders(<HelpView />, { route: "/about/help" });
    // The general category always resolves in the rail once loading settles — a
    // reliable "page is ready" anchor regardless of role.
    await waitFor(() => expect(nav().getByText(GENERAL_CATEGORY)).toBeInTheDocument());
    return utils;
}

describe("Help Center page — role-scoped visibility (real page, MSW-only auth)", () => {
    beforeEach(() => {
        invalidateCache();
    });

    it("shows the System category to a SUPER_ADMIN", async () => {
        loginAs("SUPER_ADMIN");
        await renderHelp();
        await waitFor(() => expect(nav().getByText(SYSTEM_CATEGORY)).toBeInTheDocument());
    });

    it("hides the System category from an ADMIN (allow-list is exact, not a ladder)", async () => {
        loginAs("ADMIN");
        await renderHelp();
        expect(nav().getByText(GENERAL_CATEGORY)).toBeInTheDocument();
        expect(nav().queryByText(SYSTEM_CATEGORY)).toBeNull();
    });

    it("hides the System category from an ordinary USER", async () => {
        loginAs("USER");
        await renderHelp();
        expect(nav().getByText(GENERAL_CATEGORY)).toBeInTheDocument();
        expect(nav().queryByText(SYSTEM_CATEGORY)).toBeNull();
    });

    it("hides the System category from an unauthenticated visitor", async () => {
        logoutUser();
        await renderHelp();
        expect(nav().getByText(GENERAL_CATEGORY)).toBeInTheDocument();
        expect(nav().queryByText(SYSTEM_CATEGORY)).toBeNull();
    });
});

describe("Help Center page — furniture, search, and article expansion", () => {
    beforeEach(() => {
        invalidateCache();
    });

    it("renders the category nav landmark and the search box", async () => {
        loginAs("USER");
        await renderHelp();
        expect(screen.getByRole("navigation", { name: "Help categories" })).toBeInTheDocument();
        expect(screen.getByPlaceholderText("Search help…")).toBeInTheDocument();
    });

    it("finds real content and shows a result summary when searching", async () => {
        const user = userEvent.setup();
        loginAs("USER");
        await renderHelp();

        // "session" is a real tag on tier-0 account/login articles.
        await user.type(screen.getByPlaceholderText("Search help…"), "session");

        // The debounced summary line appears once matches resolve.
        await waitFor(() => expect(screen.getByText(/result(s)? for/i)).toBeInTheDocument());
        // And a genuinely relevant article surfaces.
        expect(await screen.findByText(/signed out after being idle\?/i)).toBeInTheDocument();
    });

    it("shows the no-results copy for a genuinely off-topic query", async () => {
        const user = userEvent.setup();
        loginAs("USER");
        await renderHelp();

        await user.type(screen.getByPlaceholderText("Search help…"), "purple giraffe");
        await waitFor(() => expect(screen.getByText(/couldn't find anything/i)).toBeInTheDocument());
    });

    it("expands an article when its accordion button is activated", async () => {
        const user = userEvent.setup();
        loginAs("USER");
        await renderHelp();

        // Narrow to the session-timeout article and toggle it open.
        const button = await screen.findByRole("button", { name: /signed out after being idle\?/i });
        expect(button).toHaveAttribute("aria-expanded", "false");
        await user.click(button);
        await waitFor(() => expect(button).toHaveAttribute("aria-expanded", "true"));
    });
});
