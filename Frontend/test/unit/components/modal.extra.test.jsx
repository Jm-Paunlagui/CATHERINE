/**
 * modal.extra.test.jsx — Modal branches not exercised by modal.test.jsx:
 * the #root blur side-effect (modal.test.jsx never creates a #root element,
 * so `if (root)` is always false there and the blur-toggle body never runs)
 * and `bodyClassName` forwarding.
 */
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";

import { Modal } from "../../../src/components/ui/Modal.jsx";
import { renderWithProviders } from "../../helpers/renderWithProviders.jsx";

function withRootElement() {
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    return root;
}

describe("Modal — #root blur side-effect", () => {
    it("adds the blur class to #root while open, and removes it on close", () => {
        const root = withRootElement();
        const { rerender } = renderWithProviders(
            <Modal open onClose={() => {}} title="T">
                <p>Body</p>
            </Modal>,
        );
        expect(root.classList.contains("blur-sm")).toBe(true);

        rerender(
            <Modal open={false} onClose={() => {}} title="T">
                <p>Body</p>
            </Modal>,
        );
        expect(root.classList.contains("blur-sm")).toBe(false);

        root.remove();
    });

    it("does nothing (no throw) when no #root element exists", () => {
        expect(document.getElementById("root")).toBeNull();
        renderWithProviders(
            <Modal open onClose={() => {}} title="T">
                <p>Body</p>
            </Modal>,
        );
        expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
});

describe("Modal — bodyClassName forwarding", () => {
    it("appends the caller's custom class onto the scrollable body wrapper", () => {
        renderWithProviders(
            <Modal open onClose={() => {}} title="T" bodyClassName="my-custom-body-marker">
                <p>Body</p>
            </Modal>,
        );
        expect(screen.getByText("Body").parentElement).toHaveClass("my-custom-body-marker");
    });
});

describe("Modal — body and header variants", () => {
    it("default body keeps the exact base classes", () => {
        renderWithProviders(
            <Modal open onClose={() => {}} title="T">
                <p>Body</p>
            </Modal>,
        );
        const body = screen.getByText("Body").parentElement;
        expect(body).toHaveClass("px-6", "py-5", "overflow-y-auto", "max-h-[70vh]", "hide-scrollbar");
    });

    it('bodyVariant="flush" drops the base classes and still appends bodyClassName', () => {
        renderWithProviders(
            <Modal open onClose={() => {}} title="T" bodyVariant="flush" bodyClassName="my-flush-marker">
                <p>Body</p>
            </Modal>,
        );
        const body = screen.getByText("Body").parentElement;
        expect(body).toHaveClass("my-flush-marker");
        expect(body).not.toHaveClass("px-6");
        expect(body).not.toHaveClass("max-h-[70vh]");
        expect(body).not.toHaveClass("hide-scrollbar");
    });

    it('headerVariant="section" renders titleIcon and headerAside outside the accessible name', () => {
        renderWithProviders(
            <Modal open onClose={() => {}} title="Section title" headerVariant="section" titleIcon={<i data-testid="ico" />} headerAside={<span>3 active</span>}>
                <p>Body</p>
            </Modal>,
        );
        expect(screen.getByRole("dialog", { name: "Section title" })).toBeInTheDocument();
        expect(screen.getByTestId("ico")).toBeInTheDocument();
        expect(screen.getByText("3 active")).toBeInTheDocument();
        expect(screen.getByRole("heading", { level: 2 })).toHaveClass("text-[13px]");
    });
});
