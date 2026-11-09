/**
 * modal.focus.test.jsx — Focus management added to the shared `Modal`:
 * initial focus, Tab trap, focus return, and the lock-exempt / focus-ring ×.
 *
 * Modal portals to document.body — all queries go through `screen`.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Modal } from "../../../src/components/ui/Modal.jsx";

// jsdom has no layout: every element reports zero client rects, which the Tab trap (F9)
// reads as "not rendered". Give every element one box so the trap sees them.
beforeEach(() => {
    vi.spyOn(Element.prototype, "getClientRects").mockImplementation(() => [{}]);
});
afterEach(() => vi.restoreAllMocks());

function Harness({ initialFocus = false, returnFocus = false, inlineClose = false }) {
    const [open, setOpen] = useState(false);
    const [n, setN] = useState(0);
    const initRef = useRef(null);
    const retRef = useRef(null);
    return (
        <div>
            <button onClick={() => setOpen(true)}>opener</button>
            <button ref={retRef}>return-target</button>
            <button onClick={() => setN((v) => v + 1)}>rerender {n}</button>
            <Modal open={open} onClose={inlineClose ? () => setOpen(false) : () => setOpen(false)} title="T" initialFocusRef={initialFocus ? initRef : undefined} returnFocusRef={returnFocus ? retRef : undefined}>
                <button>first</button>
                <button ref={initRef}>second</button>
                <button>third</button>
            </Modal>
        </div>
    );
}

describe("Modal — focus management", () => {
    it("focuses the panel on open by default", async () => {
        const user = userEvent.setup();
        render(<Harness />);
        await user.click(screen.getByText("opener"));
        expect(screen.getByRole("dialog").firstElementChild).toHaveFocus();
    });

    it("initialFocusRef wins over the panel", async () => {
        const user = userEvent.setup();
        render(<Harness initialFocus />);
        await user.click(screen.getByText("opener"));
        expect(screen.getByText("second")).toHaveFocus();
    });

    it("does not steal focus when it is already inside the panel", () => {
        function Inner() {
            const ref = useRef(null);
            const [mounted] = useState(true);
            return mounted ? (
                <Modal open onClose={() => {}} title="T">
                    <input ref={ref} aria-label="field" autoFocus />
                </Modal>
            ) : null;
        }
        render(<Inner />);
        expect(screen.getByLabelText("field")).toHaveFocus();
    });

    it("Tab and Shift+Tab wrap inside the panel", async () => {
        const user = userEvent.setup();
        render(<Harness />);
        await user.click(screen.getByText("opener"));
        screen.getByText("third").focus();
        await user.tab();
        expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
        screen.getByRole("button", { name: "Close" }).focus();
        await user.tab({ shift: true });
        expect(screen.getByText("third")).toHaveFocus();
    });

    it("ignores Tab events coming from a nested (portalled) modal", async () => {
        const user = userEvent.setup();
        render(
            <Modal open onClose={() => {}} title="Outer">
                <button>outer-btn</button>
                <Modal open onClose={() => {}} title="Inner">
                    <button>inner-a</button>
                    <button>inner-b</button>
                </Modal>
            </Modal>,
        );
        const dialogs = screen.getAllByRole("dialog");
        expect(dialogs).toHaveLength(2);
        screen.getByText("inner-b").focus();
        await user.tab();
        // Inner trap wraps within itself; the outer trap must not have yanked focus to outer-btn.
        expect(screen.getByText("outer-btn")).not.toHaveFocus();
    });

    it("returns focus to the opener on close", async () => {
        const user = userEvent.setup();
        render(<Harness />);
        await user.click(screen.getByText("opener"));
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(screen.getByText("opener")).toHaveFocus();
    });

    it("returnFocusRef overrides the opener", async () => {
        const user = userEvent.setup();
        render(<Harness returnFocus />);
        await user.click(screen.getByText("opener"));
        await user.keyboard("{Escape}");
        expect(screen.getByText("return-target")).toHaveFocus();
    });

    it("a detached opener does not throw", () => {
        const opener = document.createElement("button");
        document.body.appendChild(opener);
        opener.focus();
        const { unmount } = render(
            <Modal open onClose={() => {}} title="T">
                <p>x</p>
            </Modal>,
        );
        opener.remove();
        expect(() => unmount()).not.toThrow();
    });

    it("re-rendering with a new inline onClose does not move focus", async () => {
        const user = userEvent.setup();
        function Host() {
            const [n, setN] = useState(0);
            return (
                <Modal open onClose={() => setN(n)} title="T">
                    <input aria-label="typing" />
                    <button onClick={() => setN(n + 1)}>bump</button>
                </Modal>
            );
        }
        render(<Host />);
        const input = screen.getByLabelText("typing");
        await user.click(input);
        await user.type(input, "abc");
        await user.click(screen.getByText("bump"));
        screen.getByLabelText("typing").focus();
        await user.keyboard("d");
        expect(screen.getByLabelText("typing")).toHaveFocus();
    });

    it("× is lock-exempt and has the focus ring", () => {
        render(
            <Modal open onClose={vi.fn()} title="T">
                <p>x</p>
            </Modal>,
        );
        const close = screen.getByRole("button", { name: "Close" });
        expect(close).toHaveAttribute("data-lock-exempt");
        expect(close.className).toContain("focus-ring");
        expect(close).toHaveAttribute("type", "button");
    });
});
