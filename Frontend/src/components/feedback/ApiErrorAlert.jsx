/**
 * ApiErrorAlert — Inline error display for API failures with Request ID.
 *
 * Renders a danger Alert with the error message and, when present, the
 * structured error type, field-level details, and hint returned by the
 * backend's `sendError` shape. A small copyable Request ID line is shown
 * last for support reference.
 *
 * Backward compatible: old `{ message, requestId }` objects render fine —
 * all new fields are optional.
 *
 * Usage:
 *   <ApiErrorAlert error={apiError} onDismiss={() => setApiError(null)} />
 *
 * @param {{ error: { message: string, requestId?: string, type?: string, details?: Array<{field:string,issue:string}>, hint?: string } | null, onDismiss?: () => void, className?: string }} props
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

            {/* Error type label */}
            {error.type && <p className="mt-1 text-[10px] font-mono opacity-60 dark:opacity-50">{error.type}</p>}

            {/* Field-level details list */}
            {error.details && error.details.length > 0 && (
                <ul className="mt-1.5 space-y-0.5 text-xs opacity-80 dark:opacity-70">
                    {error.details.map((item, i) => (
                        <li key={i}>
                            {item && typeof item === "object" && item.field ? (
                                <>
                                    <span className="font-aumovio-bold">{item.field}</span> — {item.issue ?? "invalid"}
                                </>
                            ) : (
                                String(item)
                            )}
                        </li>
                    ))}
                </ul>
            )}

            {/* Hint */}
            {error.hint && <p className="mt-1.5 text-xs italic opacity-70 dark:opacity-60">{error.hint}</p>}

            {/* Request ID copy button */}
            {error.requestId && (
                <button type="button" onClick={handleCopy} className="mt-1 text-[10px] font-mono opacity-60 hover:opacity-100 cursor-copy transition-opacity" title="Click to copy Request ID">
                    Request ID: {error.requestId}
                </button>
            )}
        </Alert>
    );
}
