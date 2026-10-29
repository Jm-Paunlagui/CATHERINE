/**
 * @fileoverview EmailFailureModal — manual-dismiss dialog shown whenever a
 * backend flow reports `emailDelivery.status === 'FAILED'`: the automated
 * notification was NOT delivered on either the primary or the admin-fallback
 * tier. The operator must capture (screenshot) the content that would have
 * been emailed before dismissing — dismissal is a deliberate manual action,
 * never automatic or timed.
 *
 * Non-dismissible via Escape or backdrop click: `Modal`'s `onClose` is a
 * no-op, mirroring the precedent in
 * `src/components/feedback/SessionWarningModal.jsx`. No `title` prop is
 * passed, so `Modal`'s built-in header (and its header-× close button) never
 * renders — this component draws its own header inside the body instead.
 *
 * Presentation only. All state (`open`, `items`, `smtpCause`) lives
 * in the calling feature's hook — this component never imports a feature
 * `.hook.js` or `.api.js` file.
 *
 * Security posture (CWE-209): the SMTP cause string is backend-supplied
 * operational text (connection/timeout errors), never a stack trace — safe
 * to render verbatim to the operator who is already privileged to see the
 * underlying data in `items`.
 */

import { faCircleExclamation, faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { toReadableName } from "../../../utils/formatters";
import RequestIdTag from "../../feedback/RequestIdTag";
import Alert from "../../ui/Alert";
import Button from "../../ui/Button";
import Card from "../../ui/Card";
import { Modal } from "../../ui/Modal";
import { Divider } from "../../ui/typography/Divider";

/**
 * One undelivered email: subject, recipient, whatever template fields the
 * payload carried, and the per-recipient cause.
 * @param {{ item: { subject?: string, recipient?: string, cause?: string, emailPayload?: object } }} props
 */
function FailedEmailCard({ item }) {
    const payload = item.emailPayload ?? {};
    const entries = Object.entries(payload).filter(([k, v]) => k !== "subject" && v != null && v !== "" && !(Array.isArray(v) && v.length === 0));

    return (
        <Card variant="outlined" padding="none" className="overflow-hidden">
            <div className="h-1 bg-orange-400" />
            <div className="p-6 md:p-8">
                <div className="flex items-center justify-between gap-3 border-b border-grey-200 dark:border-grey-700 pb-3 mb-4">
                    <span className="text-sm font-aumovio-bold text-black/80 dark:text-white/80">AUMOVIO</span>
                    <span className="text-[10px] uppercase tracking-widest text-black/40 dark:text-white/35 shrink-0">Email notification</span>
                </div>

                <p className="text-sm font-aumovio-bold text-black/85 dark:text-white/85 mb-1">{item.subject ?? payload.subject ?? "Email notification"}</p>
                {item.recipient && (
                    <p className="text-xs text-black/45 dark:text-white/40 mb-3">
                        Recipient: <span className="font-aumovio-bold text-black/70 dark:text-white/60">{item.recipient}</span>
                    </p>
                )}

                {entries.length === 0 ? (
                    <p className="text-sm text-black/45 dark:text-white/40 mb-4">The email&apos;s template fields were not attached to the response — capture the recipient and cause below.</p>
                ) : (
                    <dl className="divide-y divide-grey-100 dark:divide-grey-800 text-sm mb-4">
                        {entries.map(([k, v]) => (
                            <div key={k} className="flex items-center justify-between gap-4 py-2">
                                <dt className="text-black/55 dark:text-white/50">{toReadableName(k)}</dt>
                                <dd className="font-aumovio-bold text-black/85 dark:text-white/85 text-right wrap-break-word">{Array.isArray(v) ? v.join(", ") : String(v)}</dd>
                            </div>
                        ))}
                    </dl>
                )}

                {item.cause && (
                    <p className="mt-1 flex items-start gap-2 text-xs text-danger-400">
                        <FontAwesomeIcon icon={faCircleExclamation} className="mt-1 shrink-0" />
                        <span>{item.cause}</span>
                    </p>
                )}
            </div>
        </Card>
    );
}

/**
 * @component EmailFailureModal
 * @param {object} props
 * @param {boolean} props.open
 * @param {string|null} [props.smtpCause] - The SMTP failure cause surfaced by the backend (`emailDelivery.smtpCause`).
 * @param {Array<{ subject?: string, recipient?: string, cause?: string, emailPayload?: object }>} [props.items] - One entry per undelivered email.
 * @param {string|null} [props.requestId] - Server-assigned Request ID (`res.data?.requestId`) for support/audit-log tracing of this incident, rendered as a click-to-copy tag.
 * @param {() => void} props.onDismiss - Called when the operator confirms they have captured the content.
 */
export function EmailFailureModal({ open, smtpCause, items = [], requestId = null, onDismiss }) {
    const list = Array.isArray(items) ? items : [];
    const count = list.length;

    return (
        <Modal
            open={open}
            onClose={() => {}}
            size="2xl"
            ariaLabel="Email delivery failed"
            footer={
                <Button variant="primary" onClick={onDismiss}>
                    I&apos;ve captured this — dismiss
                </Button>
            }
        >
            <div className="flex flex-col gap-5">
                {/* Own header — Modal renders no `title`, so its header-× never appears. */}
                <div className="flex items-start gap-3">
                    <div className="p-3 rounded-full bg-danger-100 dark:bg-danger-400/15 shrink-0">
                        <FontAwesomeIcon icon={faTriangleExclamation} className="text-danger-400 text-lg" />
                    </div>
                    <div className="min-w-0">
                        <h2 className="text-base font-aumovio-bold text-black/85 dark:text-white/90">Email delivery failed</h2>
                        <p className="text-xs text-black/50 dark:text-white/45 mt-1">
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
                    <div className="max-h-[55vh] overflow-y-auto hide-scrollbar pr-1">
                        {list.map((item, i) => (
                            <div key={item.recipient ?? i}>
                                {i > 0 && <Divider spacing="md" />}
                                <FailedEmailCard item={item} />
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </Modal>
    );
}

export default EmailFailureModal;
