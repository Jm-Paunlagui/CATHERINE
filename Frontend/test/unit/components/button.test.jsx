/**
 * button.test.jsx — Button's icon and variant contract.
 *
 * WHAT IS LOCKED SHUT
 *   Two silent-failure modes found during the excess-fund QA gate, both of
 *   which rendered wrong without throwing, logging, or failing a single test:
 *
 *   1. `icon={<FontAwesomeIcon …/>}` was not a declared prop, so it fell into
 *      `...rest` and React stringified it onto the DOM as
 *      `icon="[object Object]"`. Eight call sites rendered no icon at all.
 *   2. `variant="success"` had no entry in VARIANTS, so the `?? VARIANTS.primary`
 *      fallback painted every Approve button the same orange as the page's
 *      primary CTA — in approve/reject pairs where colour IS the affordance.
 *
 *   Both are invisible to a smoke test that only asserts the label renders,
 *   which is exactly why they survived. These assertions go at the DOM level.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import Button from "../../../src/components/ui/Button.jsx";

/** Stand-in with FontAwesome's shape: already an element, already sized. */
function FakeFaIcon() {
    return <svg data-testid="fa-icon" className="w-4 h-4" />;
}

describe("Button — icon contract", () => {
    it("renders an element passed as `icon` instead of leaking it onto the DOM", () => {
        render(
            <Button icon={<FakeFaIcon />}>
                Approve
            </Button>,
        );
        const btn = screen.getByRole("button", { name: /Approve/ });

        expect(screen.getByTestId("fa-icon")).toBeInTheDocument();
        // The original bug, asserted directly.
        expect(btn.getAttribute("icon")).toBeNull();
        expect(btn.outerHTML).not.toContain("[object Object]");
    });

    it("renders a component passed as `leftIcon` and sizes it", () => {
        const HeroIcon = (props) => <svg data-testid="hero-icon" {...props} />;
        render(<Button leftIcon={HeroIcon}>Download</Button>);

        expect(screen.getByTestId("hero-icon")).toHaveClass("w-4", "h-4");
    });

    it("prefers `leftIcon` when both are given, and never renders two icons", () => {
        const HeroIcon = (props) => <svg data-testid="hero-icon" {...props} />;
        render(
            <Button leftIcon={HeroIcon} icon={<FakeFaIcon />}>
                Both
            </Button>,
        );

        expect(screen.getByTestId("hero-icon")).toBeInTheDocument();
        expect(screen.queryByTestId("fa-icon")).not.toBeInTheDocument();
    });

    it("replaces the icon with the spinner while loading", () => {
        render(
            <Button icon={<FakeFaIcon />} loading>
                Saving
            </Button>,
        );

        expect(screen.queryByTestId("fa-icon")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Saving/ })).toBeDisabled();
    });
});

describe("Button — variant contract", () => {
    it("paints `success` in the success family, not the primary fallback", () => {
        render(<Button variant="success">Approve</Button>);
        const cls = screen.getByRole("button", { name: "Approve" }).className;

        expect(cls).toContain("success-400");
        // The bug: silently falling through to primary's orange.
        expect(cls).not.toContain("orange-400");
    });

    it("keeps `success` visually distinct from `danger` — the approve/reject pair", () => {
        const { rerender } = render(<Button variant="success">A</Button>);
        const ok = screen.getByRole("button").className;
        rerender(<Button variant="danger">R</Button>);
        const no = screen.getByRole("button").className;

        expect(ok).not.toBe(no);
        expect(no).toContain("danger-400");
    });

    it("still falls back to primary for a genuinely unknown variant", () => {
        render(<Button variant="not-a-variant">X</Button>);

        expect(screen.getByRole("button", { name: "X" }).className).toContain("bg-(--btn-primary-tint)");
    });

    it("pairs a dark variant for every light utility in `success`", () => {
        render(<Button variant="success">A</Button>);
        const cls = screen.getByRole("button").className;

        expect(cls).toContain("dark:text-success-300");
        expect(cls).toContain("dark:bg-success-400/15");
        expect(cls).toContain("dark:border-success-400");
    });
});

describe("Button — data-variant (server-lock hook)", () => {
    it.each([
        ["gradient", "gradient"],
        ["warn", "warning"],
        ["secondary", "ghost"],
        ["not-a-variant", "primary"],
    ])("variant %s emits data-variant=%s", (variant, expected) => {
        render(<Button variant={variant}>X</Button>);
        expect(screen.getByRole("button", { name: "X" })).toHaveAttribute("data-variant", expected);
    });

    it("a caller's own data-variant wins", () => {
        render(
            <Button variant="gradient" data-variant="custom">
                X
            </Button>,
        );
        expect(screen.getByRole("button", { name: "X" })).toHaveAttribute("data-variant", "custom");
    });
});
