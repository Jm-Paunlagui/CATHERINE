/**
 * helpAssistantRouteGating.test.jsx — the global Help Assistant launcher must
 * NOT appear on the Help Center itself (/about/help). Showing a "need help?"
 * FAB on the help page is redundant and, worse, its scroll-lock + backdrop blur
 * would fight the full-page Help Center.
 *
 * TWO LAYERS UNDER TEST
 * ─────────────────────
 * 1. isHiddenPath() — the pure boundary-aware matcher. It must hide /about/help
 *    and any child (/about/help/x) but NOT a sibling that merely shares the
 *    prefix (/about/helpdesk). HIDDEN_PATHS is frozen so no consumer can mutate
 *    the suppression list at runtime.
 * 2. <HelpAssistant /> render output — the FAB is absent on the hidden route
 *    (even with a deep-link ?category=…), present on ordinary routes, and while
 *    hidden the Ctrl+K shortcut is inert and no scroll-lock / root blur leaks.
 *
 * PORT NOTE (MEAL → CATHERINE):
 *   - The hidden route is `/about/help` (MEAL used `/help`).
 *   - "Present" routes are retuned to REAL CATHERINE routes (`/home`,
 *     `/about/changelog`, and the prefix-sibling `/about/helpdesk`).
 *   - FAB is matched by its exact accessible name "Open Help Assistant (Ctrl+K)".
 *
 * HARNESS: <HelpAssistant /> reads useLocation, so each render is wrapped in a
 * MemoryRouter seeded with the route under test. loginAs("USER") gives a normal
 * (non-suppressed) role so route gating — not role gating — is what we observe.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import HelpAssistant from "../../../src/components/shared/HelpAssistant/HelpAssistant";
import { HIDDEN_PATHS, isHiddenPath } from "../../../src/components/shared/HelpAssistant/useHelpAssistant";
import { loginAs } from "../../helpers/auth.js";
import { invalidateCache } from "../../../src/hooks/useRequest";

const FAB_LABEL = "Open Help Assistant (Ctrl+K)";

/** Render the launcher at a given route, logged in as a non-suppressed USER. */
function renderAt(entry) {
    loginAs("USER");
    return render(
        <MemoryRouter initialEntries={[entry]}>
            <div id="root">
                <HelpAssistant />
            </div>
        </MemoryRouter>,
    );
}

beforeEach(() => {
    invalidateCache();
});

afterEach(() => {
    // The open path locks body scroll + blurs #root; make sure nothing leaks
    // across tests even if an assertion aborted mid-way.
    document.body.style.overflow = "";
    document.getElementById("root")?.classList.remove("blur-sm");
});

describe("isHiddenPath — boundary-aware suppression matcher", () => {
    it("hides the Help Center route exactly", () => {
        expect(isHiddenPath("/about/help")).toBe(true);
    });

    it("hides any child of the Help Center route", () => {
        expect(isHiddenPath("/about/help/articles")).toBe(true);
    });

    it("does NOT hide a sibling that merely shares the prefix", () => {
        expect(isHiddenPath("/about/helpdesk")).toBe(false);
    });

    it("does NOT hide ordinary routes", () => {
        expect(isHiddenPath("/home")).toBe(false);
        expect(isHiddenPath("/about/changelog")).toBe(false);
        expect(isHiddenPath("/")).toBe(false);
    });

    it("exposes the frozen suppression list containing only /about/help", () => {
        expect(HIDDEN_PATHS).toEqual(["/about/help"]);
        expect(Object.isFrozen(HIDDEN_PATHS)).toBe(true);
    });
});

describe("<HelpAssistant /> — route-based FAB suppression", () => {
    it("does NOT render the FAB on the Help Center route", async () => {
        renderAt("/about/help");
        // Give the role a tick to resolve; the FAB must never appear.
        await waitFor(() => expect(true).toBe(true));
        expect(screen.queryByRole("button", { name: FAB_LABEL })).toBeNull();
    });

    it("does NOT render the FAB on a deep-linked Help Center category", async () => {
        renderAt("/about/help?category=appearance");
        await waitFor(() => expect(true).toBe(true));
        expect(screen.queryByRole("button", { name: FAB_LABEL })).toBeNull();
    });

    it("renders the FAB on an ordinary route", async () => {
        renderAt("/home");
        expect(await screen.findByRole("button", { name: FAB_LABEL })).toBeInTheDocument();
    });

    it("renders the FAB on the prefix-sibling /about/helpdesk (not suppressed)", async () => {
        renderAt("/about/helpdesk");
        expect(await screen.findByRole("button", { name: FAB_LABEL })).toBeInTheDocument();
    });

    it("keeps Ctrl+K inert on the hidden route — no dialog, no scroll-lock, no blur", async () => {
        renderAt("/about/help");
        await waitFor(() => expect(true).toBe(true));

        // The panel opens on Escape-close only if it ever opened; with the FAB
        // suppressed there is no way to open it and the shortcut is a no-op.
        fireEvent.keyDown(document, { key: "k", ctrlKey: true });

        expect(screen.queryByRole("dialog")).toBeNull();
        expect(document.body.style.overflow).toBe("");
        expect(document.getElementById("root")?.classList.contains("blur-sm")).toBe(false);
    });
});
