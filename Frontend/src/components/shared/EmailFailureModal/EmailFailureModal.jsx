/**
 * @fileoverview EmailFailureModal — manual-dismiss dialog shown whenever a
 * backend flow reports `emailDelivery.status === 'FAILED'`: the automated
 * notification was NOT delivered on either the primary or the fallback tier
 * (see the backend's EmailProtectionService). The operator must capture
 * (screenshot) the content that would have been emailed before dismissing —
 * dismissal is a deliberate manual action, never automatic or timed.
 *
 * Non-dismissible via Escape or backdrop click: `Modal`'s `onClose` is a
 * no-op, mirroring the precedent in
 * `src/components/feedback/SessionWarningModal.jsx`. No `title` prop is
 * passed, so `Modal`'s built-in header (and its header-× close button) never
 * renders — this component draws its own header inside the body instead.
 *
 * Presentation only. All state (`open`, `flow`, `items`, `smtpCause`) lives
 * in the calling feature's hook — this component never imports a feature
 * `.hook.js` or `.api.js` file. Pass `renderItem` to render an app-specific
 * preview of each undelivered item; the default renders the recipient, the
 * failure cause, and any `emailPayload` fields as labelled rows.
 *
 * Security posture (CWE-209): the SMTP cause string is backend-supplied
 * operational text (connection/timeout errors), never a stack trace — safe
 * to render verbatim to the operator who is already privileged to see the
 * underlying data in `items`.
 */

import { faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import RequestIdTag from "../../feedback/RequestIdTag";
import Alert from "../../ui/Alert";
import Button from "../../ui/Button";
import Card from "../../ui/Card";
import { Modal } from "../../ui/Modal";
import { toReadableName } from "../../../utils/formatters";

/**
 * Default per-item preview — recipient, cause, and the emailPayload fields
 * rendered as labelled rows. Apps with richer email content pass their own
 * `renderItem` instead.
 *
 * @param {{ item: object, index: number }} props
 */
function DefaultItemPreview({ item, index }) {
    const payload = item?.emailPayload ?? {};
    const rows = Object.entries(payload).filter(([, v]) => v !== null && v !== undefined && v !== "");

    return (
        <Card className="p-4">
            <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs font-aumovio-bold text-black/60 dark:text-white/60">Undelivered message #{index + 1}</span>
                {item?.recipient && <span className="text-xs text-black/45 dark:text-white/40 truncate">To: {item.recipient}</span>}
            </div>
            {item?.cause && <p className="text-xs text-danger-400 mt-1.5 break-words">Cause: {item.cause}</p>}
            {rows.length > 0 && (
                <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
                    {rows.map(([key, value]) => (
                        <div key={key} className="min-w-0">
                            <dt className="text-[11px] uppercase tracking-wide text-black/40 dark:text-white/35">{toReadableName(key)}</dt>
                            <dd className="text-sm text-black/75 dark:text-white/75 break-words">{String(value)}</dd>
                        </div>
                    ))}
                </dl>
            )}
        </Card>
    );
}

/**
 * @component EmailFailureModal
 * @param {object} props
 * @param {boolean} props.open
 * @param {string} [props.flow] - Optional flow discriminator supplied by the calling feature (forwarded to `renderItem` so one modal instance can serve several flows).
 * @param {string|null} [props.smtpCause] - The SMTP failure cause surfaced by the backend (`emailDelivery.smtpCause` / `emailDelivery.cause`).
 * @param {Array<object>} [props.items] - Undelivered items — `[{ emailPayload, recipient, cause }]` (see `utils/emailDeliveryFailure.js`).
 * @param {string|null} [props.requestId] - Server-assigned Request ID (`res.data?.requestId`) for support/audit-log tracing of this incident, rendered as a click-to-copy tag.
 * @param {() => void} props.onDismiss - Called when the operator confirms they have captured the content.
 * @param {(item: object, index: number, flow: string|undefined) => import("react").ReactNode} [props.renderItem] - App-specific preview renderer for each item; defaults to a labelled-rows card.
 */
export function EmailFailureModal({ open, flow, smtpCause, items = [], requestId = null, onDismiss, renderItem }) {
    const count = Array.isArray(items) ? items.length : 0;

    return (
        <Modal
            open={open}
            onClose={() => {}}
            size="2xl"
            footer={
                <Button variant="primary" onClick={onDismiss}>
                    I&apos;ve captured this — dismiss
                </Button>
            }
        >
            <div className="flex flex-col gap-5">
                {/* Own header — Modal renders no `title`, so its header-× never appears. */}
                <div className="flex items-start gap-3">
                    <div className="p-2.5 rounded-full bg-danger-100 dark:bg-danger-400/15 shrink-0">
                        <FontAwesomeIcon icon={faTriangleExclamation} className="text-danger-400 text-lg" />
                    </div>
                    <div className="min-w-0">
                        <h2 className="text-base font-aumovio-bold text-black/85 dark:text-white/90">Email delivery failed</h2>
                        <p className="text-xs text-black/50 dark:text-white/45 mt-0.5">
                            {count} recipient{count !== 1 ? "s" : ""} did not receive this notification.
                        </p>
                        <RequestIdTag requestId={requestId} className="mt-1 text-[11px] text-black/45 dark:text-white/40 hover:text-(--accent-foreground)" />
                    </div>
                </div>

                <Alert variant="warning" title="Not delivered">
                    Email delivery failed — SMTP error: {smtpCause || "unknown SMTP error"}. Screenshot this content before dismissing; it was NOT emailed.
                </Alert>

                {count === 0 ? (
                    <p className="text-sm text-center text-black/45 dark:text-white/40 py-6">No failed-delivery details were provided.</p>
                ) : (
                    <div className="max-h-[55vh] overflow-y-auto hide-scrollbar pr-1 flex flex-col gap-3">
                        {items.map((item, index) => (typeof renderItem === "function" ? renderItem(item, index, flow) : <DefaultItemPreview key={index} item={item} index={index} />))}
                    </div>
                )}
            </div>
        </Modal>
    );
}

export default EmailFailureModal;
