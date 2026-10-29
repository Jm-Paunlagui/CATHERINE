/**
 * ServiceStatusPanel — Tier-1 status card for the 523 "Service Unavailable" page.
 *
 * WHAT THIS FILE DOES
 *   Renders the one-glance answer to "is it back yet?": a stripe-coloured card (icon, title, body)
 *   plus, while probing, a cadence line ("Last checked 14:03:22 · Attempt 3 · Next check in 8 s", or
 *   "… · Checking now…" once the probe is due) and a thin bar toward the next check: ONE linear CSS
 *   animation per probe round (svc-next-check, duration = the gap, negative delay = time already
 *   elapsed), so it fills continuously. Props only: it never imports the hook or the API;
 *   `ServiceUnavailable` (ClientErrorResponses.jsx) owns `useServiceRecovery` and hands `status` + `meta`.
 *
 *   All text comes from `serviceStatus.copy.js` (frozen, never server text). Colours are design
 *   tokens with light/dark parity (the --status-* / --accent vars flip with the theme). Motion uses the
 *   Aumovio animation presets and stops under prefers-reduced-motion (`motion-reduce:*!`).
 *
 *   The cadence line sits OUTSIDE any live region (the page owns one polite region) so the ticking
 *   countdown is never announced.
 *
 * Complexity: O(1) per render; one timer, aligned to the due time's whole seconds, only while a
 * cadence line is visible and the probe is not yet due.
 */

import { useEffect, useState } from "react";
import { ArrowPathIcon, CheckCircleIcon, CircleStackIcon, ExclamationTriangleIcon, SignalSlashIcon, WifiIcon } from "@heroicons/react/24/outline";
import { ANIMATE_BOUNCE_IN, ANIMATE_GRADIENT, ANIMATE_SPIN_SLOW, TRANSITION_COLORS } from "../../../assets/styles/pre-set-styles";
import { SERVICE_CADENCE_COPY, SERVICE_STATUS_COPY, SERVICE_STATUS_TEST_IDS, formatClock, formatDownFor } from "../serviceStatus.copy";

const NO_MOTION = "motion-reduce:animate-none!";

// Complete class strings (never built dynamically) so Tailwind's scanner sees every one.
const CARD = {
    checking: { stripe: "border-l-(--accent)", title: "text-(--accent-foreground)", Icon: ArrowPathIcon, iconClass: `text-(--accent-icon) ${ANIMATE_SPIN_SLOW} ${NO_MOTION}` },
    restarting: { stripe: "border-l-(--accent)", title: "text-(--accent-foreground)", Icon: ArrowPathIcon, iconClass: `text-(--accent-icon) ${ANIMATE_SPIN_SLOW} ${NO_MOTION}` },
    unavailable: { stripe: "border-l-(--status-warning-base)", title: "text-(--status-warning-text)", Icon: SignalSlashIcon, iconClass: "text-(--status-warning-text)" },
    database: { stripe: "border-l-(--status-warning-base)", title: "text-(--status-warning-text)", Icon: CircleStackIcon, iconClass: "text-(--status-warning-text)" },
    offline: { stripe: "border-l-(--status-warning-base)", title: "text-(--status-warning-text)", Icon: WifiIcon, iconClass: "text-(--status-warning-text)" },
    danger: { stripe: "border-l-(--status-danger-base)", title: "text-(--status-danger-text)", Icon: ExclamationTriangleIcon, iconClass: "text-(--status-danger-text)" },
    // danger because the DATABASE has been down 60 s+: same stripe/title tokens, database glyph
    databaseDanger: { stripe: "border-l-(--status-danger-base)", title: "text-(--status-danger-text)", Icon: CircleStackIcon, iconClass: "text-(--status-danger-text)" },
    available: { stripe: "border-l-(--status-success-base)", title: "text-(--status-success-text)", Icon: CheckCircleIcon, iconClass: `text-(--status-success-text) ${ANIMATE_BOUNCE_IN} ${NO_MOTION} motion-reduce:transform-none!` },
};

/**
 * @param {object} props
 * @param {"checking"|"unavailable"|"database"|"restarting"|"danger"|"offline"|"available"} props.status
 * @param {"server"|"database"|null} [props.cause] Who is down; with `status="danger"` it picks the database copy.
 * @param {{ attempt:number, lastProbeAt:number, nextProbeAt:number, firstAt:number, recoveredAt:number }} props.meta
 * @returns {import("react").ReactElement}
 */
export function ServiceStatusPanel({ status, meta, cause = null }) {
    const key = status === "danger" && cause === "database" ? "databaseDanger" : status;
    const card = CARD[key] ?? CARD.checking;
    const copy = SERVICE_STATUS_COPY[key] ?? SERVICE_STATUS_COPY.checking;
    const available = status === "available";
    const showMeta = status === "unavailable" || status === "database" || status === "restarting" || status === "danger" || status === "offline";
    const showBar = status === "checking" || status === "unavailable" || status === "database" || status === "restarting";
    const { Icon } = card;

    // Countdown clock, only while a cadence line is on screen. It ticks on the whole-second boundaries
    // of the due time (a plain 1 s interval started at mount shows doubled / skipped numbers) and stops
    // once the probe is due: the next meta change re-arms it.
    const [now, setNow] = useState(() => Date.now());
    const { nextProbeAt } = meta;
    useEffect(() => {
        if (!showMeta) return undefined;
        let id;
        const delayFrom = (t) => {
            const left = nextProbeAt - t;
            return left > 0 ? left % 1000 || 1000 : null;
        };
        const tick = () => {
            const t = Date.now();
            setNow(t);
            const d = delayFrom(t);
            if (d !== null) id = setTimeout(tick, d);
        };
        const first = delayFrom(Date.now());
        id = setTimeout(tick, first ?? 0);
        return () => clearTimeout(id);
    }, [showMeta, nextProbeAt]);

    const title = available ? copy.cardTitle(formatClock(meta.recoveredAt || now)) : copy.cardTitle;
    const body = available ? copy.cardBody(formatDownFor(meta.recoveredAt - meta.firstAt)) : copy.cardBody;

    const hasProbe = meta.lastProbeAt > 0;
    // `now` can trail a just-settled probe by < 1 s; never count from before the probe settled.
    const at = Math.max(now, meta.lastProbeAt);
    const inFlight = hasProbe && at >= meta.nextProbeAt;
    const secondsLeft = Math.max(1, Math.ceil((meta.nextProbeAt - at) / 1000));
    const span = Math.max(1, meta.nextProbeAt - meta.lastProbeAt);
    // Fixed per round (keyed by lastProbeAt below) so the 1 s re-renders never re-time the animation.
    const [round, setRound] = useState(() => ({ key: meta.lastProbeAt, offset: Math.max(0, at - meta.lastProbeAt) }));
    if (round.key !== meta.lastProbeAt) setRound({ key: meta.lastProbeAt, offset: Math.max(0, at - meta.lastProbeAt) });
    const offset = round.key === meta.lastProbeAt ? round.offset : 0;
    // Reduced-motion fallback (the animation is off): a static fill at the real fraction, stepped per tick.
    const fraction = Math.min(1, Math.max(0, (at - meta.lastProbeAt) / span));
    const cadence = inFlight ? SERVICE_CADENCE_COPY.lineChecking({ time: formatClock(meta.lastProbeAt), attempt: meta.attempt }) : SERVICE_CADENCE_COPY.line({ time: formatClock(meta.lastProbeAt), attempt: meta.attempt, seconds: secondsLeft });

    return (
        <div data-testid={SERVICE_STATUS_TEST_IDS.panel} data-service-status={status} className={`p-4 mt-4 text-sm text-left border border-l-4 rounded-xl border-(--color-card-surface-border) bg-white/60 dark:bg-white/5 font-aumovio ${card.stripe} ${TRANSITION_COLORS}`}>
            <div className="flex items-start gap-3">
                <Icon className={`w-5 h-5 mt-0.5 shrink-0 ${card.iconClass}`} aria-hidden="true" />
                <div>
                    <p className={`font-aumovio-bold ${card.title}`}>{title}</p>
                    <p className="mt-1 text-grey-600 dark:text-grey-400">{body}</p>
                </div>
            </div>

            {showMeta && (
                <p data-testid={SERVICE_STATUS_TEST_IDS.check} aria-live="off" className="mt-3 text-xs text-grey-600 dark:text-grey-400">
                    {hasProbe ? cadence : SERVICE_CADENCE_COPY.waiting}
                </p>
            )}

            {showBar &&
                (hasProbe && status !== "checking" && !inFlight ? (
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-grey-200 dark:bg-(--bg-surface-3)" aria-hidden="true">
                        <div
                            key={meta.lastProbeAt}
                            data-cadence-fill
                            className="h-full origin-left rounded-full bg-linear-to-r from-orange-400 to-purple-400 motion-reduce:animate-none!"
                            style={{
                                transform: `scaleX(${Math.round(fraction * 1000) / 1000})`,
                                animationName: "svc-next-check",
                                animationDuration: `${span}ms`,
                                animationDelay: `-${offset}ms`,
                                animationTimingFunction: "linear",
                                animationFillMode: "both",
                            }}
                        />
                    </div>
                ) : (
                    <div className="mt-3 h-1 overflow-hidden rounded-full bg-(--accent-subtle)" aria-hidden="true">
                        <div className={`h-full w-full rounded-full bg-linear-to-r from-(--color-gradient-from) to-(--color-gradient-to) ${ANIMATE_GRADIENT} ${NO_MOTION}`} />
                    </div>
                ))}
        </div>
    );
}

export default ServiceStatusPanel;
