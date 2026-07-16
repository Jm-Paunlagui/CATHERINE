import { createElement } from "react";
import { toast as t } from "react-toastify";
import { copyToClipboard } from "../../utils/clipboard";

/**
 * Extract a standardised error shape from an Axios error for `<ApiErrorAlert>`.
 *
 * Returns the server title, HTTP code, message, requestId, and — when the
 * backend includes them — the structured `error.type`, `error.details`, and
 * `error.hint` fields. `error.stack` is **never** extracted (CWE-209 — stack
 * traces must not render in the UI even when the server includes them in
 * development mode).
 *
 * @param {Error & { response?: object, requestId?: string }} err
 * @param {string} [fallbackMsg="An unexpected error occurred."]
 * @returns {{ title: string|null, code: number|null, message: string, requestId: string|null, type: string|null, details: Array<{field:string,issue:string}>|null, hint: string|null }}
 */
export function extractApiError(err, fallbackMsg = "An unexpected error occurred.") {
    const data = err?.response?.data;
    const errBody = data?.error;
    return {
        title: data?.title ?? null,
        code: data?.code ?? err?.response?.status ?? null,
        message: data?.message ?? fallbackMsg,
        requestId: err?.requestId ?? data?.requestId ?? null,
        type: errBody?.type ?? null,
        details: Array.isArray(errBody?.details) ? errBody.details : null,
        hint: errBody?.hint ?? null,
    };
}

/**
 * Render an API error toast with the server message and a copyable Request ID.
 * @param {string} message
 * @param {string|null} requestId
 */
function ApiErrorContent({ message, requestId }) {
    const handleCopy = () => {
        if (requestId) copyToClipboard(requestId);
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
     * @deprecated Prefer `setApiError(extractApiError(err, msg))` + `<ApiErrorAlert>` for
     * inline display with a copyable Request ID. All feature hooks now use the inline
     * pattern. This method is retained only for edge cases where no inline error area
     * exists (e.g., a fire-and-forget background job with no UI surface).
     *
     * @param {Error & { response?: object, requestId?: string }} err
     * @param {string} [fallbackMsg="An unexpected error occurred."]
     * @param {object} [opts]
     */
    apiError: (err, fallbackMsg = "An unexpected error occurred.", opts) => {
        const { message, requestId } = extractApiError(err, fallbackMsg);
        return t.error(createElement(ApiErrorContent, { message, requestId }), { autoClose: 8000, ...opts });
    },
};
