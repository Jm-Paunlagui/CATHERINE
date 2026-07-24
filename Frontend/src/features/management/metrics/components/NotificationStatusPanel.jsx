/**
 * @fileoverview Notification status panel — top of the Alerts area.
 * Shows whether server email notifications are enabled, masked recipients
 * per channel, SMTP dependency health, a recent-sends mini-list, and (for
 * SUPER_ADMIN only) a test-send control. Presentation only — all data and
 * mutations live in metrics.hook.js.
 */

import { ANIMATE_ENTER_UP, ANIM_DELAY_0 } from "../../../../assets/styles/pre-set-styles";
import { Select } from "../../../../components/forms/Select";
import Badge from "../../../../components/ui/Badge";
import Button from "../../../../components/ui/Button";
import Card from "../../../../components/ui/Card";
import Skeleton from "../../../../components/ui/Skeleton";

const CHANNEL_LABELS = {
    "server-critical-notification": "Critical",
    "server-dependencies-notification": "Dependencies",
    "server-red-metrics-notification": "Red Metrics",
    "server-system-notification": "System",
};

const CHANNEL_OPTIONS = Object.entries(CHANNEL_LABELS).map(([value, label]) => ({ value, label }));

function smtpStatusVariant(status) {
    switch (status) {
        case "up":
            return "green";
        case "degraded":
            return "warning";
        case "down":
            return "red";
        default:
            return "grey";
    }
}

/**
 * @param {{ hook: import('../metrics.hook').MetricsHook }} props
 */
export default function NotificationStatusPanel({ hook }) {
    const status = hook.notificationStatus;
    const smtp = hook.snapshot?.dependencies?.smtp;

    if (hook.notificationStatusLoading) {
        return (
            <Card className="bg-(--bg-surface) dark:bg-(--bg-surface-2) p-4 space-y-3">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-16 w-full" />
            </Card>
        );
    }

    if (hook.notificationStatusError) {
        return (
            <Card className="bg-(--bg-surface) dark:bg-(--bg-surface-2) p-4">
                <p className="text-sm text-danger-400">{hook.notificationStatusErrorMessage}</p>
            </Card>
        );
    }

    if (!status) return null;

    return (
        <Card className={`bg-(--bg-surface) dark:bg-(--bg-surface-2) p-4 space-y-4 ${ANIMATE_ENTER_UP} ${ANIM_DELAY_0} overflow-visible`}>
            <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
                <div className="flex items-center gap-2">
                    <h3 className="text-md font-aumovio-bold text-black/80 dark:text-white/80">Server Email Notifications</h3>
                    <Badge variant={status.enabled ? "green" : "grey"} size="sm">
                        {status.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                    {smtp && (
                        <Badge variant={smtpStatusVariant(smtp.status)} size="sm">
                            SMTP {smtp.status ?? "unknown"}
                        </Badge>
                    )}
                </div>

                {/* Test-send control — SUPER_ADMIN only */}
                {hook.isSuperAdmin && (
                    <div className="flex items-center gap-2">
                        <Select options={CHANNEL_OPTIONS} value={hook.testSendChannel} onChange={hook.setTestSendChannel} placeholder="Choose a channel" className="w-44" />
                        <Button variant="outline" size="md" loading={hook.testSendLoading} disabled={!hook.testSendChannel} onClick={hook.sendTestNotification}>
                            Send Test
                        </Button>
                    </div>
                )}
            </div>

            {/* Per-channel masked recipients */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {Object.entries(status.recipients ?? {}).map(([channel, emails]) => (
                    <div key={channel} className="rounded-lg border border-(--color-card-surface-border) dark:border-white/10 p-2.5">
                        <p className="text-xs font-aumovio-bold text-grey-500 dark:text-white/50">{CHANNEL_LABELS[channel] ?? channel}</p>
                        <p className="text-xs font-mono text-black/70 dark:text-white/70 mt-1 break-all">{emails.length > 0 ? emails.join(", ") : "No recipients configured"}</p>
                    </div>
                ))}
            </div>

            {/* Recent sends mini-list */}
            {status.recentSends?.length > 0 && (
                <div>
                    <p className="text-xs font-aumovio-bold text-grey-500 dark:text-white/50 mb-1.5 uppercase tracking-wide">Recent Sends</p>
                    <ul className="space-y-1">
                        {status.recentSends.slice(0, 5).map((s, i) => (
                            <li key={s.notificationId ?? i} className="flex items-center gap-2 text-xs">
                                <span className={s.sent ? "text-success-400" : "text-danger-400"}>{s.sent ? "Sent" : "Failed"}</span>
                                <span className="font-mono text-grey-500 dark:text-white/50">{CHANNEL_LABELS[s.channel] ?? s.channel}</span>
                                <span className="text-black/70 dark:text-white/70 truncate">{s.headline}</span>
                                {s.at && <span className="ml-auto text-grey-400 dark:text-white/40">{new Date(s.at).toLocaleString()}</span>}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </Card>
    );
}
