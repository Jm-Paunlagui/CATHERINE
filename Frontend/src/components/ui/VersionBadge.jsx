/**
 * VersionBadge — Shows the app version and its release-stage label.
 *
 * Used in the navbar/sidebar to advertise the running build (e.g. "v1.23.4 · Beta")
 * and in the Version History page per release entry. Pulls its defaults from the
 * central src/config/appVersion.js single source of truth, but every part is
 * overridable so it can render an arbitrary version/stage (e.g. a changelog row).
 *
 * Props:
 *   version     — version string (default: APP_VERSION). Rendered as "v<version>".
 *   stage       — stage id: 'dev'|'alpha'|'beta'|'rc'|'stable' (default: APP_STAGE).
 *   size        — Badge size: 'xs'|'sm'|'md' (default: 'xs').
 *   showVersion — render the version pill (default: true).
 *   showStage   — render the stage badge (default: true).
 *   hideStableStage — when true, the stage badge is omitted for stable builds
 *                     (keeps production chrome clean). Default: false.
 *   short       — use the compact stage label (e.g. "β", "RC") instead of the
 *                 full label. Handy for tight spaces (collapsed sidebar). Stable
 *                 has no short label, so it falls back to "Stable". Default: false.
 *   to          — when set, the whole badge becomes a <Link to={to}>.
 *   className   — extra classes on the wrapper.
 */

import { Link } from "react-router-dom";

import { APP_STAGE, APP_VERSION, STAGE_META } from "../../config/appVersion";
import { Badge } from "./Badge";

function VersionPill({ version, glass = false }) {
    return <span className={`inline-flex items-center px-1.5 py-0.5 rounded font-mono text-[11px] font-semibold ${glass ? "text-white/90 bg-white/15 border border-white/25 backdrop-blur-sm" : "text-(--text-secondary) bg-grey-100 dark:bg-(--bg-surface-3) border border-grey-200/70 dark:border-(--color-dark-muted)/30"}`}>v{version}</span>;
}

function GlassStageBadge({ meta, size, stageLabel }) {
    const sz = size === "xs" ? "text-[10px] px-1.5 py-0.5" : size === "sm" ? "text-xs px-2 py-0.5" : "text-sm px-2.5 py-1";
    return (
        <span className={`inline-flex items-center gap-1 rounded-full font-aumovio-bold ${sz} text-white/90 bg-white/15 border border-white/25 backdrop-blur-sm`}>
            {meta.dot && (
                <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full rounded-full bg-white/60 animate-ping" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-white" />
                </span>
            )}
            {stageLabel}
        </span>
    );
}

/**
 * @param {object} props
 * @param {boolean} [props.glass] — Use translucent white-on-glass style for gradient/coloured backgrounds.
 */
export function VersionBadge({ version = APP_VERSION, stage = APP_STAGE, size = "xs", showVersion = true, showStage = true, hideStableStage = false, short = false, glass = false, to, className = "" }) {
    const meta = STAGE_META[stage] ?? STAGE_META.stable;
    const renderStage = showStage && !(hideStableStage && meta.id === "stable");
    const stageLabel = short && meta.short ? meta.short : meta.label;

    const content = (
        <>
            {showVersion && <VersionPill version={version} glass={glass} />}
            {renderStage &&
                (glass ? (
                    <GlassStageBadge meta={meta} size={size} stageLabel={stageLabel} />
                ) : (
                    <Badge variant={meta.variant} size={size} dot={meta.dot} pill>
                        {stageLabel}
                    </Badge>
                ))}
        </>
    );

    const cls = `inline-flex items-center gap-1.5 ${className}`;

    if (to) {
        return (
            <Link to={to} className={`${cls} rounded-lg transition-opacity duration-150 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)/50 ${glass ? "focus-visible:ring-white/50!" : ""}`} title={`Version ${version} · ${meta.label} — view history`} aria-label={`Version ${version}, ${meta.label}. View version history`}>
                {content}
            </Link>
        );
    }

    return (
        <span className={cls} title={`Version ${version} · ${meta.label}`}>
            {content}
        </span>
    );
}

export default VersionBadge;
