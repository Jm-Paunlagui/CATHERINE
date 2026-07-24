/**
 * @fileoverview Acknowledge-alert confirm modal. Small confirm with an optional note field; on confirm
 * calls `hook.confirmAcknowledge()`. Presentation only — all state and the
 * mutation itself live in metrics.hook.js.
 */

import { Textarea } from "../../../../components/forms/Textarea";
import Badge from "../../../../components/ui/Badge";
import Button from "../../../../components/ui/Button";
import { Modal } from "../../../../components/ui/Modal";

/**
 * @param {{ hook: import('../metrics.hook').MetricsHook }} props
 */
export default function AckAlertModal({ hook }) {
    return (
        <Modal
            open={hook.ackModalOpen}
            onClose={hook.closeAckModal}
            title="Acknowledge Alert"
            size="sm"
            footer={
                <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={hook.closeAckModal} disabled={hook.ackLoading}>
                        Cancel
                    </Button>
                    <Button variant="primary" loading={hook.ackLoading} onClick={hook.confirmAcknowledge}>
                        Acknowledge
                    </Button>
                </div>
            }
        >
            <div className="space-y-3">
                <div className="flex items-center gap-2">
                    <Badge variant="orange">{hook.ackTargetKey}</Badge>
                </div>

                <p className="text-sm text-black/70 dark:text-white/70">
                    Acknowledging silences the routine re-notify email for up to {hook.ackTtlHours}h. Two safety nets
                    stay in force regardless: if this alert escalates to a higher severity before then, the
                    acknowledgement clears automatically and the notification is sent anyway — and it lapses on its
                    own after {hook.ackTtlHours}h even if nobody follows up.
                </p>

                <Textarea
                    label="Note (optional)"
                    name="ackNote"
                    value={hook.ackNote}
                    rows={3}
                    placeholder="e.g. Known issue, ticket OPS-123 filed."
                    onChange={(e) => hook.setAckNote(e.target.value)}
                />
            </div>
        </Modal>
    );
}
