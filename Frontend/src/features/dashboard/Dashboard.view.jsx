/**
 * Dashboard.view.jsx — Authenticated landing page.
 *
 * Shows a personalised greeting and role-based feature shortcuts. Nav-derived
 * shortcuts come from the SAME single source of truth as the sidebar/navbar
 * (`nav.config.jsx` → NAV_GROUPS), so the dashboard can never drift out of sync
 * with the navigation a role actually has.
 *
 * A "Change Password" card (in-app /auth/change-password flow) is appended for
 * every role. Cards may also point at an external URL (`href` + `external`),
 * opened in a new tab with noopener.
 *
 * No placeholder "—" values — every card is a real, reachable destination.
 */

import { faArrowUpRightFromSquare, faRightFromBracket, faUserLock } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useNavigate } from "react-router-dom";
import { ANIMATE_ENTER_UP, ANIMATE_FADE_IN_UP, ANIM_DELAY_0, ANIM_DELAY_100, ANIM_DELAY_200, BASE_COLOR_BG, BASE_COLOR_TEXT, GRADIENT_COLOR_TEXT, HOVER_LIFT, STANDARD_BORDER, TITLE_COLOR_TEXT, TRANSITION_SPRING, staggerDelay } from "../../assets/styles/pre-set-styles";
import { ErrorBoundary } from "../../components/feedback/ErrorBoundary";
import { NAV_GROUPS } from "../../components/layout/config/nav.config";
import { Skeleton } from "../../components/ui/Skeleton";
import { useDashboard } from "./dashboard.hook";

const ROLE_LABELS = {
    SUPER_ADMIN: "Super Administrator",
    ADMIN: "Administrator",
    USER: "User",
};

// Map nav-group accent colours → dashboard card icon colour + tint, keeping the
// dashboard palette aligned with the sidebar group accents (60/30/10 rule).
// Palette-adaptive families (orange/purple/blue/turquoise/yellow) use the
// contrast-safe --*-foreground icon tokens (\u22653:1 on the card surface in both
// modes) instead of the raw -400 anchor, which was never contrast-checked and
// rendered dark/wrong on vivid palettes (e.g. Ruby Punch #ff466e). Semantic
// families (success/danger/warn/grey) stay on their fixed anchors by design.
const GROUP_COLOR = {
    orange: { color: "text-(--accent-icon)", bg: "bg-orange-400/10 dark:bg-orange-400/15" },
    purple: { color: "text-(--secondary-foreground)", bg: "bg-purple-400/10 dark:bg-purple-400/15" },
    blue: { color: "text-(--blue-foreground)", bg: "bg-blue-400/10 dark:bg-blue-400/15" },
    turquoise: { color: "text-(--turquoise-foreground)", bg: "bg-turquoise-400/10 dark:bg-turquoise-400/15" },
    yellow: { color: "text-(--yellow-foreground)", bg: "bg-yellow-400/10 dark:bg-yellow-400/15" },
    success: { color: "text-success-400", bg: "bg-success-400/10 dark:bg-success-400/15" },
    danger: { color: "text-danger-400", bg: "bg-danger-400/10 dark:bg-danger-400/15" },
    warn: { color: "text-warn-400", bg: "bg-warn-400/10 dark:bg-warn-400/15" },
    grey: { color: "text-grey-400", bg: "bg-grey-400/10 dark:bg-grey-400/15" },
};
const DEFAULT_GROUP_COLOR = GROUP_COLOR.grey;

/**
 * Convert a nav-config item into a dashboard card descriptor.
 * @param {{ name: string, href: string, description?: string, icon?: JSX.Element }} it - Nav item.
 * @param {string} groupColor - Nav group accent key (e.g. "orange").
 * @returns {{ icon: JSX.Element|null, label: string, desc: string, path: string, color: string, bg: string }}
 */
function navItemToCard(it, groupColor) {
    const palette = GROUP_COLOR[groupColor] ?? DEFAULT_GROUP_COLOR;
    return {
        icon: it.icon ?? null,
        label: it.name,
        desc: it.description || "Open this feature.",
        path: it.href,
        ...palette,
    };
}

/**
 * Build the ordered list of dashboard cards for a role.
 *
 * O(g·i) time, g = nav groups, i = items/group — bounded (< 40 total), runs once
 * per render on a tiny fixed dataset. O(n) space for the result array.
 *
 * @param {string} role - Authenticated user's role string (e.g. "ADMIN").
 * @returns {Array<object>} Card descriptors. `href`+`external` = new tab; `path` = SPA nav.
 * @example buildShortcuts("USER") // Reference + Support nav items, then Change Password
 */
function buildShortcuts(role) {
    const cards = [];
    const seen = new Set();

    for (const group of NAV_GROUPS[role] ?? []) {
        for (const it of group.items) {
            if (seen.has(it.href)) continue;
            seen.add(it.href);
            cards.push(navItemToCard(it, group.color));
        }
    }

    if (role) {
        cards.push({
            icon: faUserLock,
            label: "Change Password",
            desc: "Update your account password.",
            path: "/auth/change-password",
            ...GROUP_COLOR.purple,
        });
    }

    return cards;
}

function ShortcutCard({ item, index }) {
    const navigate = useNavigate();

    const handleActivate = () => {
        if (item.external && item.href) {
            // CWE-1022: reverse-tabnabbing guard — noopener,noreferrer on new tab.
            window.open(item.href, "_blank", "noopener,noreferrer");
            return;
        }
        if (item.path) navigate(item.path);
    };

    // Nav items carry a Lucide element (already sized); recovery/help cards carry
    // a FontAwesome icon definition. Render whichever is present.
    const isFontAwesome = item.icon && typeof item.icon === "object" && "iconName" in item.icon;

    return (
        <button
            type="button"
            onClick={handleActivate}
            className={`text-left w-full p-5 rounded-2xl ${BASE_COLOR_BG} ${STANDARD_BORDER} ${TRANSITION_SPRING} ${HOVER_LIFT} ${ANIMATE_ENTER_UP} ${staggerDelay(index)} flex items-start gap-4 focus:outline-none focus:ring-2 focus:ring-orange-400/40`}
        >
            <div className={`shrink-0 w-11 h-11 rounded-xl ${item.bg} flex items-center justify-center ${item.color}`}>
                {isFontAwesome ? <FontAwesomeIcon icon={item.icon} className="text-lg" /> : item.icon ? <span className="text-lg">{item.icon}</span> : null}
            </div>
            <div className="min-w-0">
                <p className={`font-semibold text-sm flex items-center gap-1.5 ${TITLE_COLOR_TEXT}`}>
                    {item.label}
                    {item.external && <FontAwesomeIcon icon={faArrowUpRightFromSquare} className={`text-[10px] ${BASE_COLOR_TEXT} opacity-50`} />}
                </p>
                <p className={`text-xs mt-1 ${BASE_COLOR_TEXT} opacity-70 line-clamp-2`}>{item.desc}</p>
            </div>
        </button>
    );
}

function DashboardContent() {
    const { user, loading } = useDashboard();
    const navigate = useNavigate();

    const role = user?.role ?? "";
    const firstName = user?.firstName ?? "";
    const lastName = user?.lastName ?? "";
    const fullName = [firstName, lastName].filter(Boolean).join(" ") || "there";

    const shortcuts = buildShortcuts(role);

    if (loading) {
        return (
            <div className="max-w-7xl mx-auto px-4 py-10 space-y-8">
                <div className="space-y-3">
                    <Skeleton className="h-9 w-64 rounded-lg" />
                    <Skeleton className="h-4 w-48 rounded-lg" />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {Array.from({ length: 6 }).map((_, i) => (
                        <Skeleton key={i} className="h-24 rounded-2xl" />
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div className="max-w-7xl mx-auto px-4 py-10 font-aumovio space-y-8">
            {/* Greeting */}
            <div className={`${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_0}`}>
                <h1 className={`text-3xl font-extrabold ${TITLE_COLOR_TEXT}`}>
                    Welcome back, <span className={GRADIENT_COLOR_TEXT}>{fullName}</span>
                </h1>
                <p className={`mt-1 text-sm ${BASE_COLOR_TEXT} opacity-75`}>{ROLE_LABELS[role] ?? role} · CATHERINE Template</p>
            </div>

            {/* Quick-access shortcuts */}
            <div className={`${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_100}`}>
                <h2 className={`text-base font-semibold mb-4 ${TITLE_COLOR_TEXT}`}>Quick Access</h2>
                {shortcuts.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                        {shortcuts.map((item, i) => (
                            <ShortcutCard key={item.path ?? item.href ?? item.label} item={item} index={i} />
                        ))}
                    </div>
                ) : (
                    <div className={`text-center py-12 rounded-2xl ${BASE_COLOR_BG} ${STANDARD_BORDER}`}>
                        <p className={`${BASE_COLOR_TEXT} opacity-60`}>No features are assigned to your role yet.</p>
                    </div>
                )}
            </div>

            {/* Sign-out shortcut */}
            <div className={`flex justify-end ${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_200}`}>
                <button onClick={() => navigate("/user/logout")} className={`flex items-center gap-2 text-sm ${BASE_COLOR_TEXT} opacity-50 hover:opacity-100 ${TRANSITION_SPRING}`}>
                    <FontAwesomeIcon icon={faRightFromBracket} />
                    Sign out
                </button>
            </div>
        </div>
    );
}

export default function Dashboard() {
    return (
        <ErrorBoundary>
            <DashboardContent />
        </ErrorBoundary>
    );
}
