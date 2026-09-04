/**
 * input.test.jsx — Unit tests for the load-bearing shared `Input` component
 * (src/components/forms/Input.jsx): error rendering, the required marker, the
 * onChange payload shape, and label wiring.
 *
 * IMPORTANT (read from source, not assumed): `Input` forwards `onChange`
 * straight to the native `<input>`, so the callback receives the raw DOM
 * ChangeEvent and the caller reads `event.target.value` — NOT a bare value like
 * `Select` hands back. The two shared form controls disagree on this, which is
 * exactly why both have their own payload-shape test. A small local controlled
 * wrapper is used so `user.type()` accumulates characters realistically instead
 * of the DOM value snapping back to a static prop after every keystroke.
 *
 * `Input` has no `required` validation of its own beyond the native attribute —
 * the asterisk is presentation. Both are asserted; neither implies the other.
 */

import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Input } from "../../../src/components/forms/Input.jsx";
import { renderWithProviders } from "../../helpers/renderWithProviders.jsx";

function ControlledInput({ onChangeSpy, ...props }) {
    const [value, setValue] = useState(props.value ?? "");
    return (
        <Input
            {...props}
            value={value}
            onChange={(e) => {
                onChangeSpy(e);
                setValue(e.target.value);
            }}
        />
    );
}

describe("Input — error prop rendering (unhappy path first)", () => {
    it("renders the error message", () => {
        renderWithProviders(<Input label="Email" name="email" value="" onChange={() => {}} error="Email is required" />);
        expect(screen.getByText("Email is required")).toBeInTheDocument();
    });

    it("suppresses the helper text when an error is present (mutually exclusive)", () => {
        renderWithProviders(<Input label="Email" name="email" value="" onChange={() => {}} error="Email is required" helper="We'll never share it" />);
        expect(screen.getByText("Email is required")).toBeInTheDocument();
        expect(screen.queryByText("We'll never share it")).not.toBeInTheDocument();
    });

    it("shows the helper text when there is no error", () => {
        renderWithProviders(<Input label="Email" name="email" value="" onChange={() => {}} helper="We'll never share it" />);
        expect(screen.getByText("We'll never share it")).toBeInTheDocument();
    });

    // The error state is a border/background swap with no rendered text of its
    // own, so the class is the only observable — jsdom applies no CSS.
    it("swaps the field to the danger border state, and back off it when the error clears", () => {
        const { rerender } = renderWithProviders(<Input label="Email" name="email" value="" onChange={() => {}} error="Email is required" />);
        expect(screen.getByLabelText("Email").className).toContain("border-danger-400");

        rerender(<Input label="Email" name="email" value="" onChange={() => {}} />);
        expect(screen.getByLabelText("Email").className).not.toContain("border-danger-400");
    });
});

describe("Input — required marker", () => {
    it("renders a required asterisk next to the label when required=true", () => {
        renderWithProviders(<Input label="Username" name="username" value="" onChange={() => {}} required />);
        const label = screen.getByText("Username").closest("label");
        expect(label).toHaveTextContent("*");
    });

    it("renders no asterisk when required is omitted/false", () => {
        renderWithProviders(<Input label="Username" name="username" value="" onChange={() => {}} />);
        const label = screen.getByText("Username").closest("label");
        expect(label).not.toHaveTextContent("*");
    });

    it("also sets the native required attribute, so the marker is never decoration alone", () => {
        renderWithProviders(<Input label="Username" name="username" value="" onChange={() => {}} required />);
        expect(screen.getByLabelText(/Username/)).toBeRequired();
    });
});

describe("Input — label wiring", () => {
    it("associates the label with the input via htmlFor/id (falls back to `name` when no id is given)", () => {
        renderWithProviders(<Input label="Email Address" name="email" value="" onChange={() => {}} />);
        const input = screen.getByLabelText("Email Address");
        expect(input).toBeInTheDocument();
        expect(input).toHaveAttribute("id", "email");
    });

    it("prefers an explicit `id` over `name` for the label association", () => {
        renderWithProviders(<Input label="Email Address" name="email" id="custom-id" value="" onChange={() => {}} />);
        const input = screen.getByLabelText("Email Address");
        expect(input).toHaveAttribute("id", "custom-id");
    });
});

describe("Input — onChange payload shape", () => {
    it("fires onChange with the native ChangeEvent; event.target.value accumulates typed characters", async () => {
        const user = userEvent.setup();
        const onChangeSpy = vi.fn();
        renderWithProviders(<ControlledInput label="Username" name="username" onChangeSpy={onChangeSpy} />);

        await user.type(screen.getByLabelText("Username"), "abc");

        expect(onChangeSpy).toHaveBeenCalledTimes(3);
        const lastEvent = onChangeSpy.mock.calls.at(-1)[0];
        expect(lastEvent.target.value).toBe("abc");
        expect(screen.getByLabelText("Username")).toHaveValue("abc");
    });

    it("fires no onChange at all while disabled", async () => {
        const user = userEvent.setup();
        const onChangeSpy = vi.fn();
        renderWithProviders(<ControlledInput label="Username" name="username" onChangeSpy={onChangeSpy} disabled />);

        await user.type(screen.getByLabelText("Username"), "abc");

        expect(onChangeSpy).not.toHaveBeenCalled();
        expect(screen.getByLabelText("Username")).toBeDisabled();
    });
});

describe("Input — type forwarding", () => {
    // A password field that silently renders as type="text" is a disclosure
    // bug, not a styling one — assert the prop actually reaches the DOM node.
    it("forwards `type` to the native input so a password field is genuinely masked", () => {
        renderWithProviders(<Input label="Password" name="password" type="password" value="" onChange={() => {}} />);
        expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    });

    it("defaults to type=text when no type is given", () => {
        renderWithProviders(<Input label="Nickname" name="nickname" value="" onChange={() => {}} />);
        expect(screen.getByLabelText("Nickname")).toHaveAttribute("type", "text");
    });
});
