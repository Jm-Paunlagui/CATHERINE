/**
 * SessionWarningModal — Proactive session-expiry dialog.
 *
 * Driven entirely by useSessionWarning. The modal is non-dismissible
 * (backdrop click and Escape are no-ops) — the user must choose an action.
 */

import Button from "../ui/Button";
import { Modal } from "../ui/Modal";
import { useSessionWarning } from "../../hooks/useSessionWarning";

export default function SessionWarningModal() {
    const { visible, countdown, extending, extendSession, signOut } = useSessionWarning();

    return (
        <Modal
            open={visible}
            onClose={() => {}}
            title="Session Expiring Soon"
            size="sm"
            footer={
                <>
                    <Button variant="ghost" onClick={signOut} disabled={extending}>
                        Sign Out
                    </Button>
                    <Button variant="primary" loading={extending} onClick={extendSession}>
                        Extend Session
                    </Button>
                </>
            }
        >
            <div className="flex flex-col items-center gap-4 py-2">
                <div className="text-7xl font-aumovio-bold text-(--accent-foreground) tabular-nums leading-none">{countdown}</div>
                <p className="text-sm text-grey-600 dark:text-grey-400 text-center">
                    Your session will expire in{" "}
                    <span className="font-aumovio-bold text-black/85 dark:text-white/90">
                        {countdown} second{countdown !== 1 ? "s" : ""}
                    </span>
                    . Click <strong>Extend Session</strong> to stay logged in, or you will be signed out automatically.
                </p>
            </div>
        </Modal>
    );
}
