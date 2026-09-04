/**
 * apiErrorMapping.test.jsx — the INLINE half of the status mapping.
 *
 * Every status that is not a takeover ends up here: `extractApiError` reads the
 * envelope, `<ApiErrorAlert>` renders it. Three things must hold for that to be
 * a mapping rather than a dump:
 *
 *   • A response that never reached the server (Axios timeout, DNS failure)
 *     still gets a usable shape — an alert with a blank heading and a numeric
 *     code nobody sent reads as a bug in the app rather than a failure to reach
 *     the API.
 *   • Severity follows the STATUS, not a hardcoded `variant="danger"`. A 409
 *     "that record already exists" is amber; a 500 is red. Painting every
 *     recoverable outcome red is what teaches users to stop reading red.
 *   • The old `{ message, requestId }` shape still renders. `ApiErrorAlert`'s
 *     header comment promises backward compatibility explicitly, so it is a
 *     contract, not an implementation detail.
 *
 * CWE-209 is asserted twice: a development-mode envelope carries `error.stack`,
 * and it must reach neither the extracted object nor the DOM.
 *
 * No router and no providers: `ApiErrorAlert` renders `Alert` + `RequestIdTag`,
 * neither of which touches routing or the network. Adding the provider chain
 * here would only add ways for this file to fail for reasons it is not about.
 */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import ApiErrorAlert from "../../../src/components/feedback/ApiErrorAlert.jsx";
import { extractApiError } from "../../../src/components/ui/toast.utils.js";
import { HTTP_STATUS_TITLES, getStatusSeverity } from "../../../src/constants/httpStatus.js";
import { fail } from "../../helpers/fixtures/contract.js";

/** Builds the Axios-shaped error a feature hook's catch block actually receives. */
function axiosError(status, body, requestId = "req-abc") {
    return { response: { status, data: body, headers: {} }, requestId };
}

afterEach(cleanup);

describe("extractApiError — envelope present", () => {
    /** Every backend error code the interceptor leaves for the feature to render. */
    const INLINE_CODES = [400, 401, 403, 404, 405, 408, 409, 410, 413, 422, 423, 428, 500, 502, 503, 504, 507];

    it.each(INLINE_CODES)("carries the server's own title through for status %i", (code) => {
        const body = fail("boom", code);
        const out = extractApiError(axiosError(code, body));

        expect(out.code).toBe(code);
        expect(out.title).toBe(HTTP_STATUS_TITLES[code]);
        expect(out.message).toBe("boom");
        expect(out.severity).toBe(getStatusSeverity(code));
    });

    it("keeps the structured type, details and hint the backend supplied", () => {
        const body = fail("Invalid input.", 400, {
            type: "ValidationError",
            details: [{ field: "email", issue: "Invalid email format" }],
            hint: "Ensure the email is a valid address.",
        });

        const out = extractApiError(axiosError(400, body));

        expect(out.type).toBe("ValidationError");
        expect(out.details).toEqual([{ field: "email", issue: "Invalid email format" }]);
        expect(out.hint).toBe("Ensure the email is a valid address.");
    });

    it("drops a non-array `details` instead of handing an unmappable value to the view", () => {
        // `<ApiErrorAlert>` calls `error.details.map(...)`. A backend that sent a
        // string here would otherwise crash the alert that exists to report the
        // failure — the worst possible place to throw.
        const body = { ...fail("boom", 400) };
        body.error.details = "not-an-array";

        expect(extractApiError(axiosError(400, body)).details).toBeNull();
    });

    it("prefers the error object's requestId, falling back to the body's", () => {
        // `HttpClient` attaches `error.requestId` from the header when the body
        // has none, so the header wins by construction.
        const body = fail("boom", 500);
        expect(extractApiError(axiosError(500, body, "from-error")).requestId).toBe("from-error");
        expect(extractApiError({ response: { status: 500, data: body } }).requestId).toBe(body.requestId);
    });

    it("never extracts error.stack (CWE-209)", () => {
        const body = { ...fail("boom", 500) };
        body.error.stack = "Error: SECRET TRACE\n  at internal";

        const out = extractApiError(axiosError(500, body));

        expect(out.stack).toBeUndefined();
        expect(JSON.stringify(out)).not.toContain("SECRET TRACE");
    });
});

describe("extractApiError — no envelope", () => {
    it("derives a title from the bare status when the body is not ours", () => {
        // An edge proxy answering with HTML. There is no envelope to read, but
        // there IS a status, so the shared map still supplies a real heading.
        const out = extractApiError({ response: { status: 502, data: "<html>502 Bad Gateway</html>" } });

        expect(out.code).toBe(502);
        expect(out.title).toBe("Bad Gateway");
        expect(out.severity).toBe("danger");
        expect(out.type).toBeNull();
    });

    it("leaves the code and title null when there is no status at all (timeout / DNS failure)", () => {
        // A synthetic Axios timeout has no `response`. Inventing a code here
        // would put a number on the alert that no server ever sent.
        const out = extractApiError(Object.assign(new Error("timeout of 30000ms exceeded"), { code: "ECONNABORTED" }), "The request timed out.");

        expect(out.code).toBeNull();
        expect(out.title).toBeNull();
        expect(out.message).toBe("The request timed out.");
        expect(out.severity).toBe("info");
    });

    it("uses the caller's fallback message when the envelope has none", () => {
        expect(extractApiError({ response: { status: 500, data: {} } }, "We couldn't save that.").message).toBe("We couldn't save that.");
    });

    it("survives a null/undefined error object", () => {
        // Hooks call this from a catch block; a thrown non-Error still lands here.
        for (const bad of [null, undefined, {}]) {
            const out = extractApiError(bad);
            expect(out.code).toBeNull();
            expect(out.message).toBe("An unexpected error occurred.");
        }
    });
});

describe("ApiErrorAlert — severity follows the status", () => {
    it("renders nothing for a null error", () => {
        const { container } = render(<ApiErrorAlert error={null} />);
        expect(container.innerHTML).toBe("");
    });

    it.each([
        [404, "warning"],
        [409, "warning"],
        [413, "warning"],
        [423, "warning"],
        [428, "warning"],
        [400, "danger"],
        [403, "danger"],
        [422, "danger"],
        [500, "danger"],
    ])("paints status %i as %s", (code, expected) => {
        const error = extractApiError(axiosError(code, fail("boom", code)));
        const { container } = render(<ApiErrorAlert error={error} />);

        expect(error.severity).toBe(expected);
        // `Alert` keys its surface off CSS custom properties named per variant,
        // so the rendered class name is the observable proof of the variant.
        expect(container.innerHTML).toContain(`--status-${expected}-bg`);
    });

    it("lets a call site override the tone explicitly", () => {
        const error = extractApiError(axiosError(409, fail("boom", 409)));
        const { container } = render(<ApiErrorAlert error={error} variant="danger" />);
        expect(container.innerHTML).toContain("--status-danger-bg");
    });

    it("prefers an explicit error.severity over the status map", () => {
        // `extractApiError` sets `severity`; a feature that overrides it on the
        // way to the alert must win over a second lookup of the same code.
        const { container } = render(<ApiErrorAlert error={{ code: 500, severity: "warning", message: "Degraded, not dead." }} />);
        expect(container.innerHTML).toContain("--status-warning-bg");
    });

    it("defaults to danger for a legacy error object carrying no code or severity", () => {
        // Backward compatibility: the old `{ message, requestId }` shape.
        const { container } = render(<ApiErrorAlert error={{ message: "Something went wrong", requestId: "req-1" }} />);
        expect(container.innerHTML).toContain("--status-danger-bg");
        expect(screen.getByText("Something went wrong")).toBeTruthy();
        expect(screen.getByText(/req-1/)).toBeTruthy();
    });
});

describe("ApiErrorAlert — content", () => {
    it("renders the title, message, field details, hint, code and type", () => {
        const error = extractApiError(
            axiosError(
                400,
                fail("Invalid input.", 400, {
                    type: "ValidationError",
                    details: [{ field: "email", issue: "Invalid email format" }],
                    hint: "Ensure the email is a valid address.",
                }),
            ),
        );

        render(<ApiErrorAlert error={error} />);

        expect(screen.getByText("Bad Request")).toBeTruthy();
        expect(screen.getByText("Invalid input.")).toBeTruthy();
        expect(screen.getByText("email")).toBeTruthy();
        expect(screen.getByText(/Invalid email format/)).toBeTruthy();
        expect(screen.getByText("Ensure the email is a valid address.")).toBeTruthy();
        expect(screen.getByText(/ValidationError/)).toBeTruthy();
    });

    it("renders the requestId click-to-copy so a user can quote it to support", () => {
        const error = extractApiError(axiosError(500, fail("boom", 500), "req-trace-1"));
        render(<ApiErrorAlert error={error} />);

        expect(screen.getByRole("button", { name: /req-trace-1/ })).toBeTruthy();
    });

    it("falls back to the status title when the envelope omitted one", () => {
        render(<ApiErrorAlert error={{ code: 423, message: "Locked." }} />);
        expect(screen.getByText("Locked Resource")).toBeTruthy();
    });

    it("renders a detail entry that is not a { field, issue } object rather than blanking it", () => {
        render(<ApiErrorAlert error={{ code: 400, message: "boom", details: ["plain string detail"] }} />);
        expect(screen.getByText("plain string detail")).toBeTruthy();
    });

    it("never renders a stack trace even when one is handed to it (CWE-209)", () => {
        const { container } = render(<ApiErrorAlert error={{ code: 500, message: "boom", stack: "Error: SECRET TRACE" }} />);
        expect(container.textContent).not.toContain("SECRET TRACE");
    });

    it("dismisses on click and tells the caller", async () => {
        const onDismiss = vi.fn();
        const user = userEvent.setup();
        render(<ApiErrorAlert error={{ code: 500, message: "boom" }} onDismiss={onDismiss} />);

        await user.click(screen.getByRole("button", { name: "Dismiss" }));

        expect(onDismiss).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("pairs its light surface with a dark counterpart", () => {
        const error = extractApiError(axiosError(409, fail("boom", 409)));
        const { container } = render(<ApiErrorAlert error={error} />);
        expect(container.innerHTML).toMatch(/dark:/);
    });
});
