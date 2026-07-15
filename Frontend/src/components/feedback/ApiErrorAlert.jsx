/**
 * ApiErrorAlert — Inline error display for API failures with Request ID.
 *
 * Renders a danger Alert with the error message and, when present, the
 * structured error type, field-level details, and hint returned by the
 * backend's `sendError` shape. The shared `RequestIdTag` (click-to-copy,
 * with a react-icons/lu copy icon) is shown last for support reference.
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
import RequestIdTag from "./RequestIdTag";

export default function ApiErrorAlert({ error, onDismiss, className = "" }) {
    if (!error) return null;

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

            {/* Request ID copy tag */}
            <RequestIdTag requestId={error.requestId} className="mt-1 text-[10px] opacity-60 hover:opacity-100" />
        </Alert>
    );
}
