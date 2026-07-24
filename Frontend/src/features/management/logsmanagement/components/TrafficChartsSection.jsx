/**
 * @fileoverview TrafficChartsSection — live view of how the backend handles request volume.
 *
 * Scope is deliberately narrow: request VOLUME and its response-class breakdown
 * over time. System/health metrics (CPU, memory, event-loop lag, apdex, GC) are
 * NOT shown here — they live in the "Live System Metrics" section below. This
 * avoids duplicating the metrics tabs and keeps the observability view focused.
 *
 * Data source: the SSE-pushed MetricsStore payload (OPTIONS already excluded by
 * MetricsMiddleware on the backend), surfaced by useLogsManagement as:
 *   - trafficSnapshot : latest { red, totals, rates }   (volume tiles + endpoint bars)
 *   - trafficSeries   : rolling per-tick deltas          (live stacked traffic bar)
 *
 * Pure presentational component — all data via props; never imports the hook/API.
 */

import { ANIMATE_ENTER_UP, HOVER_LIFT, TRANSITION_SPRING, staggerDelay } from "../../../../assets/styles/pre-set-styles";
import { AreaChart } from "../../../../components/charts/AreaChart";
import { BarChart } from "../../../../components/charts/BarChart";
import Card from "../../../../components/ui/Card";
import Skeleton from "../../../../components/ui/Skeleton";

/** Maximum endpoints rendered in the per-route bar charts. */
const MAX_ROUTES = 8;

/** Maximum characters of a shortened route label before truncation. */
const MAX_LABEL_LEN = 30;

/**
 * Response-class colours for the stacked traffic chart.
 * Hex values mirror the design-system brand anchors (see src/utils/tokens.js) —
 * ApexCharts options are plain JS and cannot consume CSS custom properties.
 */
const C = {
    success: "#32cb70", // success-400
    notModified: "#18a9e7", // blue-400 — 304 cache revalidation (not a real redirect)
    redirect: "#4827af", // purple-400 — real 301/302/307/308
    client: "#12caae", // turquoise-400 (light teal)
    server: "#ff4208", // orange-400
    blue: "#18a9e7", // blue-400
};

/**
 * Parse the HTTP method from a RED route label such as "GET /api/v1/health".
 * @param {string} label
 * @returns {string}
 */
function parseMethod(label) {
    return label.split(" ")[0] || "OTHER";
}

/**
 * Shorten a full route label for chart display.
 * @param {string} label
 * @returns {string}
 */
function shortenRoute(label) {
    return label.replace(/^[A-Z]+\s\/api\/v1\//, "").slice(0, MAX_LABEL_LEN) || label;
}

/** Format a count with thousands separators; "—" when nullish. */
function fmtNum(n) {
    return n == null ? "—" : Number(n).toLocaleString();
}

/**
 * A single compact volume tile.
 *
 * @param {object} props
 * @param {string} props.label
 * @param {string|number} props.value
 * @param {string} [props.accent] - Tailwind text-colour class for the value.
 * @param {number} [props.index]  - Stagger index for entrance animation.
 */
function VolumeTile({ label, value, accent = "text-black dark:text-white", index = 0 }) {
    return (
        <div className={`rounded-xl p-3.5 bg-(--bg-surface) dark:bg-(--bg-surface-2) border border-(--color-card-surface-border) dark:border-white/10 shadow-sm ${ANIMATE_ENTER_UP} ${staggerDelay(index)} ${TRANSITION_SPRING} ${HOVER_LIFT}`}>
            <p className="text-[11px] text-black/45 dark:text-white/40 font-aumovio mb-0.5 truncate">{label}</p>
            <p className={`text-[19px] font-aumovio-bold leading-tight ${accent}`}>{value}</p>
        </div>
    );
}

/**
 * Live traffic-volume view.
 *
 * @param {object} props
 * @param {{ red: object, totals: object, rates: object } | null} props.trafficSnapshot
 * @param {Array<{ label: string, success: number, redirect: number, client: number, server: number }>} [props.trafficSeries]
 * @returns {JSX.Element}
 */
export function TrafficChartsSection({ trafficSnapshot, trafficSeries = [] }) {
    if (!trafficSnapshot) {
        return (
            <div className="space-y-6">
                <Skeleton variant="rect" height="320px" />
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                    {Array.from({ length: 6 }).map((_, i) => (
                        <Skeleton key={i} variant="rect" height="76px" />
                    ))}
                </div>
            </div>
        );
    }

    const { red = {}, totals = {}, rates = {} } = trafficSnapshot;

    // ── Traffic stacked bar (rolling deltas over time) ──────────────────────────
    const trafficLabels = trafficSeries.map((b) => b.label);
    // Only render series that actually have volume — keeps the legend honest and
    // avoids an empty "Redirect" band when all 3xx are really 304 cache hits.
    const hasNotModified = trafficSeries.some((b) => b.notModified > 0);
    const hasRedirect = trafficSeries.some((b) => b.redirect > 0);
    const hasClient = trafficSeries.some((b) => b.client > 0);
    const hasServer = trafficSeries.some((b) => b.server > 0);
    const trafficStack = [
        { name: "Success (2xx)", data: trafficSeries.map((b) => b.success) },
        ...(hasNotModified ? [{ name: "Not Modified (304)", data: trafficSeries.map((b) => b.notModified) }] : []),
        ...(hasRedirect ? [{ name: "Redirect (3xx)", data: trafficSeries.map((b) => b.redirect) }] : []),
        ...(hasClient ? [{ name: "Client Error (4xx)", data: trafficSeries.map((b) => b.client) }] : []),
        ...(hasServer ? [{ name: "Server Error (5xx)", data: trafficSeries.map((b) => b.server) }] : []),
    ];
    const trafficColors = [
        C.success,
        ...(hasNotModified ? [C.notModified] : []),
        ...(hasRedirect ? [C.redirect] : []),
        ...(hasClient ? [C.client] : []),
        ...(hasServer ? [C.server] : []),
    ];

    // ── Volume tiles (request counts + live rate — NO system/health metrics) ────
    const tiles = [
        { label: "Total Requests", value: fmtNum(totals.requestsTotal), accent: "text-(--blue-foreground)" },
        { label: "Req Rate", value: `${(rates.reqPerSec ?? 0).toFixed(2)}/s`, accent: "text-black dark:text-white" },
        { label: "Success (2xx)", value: fmtNum(totals.successTotal), accent: "text-success-400" },
        { label: "Not Modified (304)", value: fmtNum(totals.notModifiedTotal), accent: "text-(--blue-foreground)" },
        { label: "Redirect (3xx)", value: fmtNum(totals.redirectsTotal), accent: "text-(--secondary-foreground)" },
        { label: "Client Error (4xx)", value: fmtNum(totals.clientErrorsTotal), accent: "text-(--turquoise-foreground)" },
        { label: "Server Error (5xx)", value: fmtNum(totals.serverErrorsTotal), accent: "text-(--accent-foreground)" },
    ];

    // ── Endpoint bars (knows our endpoints) ─────────────────────────────────────
    const routes = Object.entries(red);
    const topRoutes = [...routes].sort((a, b) => b[1].count - a[1].count).slice(0, MAX_ROUTES);
    const routeLabels = topRoutes.map(([r]) => shortenRoute(r));
    const routeCounts = topRoutes.map(([, m]) => m.count);
    const routeP95 = topRoutes.map(([, m]) => m.p95);
    const hasRoutes = topRoutes.length > 0;

    // Method breakdown (informational sub-line under the traffic chart)
    const methodMap = {};
    for (const [r, m] of routes) {
        const meth = parseMethod(r);
        methodMap[meth] = (methodMap[meth] || 0) + m.count;
    }
    const methodSummary = Object.entries(methodMap)
        .sort((a, b) => b[1] - a[1])
        .map(([m, n]) => `${m} ${fmtNum(n)}`)
        .join("  ·  ");

    return (
        <div className="space-y-6">
            {/* Traffic stacked bar — request volume over time by response class */}
            <Card padding="md">
                {trafficSeries.length > 0 ? (
                    <AreaChart title="Traffic" series={trafficStack} categories={trafficLabels} colors={trafficColors} height={320} stacked />
                ) : (
                    <div className="h-80 flex flex-col items-center justify-center gap-1 text-sm text-black/40 dark:text-white/35">
                        <span>Waiting for live traffic…</span>
                        <span className="text-xs">Bars appear as requests arrive (one bar per 5s tick).</span>
                    </div>
                )}
                {methodSummary && <p className="mt-2 text-[11px] font-mono text-black/40 dark:text-white/35 text-center">{methodSummary}</p>}
            </Card>

            {/* Volume tiles */}
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
                {tiles.map((t, i) => (
                    <VolumeTile key={t.label} label={t.label} value={t.value} accent={t.accent} index={i} />
                ))}
            </div>

            {/* Endpoint bars */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                <Card padding="md">
                    {hasRoutes ? (
                        <BarChart title="Top Endpoints by Traffic" series={[{ name: "Requests", data: routeCounts }]} categories={routeLabels} colors={[C.blue]} height={300} horizontal />
                    ) : (
                        <div className="h-75 flex items-center justify-center text-sm text-black/40 dark:text-white/35">No traffic recorded yet.</div>
                    )}
                </Card>
                <Card padding="md">
                    {hasRoutes ? (
                        <BarChart title="P95 Latency by Endpoint (ms)" series={[{ name: "P95 ms", data: routeP95 }]} categories={routeLabels} colors={[C.server]} height={300} horizontal />
                    ) : (
                        <div className="h-75 flex items-center justify-center text-sm text-black/40 dark:text-white/35">No latency samples yet.</div>
                    )}
                </Card>
            </div>
        </div>
    );
}

export default TrafficChartsSection;
