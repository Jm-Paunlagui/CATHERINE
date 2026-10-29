/**
 * @fileoverview Badge for backup archive chain mode — FULL / INCR gen N / CHAIN BROKEN.
 *
 * Uses only valid Badge variants (`green`, `orange`, `red`) — an invalid
 * variant name silently falls back to grey (`V[variant] ?? V.grey` in Badge.jsx).
 *
 * Tier 1 component — used only by BackupPanel within this feature.
 *
 * @param {object} props
 * @param {"FULL"|"INCREMENTAL"} props.mode - Archive storage mode.
 * @param {{ baseArchiveId: string, generation: number }|null} props.chain - Chain metadata (null for FULL).
 * @param {boolean} [props.chainBroken=false] - True when verify detected a broken chain member.
 */

import Badge from "../../../../components/ui/Badge";

export function BackupChainBadge({ mode, chain, chainBroken = false }) {
    if (chainBroken) {
        return (
            <Badge variant="red" size="sm" pill>
                CHAIN BROKEN
            </Badge>
        );
    }

    if (mode === "INCREMENTAL" && chain) {
        return (
            <Badge variant="orange" size="sm" pill>
                INCR gen {chain.generation}
            </Badge>
        );
    }

    return (
        <Badge variant="green" size="sm" pill>
            FULL
        </Badge>
    );
}

export default BackupChainBadge;
