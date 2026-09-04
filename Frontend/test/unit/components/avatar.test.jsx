/**
 * avatar.test.jsx — Unit tests for src/components/ui/Avatar.jsx.
 *
 * Focus is the `indicator` overlay badge. The rest of Avatar (initials
 * derivation, deterministic palette) is covered incidentally where an
 * indicator assertion depends on it.
 *
 * On asserting CLASS STRINGS: normally a brittle habit, but the two properties
 * under test here — "the fill is a theme-redefined CSS variable, not a
 * hand-paired light/dark literal" and "the ring is the surface colour" — exist
 * ONLY as classes. There is no rendered behaviour to observe instead, because
 * jsdom applies no CSS. A test that skipped them would leave the actual
 * requirement ("make it theme aware") unverified.
 *
 * `render` is used directly rather than `renderWithProviders`: Avatar reads no
 * context and fires no request, so wrapping it in the app provider chain would
 * make every case here depend on the CSRF/changelog handlers for nothing.
 */

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Avatar } from "../../../src/components/ui/Avatar.jsx";

describe("Avatar — indicator badge", () => {
    it("renders nothing extra when no indicator is passed", () => {
        render(<Avatar name="Juan Dela Cruz" />);
        expect(screen.queryByRole("img")).not.toBeInTheDocument();
        expect(screen.getByText("JC")).toBeInTheDocument();
    });

    // The label is the accessible name. A bare coloured circle conveys nothing
    // to a screen reader and fails WCAG 1.4.1 (Use of Colour).
    it("exposes the indicator's meaning as an accessible name, not colour alone", () => {
        render(<Avatar name="Juan Dela Cruz" indicator={{ label: "Account not verified", tone: "danger" }} />);
        const badge = screen.getByRole("img", { name: "Account not verified" });
        expect(badge).toBeInTheDocument();
        // Also surfaced on hover for sighted users who cannot read the hue.
        expect(badge).toHaveAttribute("title", "Account not verified");
    });

    // Guards against a badge that is drawn but silent — the failure mode where
    // an indicator is added with an icon and no label.
    it("renders NO badge when the label is missing, even if a tone and icon are given", () => {
        render(<Avatar name="Juan Dela Cruz" indicator={{ tone: "danger", icon: <svg data-testid="glyph" /> }} />);
        expect(screen.queryByRole("img")).not.toBeInTheDocument();
        expect(screen.queryByTestId("glyph")).not.toBeInTheDocument();
    });

    it("hides a decorative icon from assistive tech so it does not double-announce the label", () => {
        render(<Avatar name="Juan Dela Cruz" indicator={{ label: "Password expiring", tone: "warning", icon: <svg data-testid="glyph" /> }} />);
        const badge = screen.getByRole("img", { name: "Password expiring" });
        expect(within(badge).getByTestId("glyph")).toBeInTheDocument();
        expect(badge.querySelector("[aria-hidden='true']")).not.toBeNull();
    });

    // The icon wrapper must not be a bare inline <span>. That would put the svg
    // on the TEXT BASELINE (pushing the glyph visibly down-right off centre)
    // and leave a percentage size on the icon with no definite box to resolve
    // against. Avatar owns both the box and the glyph size, so no call site can
    // get the centring wrong and none needs to know the badge diameter.
    it("centres the icon in a definite-size flex box and sizes the glyph itself", () => {
        render(<Avatar name="Juan Dela Cruz" indicator={{ label: "Account locked", icon: <svg data-testid="glyph" /> }} />);
        const wrapper = screen.getByRole("img", { name: "Account locked" }).querySelector("[aria-hidden='true']");

        // A definite box, so a percentage-sized child has something to resolve against.
        expect(wrapper.className).toContain("w-full");
        expect(wrapper.className).toContain("h-full");
        // Centred on both axes, and not sitting on a text baseline.
        expect(wrapper.className).toContain("flex");
        expect(wrapper.className).toContain("items-center");
        expect(wrapper.className).toContain("justify-center");
        // Glyph sizing is owned here, applied to whatever svg the caller passed.
        expect(wrapper.className).toContain("[&_svg]:w-[58%]");
        expect(wrapper.className).toContain("[&_svg]:h-[58%]");
    });

    it("defaults to the bottom-left corner", () => {
        render(<Avatar name="Juan Dela Cruz" indicator={{ label: "Password expiring" }} />);
        const badge = screen.getByRole("img", { name: "Password expiring" });
        expect(badge.className).toContain("-bottom-0.5");
        expect(badge.className).toContain("-left-0.5");
    });

    it("honours an explicit corner", () => {
        render(<Avatar name="Juan Dela Cruz" indicator={{ label: "Password expiring" }} indicatorPosition="top-right" />);
        const badge = screen.getByRole("img", { name: "Password expiring" });
        expect(badge.className).toContain("-top-0.5");
        expect(badge.className).toContain("-right-0.5");
    });

    it("falls back to bottom-left for an unrecognised corner rather than dropping the badge", () => {
        render(<Avatar name="Juan Dela Cruz" indicator={{ label: "Password expiring" }} indicatorPosition="middle-nowhere" />);
        const badge = screen.getByRole("img", { name: "Password expiring" });
        expect(badge.className).toContain("-bottom-0.5");
    });

    // THEME AWARENESS. Every --status-*-base token is redefined inside the dark
    // block of the stylesheet, so ONE reference is correct in both themes. A
    // hand-paired `bg-red-500 dark:bg-red-400` is what this must not become —
    // those two drift the moment either side is edited alone.
    it("fills from a theme-redefined status token, not a hand-paired light/dark literal", () => {
        render(<Avatar name="Juan Dela Cruz" indicator={{ label: "Account locked", tone: "danger" }} />);
        const badge = screen.getByRole("img", { name: "Account locked" });
        expect(badge.className).toContain("bg-[var(--status-danger-base)]");
        expect(badge.className).not.toMatch(/dark:bg-/);
    });

    it("rings the badge in the surface colour so it detaches from the avatar in both themes", () => {
        render(<Avatar name="Juan Dela Cruz" indicator={{ label: "Account locked", tone: "danger" }} />);
        const badge = screen.getByRole("img", { name: "Account locked" });
        expect(badge.className).toContain("ring-white");
        expect(badge.className).toContain("dark:ring-(--bg-surface-2)");
    });

    // Warning is a light amber; white-on-amber fails contrast. The tone map
    // picks the foreground per fill rather than assuming white everywhere.
    it("picks a readable foreground per tone instead of always white", () => {
        render(<Avatar name="Juan Dela Cruz" indicator={{ label: "Password expiring", tone: "warning" }} />);
        expect(screen.getByRole("img", { name: "Password expiring" }).className).toContain("text-black");
    });

    it("falls back to the neutral tone for an unknown tone", () => {
        render(<Avatar name="Juan Dela Cruz" indicator={{ label: "Unknown state", tone: "chartreuse" }} />);
        expect(screen.getByRole("img", { name: "Unknown state" }).className).toContain("bg-[var(--status-neutral-base)]");
    });

    // `accent` is the ONE palette-following tone, for identity rather than
    // status — a status hue must not change because the user repainted the app.
    it("uses the palette accent only for the accent tone", () => {
        const { unmount } = render(<Avatar name="Juan Dela Cruz" indicator={{ label: "Super admin", tone: "accent" }} />);
        expect(screen.getByRole("img", { name: "Super admin" }).className).toContain("bg-(--accent)");
        unmount();

        render(<Avatar name="Juan Dela Cruz" indicator={{ label: "Session active", tone: "success" }} />);
        expect(screen.getByRole("img", { name: "Session active" }).className).not.toContain("bg-(--accent)");
    });

    it("scales the badge with the avatar size", () => {
        const { unmount } = render(<Avatar name="Juan Dela Cruz" size="xs" indicator={{ label: "Password expiring" }} />);
        expect(screen.getByRole("img", { name: "Password expiring" }).className).toContain("w-3 h-3");
        unmount();

        render(<Avatar name="Juan Dela Cruz" size="2xl" indicator={{ label: "Password expiring" }} />);
        expect(screen.getByRole("img", { name: "Password expiring" }).className).toContain("w-7 h-7");
    });

    // The two controls are different things and must be able to coexist: the
    // presence dot stays bottom-right, the meaning-carrying badge bottom-left.
    it("coexists with the presence status dot without overlapping it", () => {
        const { container } = render(<Avatar name="Juan Dela Cruz" status="online" indicator={{ label: "Password expiring" }} />);
        const badge = screen.getByRole("img", { name: "Password expiring" });
        expect(badge.className).toContain("-left-0.5");

        const dot = container.querySelector("span.absolute.bottom-0.right-0");
        expect(dot).not.toBeNull();
        expect(dot).not.toBe(badge);
    });

    it("applies the pulse animation only when asked", () => {
        const { unmount } = render(<Avatar name="Juan Dela Cruz" indicator={{ label: "Action needed", pulse: true }} />);
        expect(screen.getByRole("img", { name: "Action needed" }).className).toContain("animate-pulse");
        unmount();

        render(<Avatar name="Juan Dela Cruz" indicator={{ label: "Action needed" }} />);
        expect(screen.getByRole("img", { name: "Action needed" }).className).not.toContain("animate-pulse");
    });

    it("renders the badge over an image avatar too, not just the initials fallback", () => {
        render(<Avatar name="Juan Dela Cruz" src="https://example.test/a.png" indicator={{ label: "Password expiring", tone: "warning" }} />);
        expect(screen.getByRole("img", { name: "Juan Dela Cruz" })).toBeInTheDocument();
        expect(screen.getByRole("img", { name: "Password expiring" })).toBeInTheDocument();
    });
});
