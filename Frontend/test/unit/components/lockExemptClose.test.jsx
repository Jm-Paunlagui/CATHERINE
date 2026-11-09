/**
 * lockExemptClose.test.jsx — every dialog/drawer close control must be lock-exempt so a user is
 * never trapped in a dialog during a server outage.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import ProfileModal from "../../../src/components/feedback/ProfileModal.jsx";
import { Drawer } from "../../../src/components/ui/Drawer.jsx";
import { Gallery } from "../../../src/components/ui/Gallery.jsx";
import Modal from "../../../src/components/ui/Modal.jsx";

const closeButtons = () => screen.getAllByRole("button", { name: /^close/i });
const expectAllExempt = () => {
    const buttons = closeButtons();
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b, b.getAttribute("aria-label")).toHaveAttribute("data-lock-exempt");
};

describe("close controls carry data-lock-exempt", () => {
    it("ProfileModal", () => {
        render(<ProfileModal open onClose={() => {}} user={{ firstName: "Juan", lastName: "Dela Cruz", role: "USER" }} />);
        expectAllExempt();
    });

    it("Modal header close", () => {
        render(
            <Modal open onClose={() => {}} title="M">
                <p>x</p>
            </Modal>,
        );
        expectAllExempt();
    });

    it("Gallery lightbox close", async () => {
        const user = userEvent.setup();
        render(<Gallery images={[{ src: "a.png", alt: "first" }]} />);
        await user.click(screen.getByAltText("first"));
        // The lightbox close is the icon-only button positioned top-right; it has no accessible name of its own.
        const lightbox = screen.getAllByAltText("first").at(-1).parentElement;
        const close = lightbox.querySelector(":scope > button");
        expect(close).not.toBeNull();
        expect(close).toHaveAttribute("data-lock-exempt");
    });

    it("Drawer header close", () => {
        render(
            <Drawer open onClose={() => {}} title="D">
                <p>x</p>
            </Drawer>,
        );
        expectAllExempt();
    });
});
