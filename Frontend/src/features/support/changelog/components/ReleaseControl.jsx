/**
 * ReleaseControl.jsx — release-train control card (SUPER_ADMIN only).
 *
 * Shows the in-flight target, a ladder progress strip, and the stage
 * transitions (Promote / Cut / Open). Each button does NOT write directly — it
 * opens the create form pre-filled with the backend-supplied draft, which the
 * admin reviews and saves (single write path).
 */

import { faArrowUp, faCodeMerge, faFlagCheckered } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

import Button from "../../../../components/ui/Button";

import { ANIMATE_FADE_IN_UP, ANIMATE_PULSE_SCALE, ANIM_DELAY_100, BASE_COLOR_BG, BASE_COLOR_TEXT, STANDARD_BORDER } from "../../../../assets/styles/pre-set-styles";
import { STAGE_META } from "../../../../config/appVersion";

import { StageBadge, VersionBadge } from "./shared/ChangelogBadges";

const RELEASE_LADDER = ["dev", "alpha", "beta", "rc", "stable"];
const BUMP_OPTIONS = [
    { bump: "patch", label: "Patch" },
    { bump: "minor", label: "Minor" },
    { bump: "major", label: "Major" },
];

/**
 * @param {{ hook: object }} props
 */
export function ReleaseControl({ hook }) {
    if (!hook.isSuperAdmin) return null;

    const rs = hook.releaseState;
    const drafts = rs?.drafts;
    const stage = rs?.stage ?? null;
    const curIdx = stage ? RELEASE_LADDER.indexOf(stage) : -1;
    const nextStage = curIdx >= 0 && curIdx < RELEASE_LADDER.length - 2 ? RELEASE_LADDER[curIdx + 1] : null;

    return (
        <div className={`rounded-2xl ${BASE_COLOR_BG} ${STANDARD_BORDER} p-5 ${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_100}`}>
            {/* Header row */}
            <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                    <FontAwesomeIcon icon={faCodeMerge} className="w-4 h-4 text-(--accent-icon)" />
                    <span className={`text-sm font-semibold ${BASE_COLOR_TEXT}`}>Release Control</span>
                </div>
                {rs?.hasTarget ? (
                    <div className="flex items-center gap-2">
                        <VersionBadge version={rs.version} />
                        <StageBadge version={rs.version} />
                    </div>
                ) : (
                    <span className={`text-xs ${BASE_COLOR_TEXT} opacity-50`}>No release in flight</span>
                )}
            </div>

            {/* Ladder progress */}
            {rs?.hasTarget && (
                <div className="mt-4 flex items-center">
                    {RELEASE_LADDER.map((s, i) => {
                        const reached = i <= curIdx;
                        const isCurrent = i === curIdx;
                        return (
                            <div key={s} className={`flex items-center ${i < RELEASE_LADDER.length - 1 ? "flex-1" : ""}`}>
                                <div className="flex flex-col items-center gap-1">
                                    <span className={`w-2.5 h-2.5 rounded-full ${reached ? "bg-(--accent-icon)" : "bg-grey-300 dark:bg-white/15"} ${isCurrent ? ANIMATE_PULSE_SCALE : ""}`} />
                                    <span className={`text-[10px] uppercase tracking-wide ${isCurrent ? `font-semibold ${BASE_COLOR_TEXT}` : `${BASE_COLOR_TEXT} opacity-40`}`}>{STAGE_META[s].short || "GA"}</span>
                                </div>
                                {i < RELEASE_LADDER.length - 1 && <div className={`h-px flex-1 mx-1.5 mb-4 ${i < curIdx ? "bg-(--accent-icon)" : "bg-grey-200 dark:bg-white/10"}`} />}
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Actions — each opens the pre-filled create form (no direct write) */}
            <div className="mt-4 flex flex-wrap items-center gap-2">
                {drafts?.promote && nextStage && (
                    <Button variant="primary" size="sm" onClick={() => hook.openReleaseDraft(drafts.promote)}>
                        <FontAwesomeIcon icon={faArrowUp} className="w-3.5 h-3.5 mr-1.5" />
                        Promote to {STAGE_META[nextStage].label}
                    </Button>
                )}
                {drafts?.cut && (
                    <Button variant="accent" size="sm" onClick={() => hook.openReleaseDraft(drafts.cut)}>
                        <FontAwesomeIcon icon={faFlagCheckered} className="w-3.5 h-3.5 mr-1.5" />
                        Cut {rs.core} to Stable
                    </Button>
                )}
                {drafts?.open && (
                    <>
                        <span className={`text-xs ${BASE_COLOR_TEXT} opacity-55`}>Open next cycle:</span>
                        {BUMP_OPTIONS.map((b) => (
                            <Button key={b.bump} variant="ghost" size="sm" onClick={() => hook.openReleaseDraft(drafts.open[b.bump])}>
                                {b.label}
                            </Button>
                        ))}
                    </>
                )}
            </div>

            {/* Hint */}
            <p className={`mt-3 text-xs ${BASE_COLOR_TEXT} opacity-45`}>
                {!rs?.hasTarget || stage === "stable" ? "No cycle in flight — open one to start logging changes. Every action opens an entry you review before it’s written." : stage === "rc" ? "Release candidate — review and cut to stable when ready. A new fix is just a new entry at rc." : "Promote when this stage is ready. Each action opens a pre-filled entry you review before saving."}
            </p>
        </div>
    );
}

export default ReleaseControl;
