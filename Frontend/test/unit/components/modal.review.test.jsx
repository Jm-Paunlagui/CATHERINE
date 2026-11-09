/**
 * modal.review.test.jsx — review findings F8 (return-focus fallback) and F9 (Tab trap
 * skips layout-less elements). jsdom has no layout, so getClientRects is stubbed per test.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Modal } from "../../../src/components/ui/Modal.jsx";

beforeEach(() => {
    vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function () {
        return this.hasAttribute("data-collapsed") ? [] : [{}];
    });
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe("F9 — Tab trap ignores elements with no layout box", () => {
    it("wraps from the last VISIBLE control even when a collapsed control follows it", async () => {
        const user = userEvent.setup();
        render(
            <Modal open onClose={() => {}} title="T">
                <button>visible</button>
                <button data-collapsed="">collapsed</button>
            </Modal>,
        );
        screen.getByText("visible").focus();
        await user.tab();
        expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    });

    it("Shift+Tab from the first control wraps to the last visible one", async () => {
        const user = userEvent.setup();
        render(
            <Modal open onClose={() => {}} title="T">
                <button>visible</button>
                <button data-collapsed="">collapsed</button>
            </Modal>,
        );
        screen.getByRole("button", { name: "Close" }).focus();
        await user.tab({ shift: true });
        expect(screen.getByText("visible")).toHaveFocus();
    });
});

describe("F8 — return focus never lands on an inert/disconnected target", () => {
    it("falls back to the nearest focusable non-inert ancestor when the opener became inert", () => {
        document.body.innerHTML = `<div id="anc" tabindex="0"><button id="op">op</button></div>`;
        const op = document.getElementById("op");
        op.focus();
        const { rerender } = render(
            <Modal open onClose={() => {}} title="T">
                <p>x</p>
            </Modal>,
        );
        op.setAttribute("inert", "");
        expect(() =>
            rerender(
                <Modal open={false} onClose={() => {}} title="T">
                    <p>x</p>
                </Modal>,
            ),
        ).not.toThrow();
        expect(document.activeElement).toBe(document.getElementById("anc"));
    });

    it("falls back to body (no throw) when no usable ancestor exists", () => {
        document.body.innerHTML = `<button id="op">op</button>`;
        const op = document.getElementById("op");
        op.focus();
        const { rerender } = render(
            <Modal open onClose={() => {}} title="T">
                <p>x</p>
            </Modal>,
        );
        op.setAttribute("inert", "");
        op.blur();
        expect(() =>
            rerender(
                <Modal open={false} onClose={() => {}} title="T">
                    <p>x</p>
                </Modal>,
            ),
        ).not.toThrow();
        expect(document.activeElement).not.toBe(op);
    });
});
