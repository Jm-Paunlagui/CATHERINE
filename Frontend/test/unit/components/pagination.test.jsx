/**
 * pagination.test.jsx — Unit tests for the load-bearing shared `Pagination`
 * component (src/components/ui/Pagination.jsx): boundary pages, onChange
 * payloads, disabled states at the edges, and the per-page selector.
 *
 * Read from source: `Pagination` renders `null` entirely when there is nothing
 * to navigate (`totalPages <= 1`) AND no per-page selector is configured — the
 * degenerate case is tested first, because "renders nothing" is the state most
 * likely to be produced accidentally by an empty result set.
 *
 * A per-page selector is only mounted when BOTH `pageSizeOptions` (non-empty)
 * and `onPageSizeChange` are supplied; either alone is not enough.
 */

import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Pagination } from "../../../src/components/ui/Pagination.jsx";
import { renderWithProviders } from "../../helpers/renderWithProviders.jsx";

describe("Pagination — degenerate / unhappy path first", () => {
    it("renders nothing when totalPages<=1 and no per-page selector is configured", () => {
        renderWithProviders(<Pagination page={1} totalPages={1} onChange={() => {}} />);
        expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    });

    it("renders nothing when pageSizeOptions is supplied without an onPageSizeChange handler", () => {
        renderWithProviders(<Pagination page={1} totalPages={1} onChange={() => {}} pageSize={25} pageSizeOptions={[25, 50]} />);
        expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    });

    // A single page of results still needs a rows-per-page control — otherwise
    // the user can never widen a list that collapsed to one page.
    it("still renders the per-page selector on a single page when a handler IS supplied", () => {
        renderWithProviders(<Pagination page={1} totalPages={1} onChange={() => {}} pageSize={25} pageSizeOptions={[25, 50]} onPageSizeChange={() => {}} />);
        const nav = screen.getByRole("navigation");
        expect(nav).toBeInTheDocument();
        // Navigation itself is absent — there is nowhere to go.
        expect(within(nav).queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
        expect(within(nav).getByRole("button", { name: "25" })).toBeInTheDocument();
    });
});

describe("Pagination — boundary pages", () => {
    it("page 1 of 5: Prev is disabled, Next is enabled, page-1 button carries aria-current", () => {
        renderWithProviders(<Pagination page={1} totalPages={5} onChange={() => {}} />);
        expect(screen.getByRole("button", { name: "Prev" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
        expect(screen.getByRole("button", { name: "1" })).toHaveAttribute("aria-current", "page");
    });

    it("last page (5 of 5): Next is disabled, Prev is enabled, the last page button carries aria-current", () => {
        renderWithProviders(<Pagination page={5} totalPages={5} onChange={() => {}} />);
        expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Prev" })).toBeEnabled();
        expect(screen.getByRole("button", { name: "5" })).toHaveAttribute("aria-current", "page");
    });

    it("a middle page (3 of 5) leaves BOTH Prev and Next enabled", () => {
        renderWithProviders(<Pagination page={3} totalPages={5} onChange={() => {}} />);
        expect(screen.getByRole("button", { name: "Prev" })).toBeEnabled();
        expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    });

    // Exactly one page carries aria-current. Two would make the control lie to
    // a screen-reader user about where they are.
    it("marks exactly one page button as the current page", () => {
        renderWithProviders(<Pagination page={3} totalPages={5} onChange={() => {}} />);
        const current = screen.getAllByRole("button").filter((b) => b.getAttribute("aria-current") === "page");
        expect(current).toHaveLength(1);
        expect(current[0]).toHaveTextContent("3");
    });
});

describe("Pagination — onChange payloads", () => {
    it("Prev calls onChange with page-1", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        renderWithProviders(<Pagination page={3} totalPages={5} onChange={onChange} />);

        await user.click(screen.getByRole("button", { name: "Prev" }));

        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith(2);
    });

    it("Next calls onChange with page+1", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        renderWithProviders(<Pagination page={3} totalPages={5} onChange={onChange} />);

        await user.click(screen.getByRole("button", { name: "Next" }));

        expect(onChange).toHaveBeenCalledWith(4);
    });

    it("clicking a specific page number calls onChange with that page number", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        renderWithProviders(<Pagination page={3} totalPages={5} onChange={onChange} />);

        await user.click(screen.getByRole("button", { name: "2" }));

        expect(onChange).toHaveBeenCalledWith(2);
    });

    it("disabled Prev at page 1 never calls onChange when clicked", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        renderWithProviders(<Pagination page={1} totalPages={5} onChange={onChange} />);

        await user.click(screen.getByRole("button", { name: "Prev" }));

        expect(onChange).not.toHaveBeenCalled();
    });

    it("disabled Next at the last page never calls onChange when clicked", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        renderWithProviders(<Pagination page={5} totalPages={5} onChange={onChange} />);

        await user.click(screen.getByRole("button", { name: "Next" }));

        expect(onChange).not.toHaveBeenCalled();
    });

    it("the ellipsis placeholder is disabled and never calls onChange (a large page count collapses the range)", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        // page=3, totalPages=10, default siblingCount=1 -> pages [1,2,3,4,'...',10]
        renderWithProviders(<Pagination page={3} totalPages={10} onChange={onChange} />);

        const ellipsis = screen.getByRole("button", { name: "..." });
        expect(ellipsis).toBeDisabled();

        await user.click(ellipsis);
        expect(onChange).not.toHaveBeenCalled();
    });
});

describe("Pagination — per-page selector", () => {
    it("hands the chosen size to onPageSizeChange as a number, not a string", async () => {
        const user = userEvent.setup();
        const onPageSizeChange = vi.fn();
        renderWithProviders(<Pagination page={1} totalPages={5} onChange={() => {}} pageSize={25} pageSizeOptions={[25, 50, 100]} onPageSizeChange={onPageSizeChange} />);

        await user.click(screen.getByRole("button", { name: "25" }));
        await user.click(screen.getByText("100"));

        expect(onPageSizeChange).toHaveBeenCalledWith(100);
        expect(typeof onPageSizeChange.mock.calls[0][0]).toBe("number");
    });

    it("closes the size list after a choice", async () => {
        const user = userEvent.setup();
        renderWithProviders(<Pagination page={1} totalPages={5} onChange={() => {}} pageSize={25} pageSizeOptions={[25, 50, 100]} onPageSizeChange={() => {}} />);

        await user.click(screen.getByRole("button", { name: "25" }));
        expect(screen.getByText("100")).toBeInTheDocument();

        await user.click(screen.getByText("50"));

        expect(screen.queryByText("100")).not.toBeInTheDocument();
    });
});
