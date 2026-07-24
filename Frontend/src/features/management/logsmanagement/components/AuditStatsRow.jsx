import { faArrowRightArrowLeft, faBug, faCircleCheck, faCircleXmark, faServer, faShield, faStopwatch, faTriangleExclamation, faUsers } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ANIMATE_ENTER_UP, HOVER_LIFT, staggerDelay, TRANSITION_SPRING } from "../../../../assets/styles/pre-set-styles";
import Alert from "../../../../components/ui/Alert";
import { Skeleton } from "../../../../components/ui/Skeleton";

// ─── Design token colour map (mirrors MetricCards.jsx) ───────────────────────

const COLOR = {
    orange: {
        icon: "text-(--accent-icon)",
        badge: "bg-orange-400/10 border-orange-400/20 dark:bg-orange-400/5 dark:border-orange-400/15",
        value: "text-(--accent-foreground)",
    },
    purple: {
        icon: "text-(--secondary-foreground)",
        badge: "bg-purple-400/10 border-purple-400/20 dark:bg-purple-400/5 dark:border-purple-400/15",
        value: "text-(--secondary-foreground)",
    },
    green: {
        icon: "text-success-400",
        badge: "bg-success-400/10 border-success-400/20 dark:bg-success-400/5 dark:border-success-400/15",
        value: "text-success-400",
    },
    blue: {
        icon: "text-(--blue-foreground)",
        badge: "bg-blue-400/10 border-blue-400/20 dark:bg-blue-400/5 dark:border-blue-400/15",
        value: "text-(--blue-foreground)",
    },
    amber: {
        icon: "text-warn-400",
        badge: "bg-warn-400/10 border-warn-400/20 dark:bg-warn-400/5 dark:border-warn-400/15",
        value: "text-warn-400",
    },
    red: {
        icon: "text-danger-400",
        badge: "bg-danger-400/10 border-danger-400/20 dark:bg-danger-400/5 dark:border-danger-400/15",
        value: "text-danger-400",
    },
};

// ─── Primary stat definitions ─────────────────────────────────────────────────

const PRIMARY_STATS = [
    { key: "total", label: "Total Requests", icon: faServer, colorKey: "orange" },
    { key: "success", label: "Success (2xx)", icon: faCircleCheck, colorKey: "green" },
    { key: "redirect", label: "Redirect (3xx)", icon: faArrowRightArrowLeft, colorKey: "blue" },
    { key: "clientError", label: "Client Error (4xx)", icon: faTriangleExclamation, colorKey: "amber" },
    { key: "serverError", label: "Server Error (5xx)", icon: faCircleXmark, colorKey: "red" },
];

// ─── Supplemental stat definitions ───────────────────────────────────────────

const SUPPLEMENTAL_STATS = [
    { key: "uniqueUsers", label: "Unique Users", icon: faUsers, colorKey: "purple", format: (v) => v },
    { key: "avgResponseTime", label: "Avg Response Time", icon: faStopwatch, colorKey: "blue", format: (v) => `${v} ms` },
    { key: "successRate", label: "Availability", icon: faShield, colorKey: "green", format: (v) => `${v}%` },
    { key: "clientErrorRate", label: "Client Error Rate (4xx)", icon: faTriangleExclamation, colorKey: "amber", format: (v) => `${v}%` },
    { key: "serverErrorRate", label: "Server Error Rate (5xx)", icon: faBug, colorKey: "red", format: (v) => `${v}%` },
];

// Keys that represent a percentage ratio — default to "0.0" instead of 0 when absent.
const RATE_KEYS = ["successRate", "clientErrorRate", "serverErrorRate"];

// ─── Sub-components ───────────────────────────────────────────────────────────

/**
 * Single audit metric card — matches the Consumption view MetricCard layout.
 *
 * @param {object}  props
 * @param {object}  props.icon       - FontAwesome icon definition
 * @param {string}  props.label      - Card label text
 * @param {string}  props.value      - Formatted value string
 * @param {string}  props.colorKey   - Key into the COLOR map
 * @param {number}  props.staggerIdx - Index for stagger animation delay
 * @param {boolean} props.loading    - When true renders a skeleton
 */
function AuditMetricCard({ icon, label, value, colorKey, staggerIdx, loading }) {
    const c = COLOR[colorKey] ?? COLOR.orange;

    return (
        <div className={`rounded-xl p-4 bg-(--bg-surface) dark:bg-(--bg-surface-2) border border-(--color-card-surface-border) dark:border-white/10 shadow-sm flex items-start gap-3 ${ANIMATE_ENTER_UP} ${staggerDelay(staggerIdx)} ${TRANSITION_SPRING} ${HOVER_LIFT}`}>
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border ${c.badge}`}>
                <FontAwesomeIcon icon={icon} className={`text-sm ${c.icon}`} />
            </div>
            <div className="flex-1 min-w-0">
                <p className="text-[11px] text-grey-400 dark:text-white/40 font-aumovio mb-0.5 truncate">{label}</p>
                {loading ? <Skeleton variant="text" lines={1} /> : <p className={`text-[19px] font-aumovio-bold leading-tight ${c.value}`}>{value}</p>}
            </div>
        </div>
    );
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Renders the audit statistics summary row with primary and supplemental metric cards.
 *
 * @param {{ hook: object }} props
 */
export default function AuditStatsRow({ hook }) {
    const { statsData, statsLoading, statsError, statsErrorMessage } = hook;
    const stats = statsData?.data ?? {};

    return (
        <div className="space-y-2.5">
            {/* A stats fetch failure must not fall through
                to every card's zero/default fallback — that is
                indistinguishable from a genuinely quiet audit window. */}
            {statsError && !statsLoading && (
                <Alert variant="danger" title="Failed to load audit statistics">
                    {statsErrorMessage}
                </Alert>
            )}

            {/* Primary stat cards — 5 across */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2.5">
                {PRIMARY_STATS.map((stat, i) => (
                    <AuditMetricCard key={stat.key} icon={stat.icon} label={stat.label} value={String(stats[stat.key] ?? 0)} colorKey={stat.colorKey} staggerIdx={i} loading={statsLoading} />
                ))}
            </div>

            {/* Supplemental stat cards — 5 across (mirrors the primary row) */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2.5">
                {SUPPLEMENTAL_STATS.map((stat, i) => {
                    const raw = stats[stat.key] ?? (RATE_KEYS.includes(stat.key) ? "0.0" : 0);
                    return <AuditMetricCard key={stat.key} icon={stat.icon} label={stat.label} value={stat.format(raw)} colorKey={stat.colorKey} staggerIdx={PRIMARY_STATS.length + i} loading={statsLoading} />;
                })}
            </div>
        </div>
    );
}
