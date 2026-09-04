/**
 * select.test.jsx — Unit tests for the load-bearing shared `Select` component
 * (src/components/forms/Select.jsx): error rendering, the onChange payload
 * shape, label wiring, and the multi-select branch.
 *
 * VERIFIED FROM SOURCE, not assumed:
 *   • `Select` calls `onChange(value)` with the RAW option value — never an
 *     event. `Input` does the opposite. Two shared controls with opposite
 *     callback contracts is precisely the kind of thing a caller gets wrong, so
 *     both are pinned by their own test.
 *   • The prop list is `{ options, value, onChange, label, placeholder, error,
 *     disabled, multiple, size, id, name, fixed }`. There is NO `required`
 *     prop, so no required-marker test is written here — that behaviour does
 *     not exist (see input.test.jsx for the `Input` marker instead).
 *   • The trigger is a `<button>` associated with a real `<label for=…>`, so
 *     its ARIA accessible name is computed FROM THE LABEL ("Role"), not from
 *     its visible text ("Choose one" / "Option A"): the accessible-name
 *     algorithm prefers a native label over "name from content". Every query
 *     below reaches the trigger via `getByLabelText("Role")`, never
 *     `getByRole("button", { name: <visible text> })`.
 */

import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Select } from "../../../src/components/forms/Select.jsx";
import { renderWithProviders } from "../../helpers/renderWithProviders.jsx";

const OPTIONS = [
    { value: "a", label: "Option A" },
    { value: "b", label: "Option B" },
];

describe("Select — error prop rendering (unhappy path first)", () => {
    it("renders the error message below the trigger", () => {
        renderWithProviders(<Select label="Role" options={OPTIONS} value="" onChange={() => {}} error="Role is required" />);
        expect(screen.getByText("Role is required")).toBeInTheDocument();
    });

    it("renders no error message when error is omitted", () => {
        renderWithProviders(<Select label="Role" options={OPTIONS} value="" onChange={() => {}} />);
        expect(screen.queryByText("Role is required")).not.toBeInTheDocument();
    });

    it("puts the trigger itself into the danger border state, not just the message below it", () => {
        renderWithProviders(<Select label="Role" name="role" options={OPTIONS} value="" onChange={() => {}} error="Role is required" />);
        expect(screen.getByLabelText("Role").className).toContain("border-danger-400");
    });
});

describe("Select — label wiring", () => {
    it("associates the label with the trigger button via htmlFor/id (falls back to `name`)", () => {
        renderWithProviders(<Select label="Role" name="role" options={OPTIONS} value="" onChange={() => {}} placeholder="Choose one" />);
        const trigger = screen.getByLabelText("Role");
        expect(trigger).toBeInTheDocument();
        expect(trigger.tagName).toBe("BUTTON");
        expect(trigger).toHaveAttribute("id", "role");
    });

    // type="button" is load-bearing: a Select dropped inside a <form> whose
    // trigger defaulted to type="submit" would submit the form on every open.
    it("renders the trigger as type=button so opening the dropdown cannot submit a surrounding form", () => {
        renderWithProviders(<Select label="Role" name="role" options={OPTIONS} value="" onChange={() => {}} />);
        expect(screen.getByLabelText("Role")).toHaveAttribute("type", "button");
    });
});

describe("Select — onChange payload shape", () => {
    it("calls onChange with the RAW option value (a plain string), not an event object", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        renderWithProviders(<Select label="Role" name="role" options={OPTIONS} value="" onChange={onChange} placeholder="Choose one" />);

        await user.click(screen.getByLabelText("Role"));
        await user.click(screen.getByText("Option A"));

        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith("a");
        // Explicitly document the "not an event" contract callers must code to:
        expect(typeof onChange.mock.calls[0][0]).toBe("string");
    });

    it("selecting the placeholder/clear row calls onChange with an empty string", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        renderWithProviders(<Select label="Role" name="role" options={OPTIONS} value="a" onChange={onChange} placeholder="Choose one" />);

        await user.click(screen.getByLabelText("Role"));
        await user.click(screen.getByText("Choose one"));

        expect(onChange).toHaveBeenCalledWith("");
    });

    it("closes the dropdown after a single selection (options are no longer present)", async () => {
        const user = userEvent.setup();
        renderWithProviders(<Select label="Role" name="role" options={OPTIONS} value="" onChange={() => {}} placeholder="Choose one" />);

        await user.click(screen.getByLabelText("Role"));
        expect(screen.getByText("Option B")).toBeInTheDocument();

        await user.click(screen.getByText("Option A"));

        expect(screen.queryByText("Option B")).not.toBeInTheDocument();
    });

    it("never opens — and never calls onChange — while disabled", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        renderWithProviders(<Select label="Role" name="role" options={OPTIONS} value="" onChange={onChange} disabled />);

        await user.click(screen.getByLabelText("Role"));

        expect(screen.queryByText("Option A")).not.toBeInTheDocument();
        expect(onChange).not.toHaveBeenCalled();
    });
});

describe("Select — multiple", () => {
    // The multi branch has a different payload contract (an ARRAY of strings)
    // and deliberately keeps the list open so a second value can be added
    // without reopening — both are easy to regress into the single-select path.
    it("calls onChange with an array of string values and keeps the list open", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        renderWithProviders(<Select label="Role" name="role" options={OPTIONS} value={["a"]} onChange={onChange} multiple />);

        await user.click(screen.getByLabelText("Role"));
        await user.click(screen.getByText("Option B"));

        expect(onChange).toHaveBeenCalledWith(["a", "b"]);
        // Still open — the user can add another value without reopening. Asserted
        // on "Option B" rather than "Option A": with one value selected the
        // trigger ALSO renders the label "Option A", so that string is
        // legitimately in the DOM twice and cannot carry an open/closed claim.
        expect(screen.getByText("Option B")).toBeInTheDocument();
    });

    it("toggles an already-selected value back off", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        renderWithProviders(<Select label="Role" name="role" options={OPTIONS} value={["a", "b"]} onChange={onChange} multiple />);

        await user.click(screen.getByLabelText("Role"));
        await user.click(screen.getByText("Option A"));

        expect(onChange).toHaveBeenCalledWith(["b"]);
    });

    it("summarises the trigger as a count once more than one value is selected", async () => {
        renderWithProviders(<Select label="Role" name="role" options={OPTIONS} value={["a", "b"]} onChange={() => {}} multiple />);
        expect(screen.getByLabelText("Role")).toHaveTextContent("2 selected");
    });
});
