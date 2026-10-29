/**
 * ServerStatusBanner — Global, always-mounted API reachability banner.
 *
 * Mounted once in App.jsx above the navbar so it shows on every route
 * (including /auth). The live region is ALWAYS in the DOM so screen readers
 * announce text the moment it appears. Text comes only from fixed constants in
 * `useServerStatus` — never a server message, URL, stack or request id.
 * Not dismissible: it clears itself on recovery. Colours come from `Banner`'s
 * variants, which already carry light and dark treatments; `tone="status"` adds the dark soft
 * treatment and the palette hairline. Restarting is the palette-aware "info" fill
 * (the server restarting is expected, not a fault); unavailable / danger / recovered keep the
 * semantic amber / red / green.
 *
 * On the 523 page (`ERROR_PAGE_ROUTES[523]`) the banner is visible but SILENT (`aria-live="off"`, no
 * `role="status"`): that page owns the one polite live region, so nothing is announced twice. Full width (`contained={false}`):
 * the text starts at the page's left edge, aligned with the navbar logo.
 *
 * Motion (Aumovio animation presets only):
 *   - enter: the row height grows 0 -> auto (grid rows + `@starting-style`, --duration-moderate,
 *     decelerate) while the content fades in, so the page slides down instead of jumping;
 *   - exit: the last state stays mounted ("latched") for SERVER_BANNER_EXIT_MS while the row
 *     collapses and the content fades out, then the region empties (a timer, not transitionend,
 *     so reduced motion and tests behave the same);
 *   - state change: colours ease (TRANSITION_COLORS); the text swaps in ONE node (no crossfade:
 *     the atomic live region announces each message once);
 *   - icon: slow spin while restarting (progress indicator), pulse while retrying capped at
 *     3 cycles (WCAG 2.2.2), still in danger, one bounce on recovery;
 *   - prefers-reduced-motion: every movement off via `motion-reduce:*!` (the `!` is needed because
 *     the preset classes are unlayered CSS); only the colour change remains.
 */

import { useEffect, useState } from "react";
import { useInRouterContext, useLocation } from "react-router-dom";
import { ArrowPathIcon, CheckCircleIcon, SignalSlashIcon } from "@heroicons/react/24/outline";
import { ANIMATE_BOUNCE_IN, ANIMATE_FADE_IN, ANIMATE_FADE_OUT, ANIMATE_PULSE, ANIMATE_SPIN_SLOW, TRANSITION_COLORS } from "../../../assets/styles/pre-set-styles";
import { ERROR_PAGE_ROUTES } from "../../../constants/httpStatus";
import Banner from "../../ui/Banner";
import { SERVER_BANNER_EXIT_MS, useServerStatus } from "./useServerStatus";

const ICONS = { restarting: ArrowPathIcon, unavailable: SignalSlashIcon, recovered: CheckCircleIcon };
const NO_MOTION = "motion-reduce:animate-none!";
// The pulse is capped at 3 cycles (~4.5 s, WCAG 2.2.2 five-second limit); the spinner is a progress
// indicator for the restart and keeps turning until the state changes.
const ICON_MOTION = { restarting: ANIMATE_SPIN_SLOW, unavailable: `${ANIMATE_PULSE} [animation-iteration-count:3]!`, recovered: ANIMATE_BOUNCE_IN };
const OUTAGE_ROUTE = ERROR_PAGE_ROUTES[523];
const HAIRLINE_FLOW = "after:animate-gradient motion-reduce:after:animate-none!";
const COLLAPSE_BASE = "grid transition-[grid-template-rows] duration-(--duration-moderate) motion-reduce:transition-none!";
const COLLAPSE_OPEN = `${COLLAPSE_BASE} grid-rows-[1fr] starting:grid-rows-[0fr] ease-(--ease-decelerate)`;
const COLLAPSE_CLOSED = `${COLLAPSE_BASE} grid-rows-[0fr] ease-(--ease-accelerate)`;

/**
 * The router-aware wrapper: `useLocation` throws outside a Router, so it lives in its own tiny component
 * that is only rendered when `useInRouterContext()` says there is one (the app always has one; isolated
 * renders do not). Public router API only.
 */
function RouteAwareBanner() {
    const { pathname } = useLocation();
    return <BannerBody silent={pathname === OUTAGE_ROUTE || pathname.startsWith(`${OUTAGE_ROUTE}/`)} />;
}

/** @returns {import("react").ReactElement} */
export function ServerStatusBanner() {
    return useInRouterContext() ? <RouteAwareBanner /> : <BannerBody silent={false} />;
}

/** @param {{ silent: boolean }} props `silent`: visible but not announced (the 523 page owns the live region). */
function BannerBody({ silent }) {
    const { phase, severity, visible, message } = useServerStatus();
    const current = { phase, severity, message };
    // Last visible payload and the "latched" exit payload, adjusted during render (React's
    // supported pattern for state derived from a changing input; no refs written in render).
    const [prev, setPrev] = useState({ visible: false, payload: null });
    const [latched, setLatched] = useState(null);
    const changed = !prev.payload || prev.payload.phase !== phase || prev.payload.severity !== severity || prev.payload.message !== message;
    if (visible && (!prev.visible || changed)) setPrev({ visible: true, payload: current });
    if (!visible && prev.visible) {
        setPrev({ visible: false, payload: null });
        setLatched(prev.payload);
    }
    if (visible && latched) setLatched(null); // re-entry during the exit cancels it

    useEffect(() => {
        if (!latched) return undefined;
        const t = setTimeout(() => setLatched(null), SERVER_BANNER_EXIT_MS);
        return () => clearTimeout(t);
    }, [latched]);

    const shown = visible ? current : latched;
    const exiting = !visible && !!latched;
    // Restarting is expected, not a fault: the palette-aware "info" fill. Every other state keeps its semantic colour.
    const variant = shown && (shown.phase === "restarting" && shown.severity !== "danger" ? "info" : shown.severity);
    const Icon = shown && (shown.severity === "danger" ? SignalSlashIcon : ICONS[shown.phase]);
    const iconMotion = shown && shown.severity !== "danger" && ICON_MOTION[shown.phase] ? `${ICON_MOTION[shown.phase]} ${NO_MOTION}` : "";

    return (
        <div data-testid="server-status-banner" role={silent ? undefined : "status"} aria-live={silent ? "off" : "polite"} aria-atomic="true">
            {shown && (
                <div data-part="collapse" className={exiting ? COLLAPSE_CLOSED : COLLAPSE_OPEN}>
                    <div data-part="clip" className={`min-h-0 overflow-hidden ${exiting ? ANIMATE_FADE_OUT : ANIMATE_FADE_IN} ${NO_MOTION}`}>
                        <Banner sticky contained={false} dismissible={false} tone="status" variant={variant} icon={Icon} className={`${TRANSITION_COLORS} ${shown.phase === "restarting" ? HAIRLINE_FLOW : ""}`.trim()} iconClassName={iconMotion}>
                            {shown.message}
                        </Banner>
                    </div>
                </div>
            )}
        </div>
    );
}

export default ServerStatusBanner;
