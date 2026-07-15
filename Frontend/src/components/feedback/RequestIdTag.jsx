/**
 * @fileoverview RequestIdTag — shared click-to-copy Request ID tag.
 *
 * Every JSON response — success AND error — is wrapped by the backend's
 * `TraceabilityMiddleware`, which injects a root-level `requestId` into the
 * envelope (`res.data.requestId`). `HttpClient`'s response interceptor also
 * attaches `error.requestId` on failed requests so it survives into a
 * catch block. This component is the single rendering + copy-to-clipboard
 * implementation for that value, consumed by `ApiErrorAlert`,
 * `ErrorBoundary`, and `EmailFailureModal` so the three call sites do not
 * each re-implement the same button + clipboard + reset-timer logic.
 *
 * Renders `null` when `requestId` is falsy — callers never need to wrap it
 * in a conditional.
 *
 * Colour, size, and spacing are deliberately NOT owned by this component —
 * pass them via `className` so each call site can match its surrounding
 * surface (e.g. a danger Alert vs. a neutral modal header vs. the
 * ErrorBoundary fallback screen). This component owns only layout
 * (`inline-flex`), the copy behaviour, and the icon swap.
 *
 * Usage:
 *   <RequestIdTag requestId={error.requestId} className="mt-1 text-[10px] opacity-60 hover:opacity-100" />
 *
 * @param {object} props
 * @param {string|null|undefined} props.requestId - Server-assigned Request ID (`res.data.requestId` / `error.requestId`). Renders nothing when falsy.
 * @param {string} [props.className=""] - Caller-supplied Tailwind classes for colour/size/spacing (this component owns only layout + behaviour).
 * @param {string} [props.title="Click to copy Request ID"] - Tooltip text for the button.
 */

import { useCallback, useState } from "react";
import { LuCopy, LuCopyCheck } from "react-icons/lu";

export function RequestIdTag({ requestId, className = "", title = "Click to copy Request ID" }) {
    const [copied, setCopied] = useState(false);

    const handleCopy = useCallback(() => {
        navigator.clipboard
            ?.writeText(requestId)
            .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
            })
            .catch(() => {});
    }, [requestId]);

    if (!requestId) return null;

    return (
        <button type="button" onClick={handleCopy} className={`inline-flex items-center gap-1.5 font-mono cursor-copy transition-colors ${className}`} title={title}>
            Request ID: {requestId}
            {copied ? <LuCopyCheck className="w-3.5 h-3.5 text-success-400 shrink-0" aria-hidden /> : <LuCopy className="w-3.5 h-3.5 shrink-0" aria-hidden />}
        </button>
    );
}

export default RequestIdTag;
