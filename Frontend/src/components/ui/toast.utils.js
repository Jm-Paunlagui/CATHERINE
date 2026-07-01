import { createElement } from "react";
import { toast as t } from "react-toastify";

/**
 * Extract a standardised `{ message, requestId }` error shape from an Axios error.
 *
 * Used by hooks to set inline error state for `<ApiErrorAlert>` rendering.
 * Also used internally by `toast.apiError`.
 *
 * @param {Error & { response?: object, requestId?: string }} err
 *   The Axios error (enriched by HttpClient's response interceptor).
 * @param {string} [fallbackMsg="An unexpected error occurred."]
 * @returns {{ message: string, requestId: string | null }}
 */
export function extractApiError(err, fallbackMsg = "An unexpected error occurred.") {
    return {
        message: err?.response?.data?.message ?? fallbackMsg,
        requestId: err?.requestId ?? err?.response?.data?.requestId ?? null,
    };
}

/**
 * Render an API error toast with the server message and a copyable Request ID.
 * Clicking the Request ID copies it to the clipboard for support/debugging.
 *
 * @param {string} message   - The error message to display.
 * @param {string|null} requestId - The server-assigned Snowflake Request ID.
 * @returns {import('react').ReactElement}
 */
function ApiErrorContent({ message, requestId }) {
    const handleCopy = () => {
        if (requestId) {
            navigator.clipboard?.writeText(requestId).catch(() => {});
        }
    };

    return createElement(
        "div",
        { className: "flex flex-col gap-1" },
        createElement("span", null, message),
        requestId &&
            createElement(
                "button",
                {
                    type: "button",
                    onClick: handleCopy,
                    className: "text-[10px] font-mono opacity-70 hover:opacity-100 text-left cursor-copy transition-opacity",
                    title: "Click to copy Request ID",
                },
                `ID: ${requestId}`,
            ),
    );
}

export const toast = {
    success: (msg, opts) => t.success(msg, opts),
    error: (msg, opts) => t.error(msg, opts),
    warning: (msg, opts) => t.warning(msg, opts),
    info: (msg, opts) => t.info(msg, opts),
    loading: (msg, opts) => t.loading(msg, opts),
    dismiss: (id) => t.dismiss(id),
    promise: (promise, { loading, success, error }, opts) => t.promise(promise, { pending: loading, success, error }, opts),

    /**
     * Display an API error toast with the server message and Request ID.
     *
     * Extracts the message from the Axios error's response body (or uses the
     * fallback), and displays the server-assigned Request ID in a small
     * copyable line below the message. Clicking the ID copies it to clipboard.
     *
     * Usage in hooks:
     *   catch (err) {
     *     toast.apiError(err, "Failed to save changes.");
     *   }
     *
     * @param {Error & { response?: object, requestId?: string }} err
     *   The Axios error (enriched by HttpClient's response interceptor with `err.requestId`).
     * @param {string} [fallbackMsg="An unexpected error occurred."]
     *   Message to show when the server response has no message field.
     * @param {object} [opts] - Additional react-toastify options.
     */
    apiError: (err, fallbackMsg = "An unexpected error occurred.", opts) => {
        const { message, requestId } = extractApiError(err, fallbackMsg);
        return t.error(createElement(ApiErrorContent, { message, requestId }), { autoClose: 8000, ...opts });
    },
};
