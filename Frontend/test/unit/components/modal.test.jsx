/**
 * modal.test.jsx — Unit tests for the load-bearing shared `Modal` component
 * (src/components/ui/Modal.jsx): open/close lifecycle, every close affordance
 * the source actually implements, footer rendering, and the body-scroll-lock
 * side effect.
 *
 * NOT asserted, because it does not exist: there is no focus trap and no
 * initial-focus move in this component. A test for either would be asserting a
 * feature into existence rather than covering one. (Reported as a gap, not
 * faked here — see the report accompanying this batch.)
 *
 * PORTAL: `Modal` renders through `createPortal(…, document.body)`, so its
 * content is NOT a descendant of RTL's render `container`. Every query below
 * goes through `screen` (which searches `document.body`) or `baseElement`,
 * never `container`.
 */

import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Modal } from "../../../src/components/ui/Modal.jsx";
import { renderWithProviders } from "../../helpers/renderWithProviders.jsx";

describe("Modal — open/close lifecycle (unhappy path first)", () => {
    it("renders nothing when open=false", () => {
        renderWithProviders(
            <Modal open={false} onClose={() => {}} title="Hidden">
                <p>Should not render</p>
            </Modal>,
        );
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(screen.queryByText("Should not render")).not.toBeInTheDocument();
    });

    it("renders the dialog, title, and children when open=true", () => {
        renderWithProviders(
            <Modal open onClose={() => {}} title="Confirm Delete">
                <p>Are you sure?</p>
            </Modal>,
        );
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(screen.getByText("Confirm Delete")).toBeInTheDocument();
        expect(screen.getByText("Are you sure?")).toBeInTheDocument();
    });

    // aria-modal is what tells assistive tech the rest of the page is inert.
    // Without it a screen-reader user can wander out of the dialog silently.
    it("marks the dialog aria-modal so assistive tech treats the page behind it as inert", () => {
        renderWithProviders(
            <Modal open onClose={() => {}} title="T">
                <p>Body</p>
            </Modal>,
        );
        expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    });
});

describe("Modal — onClose triggers", () => {
    it("clicking the backdrop (the outer dialog element itself) calls onClose", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        renderWithProviders(
            <Modal open onClose={onClose} title="T">
                <p>Body</p>
            </Modal>,
        );

        await user.click(screen.getByRole("dialog"));

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("clicking INSIDE the panel (title or body content) does NOT call onClose (stopPropagation guard)", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        renderWithProviders(
            <Modal open onClose={onClose} title="T">
                <p>Body content</p>
            </Modal>,
        );

        await user.click(screen.getByText("Body content"));
        await user.click(screen.getByText("T"));

        expect(onClose).not.toHaveBeenCalled();
    });

    it("pressing Escape calls onClose", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        renderWithProviders(
            <Modal open onClose={onClose} title="T">
                <p>Body</p>
            </Modal>,
        );

        await user.keyboard("{Escape}");

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    // The keydown listener is document-level. If the cleanup ever regressed,
    // a closed modal would keep firing onClose for every Escape on the page.
    it("stops listening for Escape once closed", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        const { rerender } = renderWithProviders(
            <Modal open onClose={onClose} title="T">
                <p>Body</p>
            </Modal>,
        );

        rerender(
            <Modal open={false} onClose={onClose} title="T">
                <p>Body</p>
            </Modal>,
        );
        await user.keyboard("{Escape}");

        expect(onClose).not.toHaveBeenCalled();
    });

    it("clicking the header X button calls onClose", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        renderWithProviders(
            <Modal open onClose={onClose} title="T">
                <p>Body</p>
            </Modal>,
        );

        await user.click(screen.getByRole("button", { name: "Close" }));

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("no title -> no header row and no X close button (only backdrop/Escape remain as close affordances)", () => {
        renderWithProviders(
            <Modal open onClose={() => {}}>
                <p>Body only</p>
            </Modal>,
        );
        expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
        expect(screen.getByText("Body only")).toBeInTheDocument();
    });
});

describe("Modal — footer rendering", () => {
    it("renders the footer node when provided", () => {
        renderWithProviders(
            <Modal open onClose={() => {}} title="T" footer={<button type="button">Save changes</button>}>
                <p>Body</p>
            </Modal>,
        );
        expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
    });

    it("renders no footer region when omitted", () => {
        const { baseElement } = renderWithProviders(
            <Modal open onClose={() => {}} title="T">
                <p>Body</p>
            </Modal>,
        );
        // The footer wrapper only exists when `footer` is truthy. The header
        // uses border-B, so a border-T bar is unambiguously the footer.
        expect(baseElement.querySelector(".border-t.border-grey-200")).not.toBeInTheDocument();
    });
});

describe("Modal — body scroll lock side-effect", () => {
    it("sets document.body.style.overflow to 'hidden' while open and clears it when closed", () => {
        const { rerender } = renderWithProviders(
            <Modal open onClose={() => {}} title="T">
                <p>Body</p>
            </Modal>,
        );
        expect(document.body.style.overflow).toBe("hidden");

        rerender(
            <Modal open={false} onClose={() => {}} title="T">
                <p>Body</p>
            </Modal>,
        );
        expect(document.body.style.overflow).toBe("");
    });

    // A modal that unmounts while open (route change, parent conditional) must
    // still release the lock, or the page behind it is permanently unscrollable.
    it("releases the lock on unmount, not only on an open=false rerender", () => {
        const { unmount } = renderWithProviders(
            <Modal open onClose={() => {}} title="T">
                <p>Body</p>
            </Modal>,
        );
        expect(document.body.style.overflow).toBe("hidden");

        unmount();

        expect(document.body.style.overflow).toBe("");
    });
});
