/**
 * ApiErrorAlert — Structured inline error display for API failures.
 *
 * Maps the backend's `sendError` envelope into a layered Alert layout:
 *
 *   ┌─ Title ─────────────────────────────────────────────── ✕ ┐
 *   │  Message body text                                      │
 *   │  • field — issue  (details list, when present)          │
 *   │  Hint text in italics (when present)                    │
 *   │  ─────────────────────────────────────────────────────── │
 *   │  401 · AuthenticationError                              │
 *   │  Request ID: 0080108131775-0448-7246  ⎘                 │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Backward compatible: old `{ message, requestId }` objects render fine —
 * all new fields (`title`, `code`, `type`, `details`, `hint`) are optional.
 *
 * Usage:
 *   <ApiErrorAlert error={apiError} onDismiss={() => setApiError(null)} />
 *
 * @param {{ error: { title?: string, code?: number, message: string, requestId?: string, type?: string, details?: Array<{field:string,issue:string}>, hint?: string } | null, onDismiss?: () => void, className?: string }} props
 */

import Alert from "../ui/Alert";
import RequestIdTag from "./RequestIdTag";

export default function ApiErrorAlert({ error, onDismiss, className = "" }) {
    if (!error) return null;

    const hasDetails = error.details && error.details.length > 0;
    const hasFooter = error.code || error.type || error.requestId;

    return (
        <Alert variant="danger" size="sm" title={error.title} dismissible onDismiss={onDismiss} className={className}>
            {/* ── Message body ── */}
            <p className="leading-snug">{error.message}</p>

            {/* ── Field-level details ── */}
            {hasDetails && (
                <ul className="mt-2 space-y-0.5 text-[11px] list-disc list-inside opacity-80 dark:opacity-70">
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

            {/* ── Hint ── */}
            {error.hint && <p className="mt-2 text-[11px] italic opacity-70 dark:opacity-60">{error.hint}</p>}

            {/* ── Metadata footer ── */}
            {hasFooter && (
                <div className="mt-2.5 pt-2 border-t border-current/10 space-y-1">
                    {/* Code · Type row */}
                    {(error.code || error.type) && (
                        <p className="text-[10px] font-mono opacity-50 dark:opacity-40">
                            {error.code && <span>{error.code}</span>}
                            {error.code && error.type && <span className="mx-1">·</span>}
                            {error.type && <span>{error.type}</span>}
                        </p>
                    )}
                    {/* Request ID */}
                    <RequestIdTag requestId={error.requestId} className="text-[10px] opacity-50 dark:opacity-40 hover:opacity-100" />
                </div>
            )}
        </Alert>
    );
}
