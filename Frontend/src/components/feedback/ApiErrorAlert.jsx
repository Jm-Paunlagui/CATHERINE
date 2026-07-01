/**
 * ApiErrorAlert — Inline error display for API failures with Request ID.
 *
 * Renders a danger Alert with the error message and a small, copyable
 * Request ID line. Positioned inline near the action that failed (above
 * the submit button, below the last form field) — never as a toast.
 *
 * Usage:
 *   <ApiErrorAlert error={apiError} onDismiss={() => setApiError(null)} />
 *
 * Where `apiError` is `{ message: string, requestId?: string } | null`.
 *
 * @param {{ error: { message: string, requestId?: string } | null, onDismiss?: () => void, className?: string }} props
 */

import Alert from "../ui/Alert";

export default function ApiErrorAlert({ error, onDismiss, className = "" }) {
    if (!error) return null;

    const handleCopy = () => {
        if (error.requestId) {
            navigator.clipboard?.writeText(error.requestId).catch(() => {});
        }
    };

    return (
        <Alert variant="danger" size="sm" dismissible onDismiss={onDismiss} className={className}>
            <p>{error.message}</p>
            {error.requestId && (
                <button type="button" onClick={handleCopy} className="mt-1 text-[10px] font-mono opacity-60 hover:opacity-100 cursor-copy transition-opacity" title="Click to copy Request ID">
                    Request ID: {error.requestId}
                </button>
            )}
        </Alert>
    );
}
