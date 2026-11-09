/**
 * themeToggle.lockExempt.test.jsx — the theme toggle stays usable under the server lock,
 * in both variants, and is mounted in the Navbar and the SidebarHeader.
 */
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { applyServerLock } from "../../../src/components/shared/serverStatus/serverLockDom";
import Navbar from "../../../src/components/layout/Navbar";
import SidebarHeader from "../../../src/components/layout/SidebarHeader";
import { ThemeToggle } from "../../../src/components/ui/ThemeToggle";
import { renderWithProviders } from "../../helpers/renderWithProviders";

const THEME_LABEL = /^(System|Light|Dark) theme$/;
let release;
afterEach(() => {
    release?.();
    release = undefined;
});

describe("ThemeToggle — lock exemption", () => {
    it("cycle variant: carries data-lock-exempt, is not inert under the lock and still changes the mode", async () => {
        const user = userEvent.setup();
        renderWithProviders(
            <>
                <ThemeToggle />
                <button type="button">other</button>
            </>,
        );
        const toggle = screen.getByRole("button", { name: THEME_LABEL });
        const before = toggle.getAttribute("aria-label");
        expect(toggle).toHaveAttribute("data-lock-exempt");

        release = applyServerLock(document);
        expect(toggle).not.toHaveAttribute("inert");
        expect(screen.getByRole("button", { name: "other", hidden: true })).toHaveAttribute("inert");

        await user.click(toggle);
        expect(screen.getByRole("button", { name: THEME_LABEL }).getAttribute("aria-label")).not.toBe(before);
    });

    it("segmented variant: the group is exempt, so no segment is inert and a click selects it", async () => {
        const user = userEvent.setup();
        const { container } = renderWithProviders(<ThemeToggle variant="segmented" />);
        release = applyServerLock(document);
        expect(container.querySelector("[data-lock-exempt]")).not.toBeNull();
        for (const b of screen.getAllByRole("button")) expect(b).not.toHaveAttribute("inert");
        await user.click(screen.getByRole("button", { name: "Dark theme" }));
        expect(document.documentElement.classList.contains("dark") || document.documentElement.getAttribute("data-theme") === "dark").toBe(true);
    });
});

describe("ThemeToggle — mounted in the app chrome", () => {
    it("Navbar renders it and it is not inert while locked (Personalize is)", () => {
        renderWithProviders(<Navbar />);
        const toggle = screen.getByRole("button", { name: THEME_LABEL });
        release = applyServerLock(document);
        expect(toggle).not.toHaveAttribute("inert");
        expect(screen.getByRole("button", { name: "Personalize", hidden: true })).toHaveAttribute("inert");
    });

    it("SidebarHeader renders it and it is not inert while locked (Personalize is)", () => {
        renderWithProviders(<SidebarHeader />);
        const toggle = screen.getByRole("button", { name: THEME_LABEL });
        release = applyServerLock(document);
        expect(toggle).not.toHaveAttribute("inert");
        expect(screen.getByRole("button", { name: "Personalize", hidden: true })).toHaveAttribute("inert");
    });

    it("has dark-mode counterparts on its tones", () => {
        renderWithProviders(<ThemeToggle tone="nav" />);
        expect(screen.getByRole("button", { name: THEME_LABEL }).className).toContain("dark:text-grey-400");
    });
});
