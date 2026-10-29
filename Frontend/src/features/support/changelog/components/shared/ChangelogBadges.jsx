/**
 * ChangelogBadges.jsx — the two version badges shared across the Version
 * History feature (entry rows, the Release Control header).
 *
 * Components only — the metadata and date helpers they sit next to live in
 * changelogMeta.js so neither file mixes component and constant exports
 * (react-refresh/only-export-components).
 */

import Badge from "../../../../../components/ui/Badge";
import { STAGE_META, parseStageFromVersion } from "../../../../../config/appVersion";

/** @param {{ version: string }} props */
export function VersionBadge({ version }) {
    return <span className="inline-flex items-center px-2 py-1 rounded text-xs font-mono font-semibold text-(--accent-foreground) bg-orange-100/25 dark:bg-orange-400/15 border border-orange-400/30 dark:border-orange-400/25">v{version}</span>;
}

/**
 * Release-stage badge for a changelog entry. The stage is inferred from the
 * version's semver pre-release tag (e.g. "1.2.0-beta.1" → Beta); a plain version
 * with no tag is a final release and shown as "Stable".
 *
 * @param {{ version: string }} props
 */
export function StageBadge({ version }) {
    const meta = STAGE_META[parseStageFromVersion(version) ?? "stable"];
    return (
        <Badge variant={meta.variant} size="xs" dot={meta.dot} pill>
            {meta.label}
        </Badge>
    );
}
