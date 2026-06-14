/**
 * Dashboard.view.jsx — Authenticated landing page.
 *
 * Shows a personalised greeting and feature shortcuts based on the
 * authenticated user's role. No placeholder "—" values — all content
 * is either real data from the auth cache or intentional navigation.
 */

import { faArrowTrendUp, faBuildingColumns, faCalendarDays, faChartBar, faCreditCard, faIdCard, faRightFromBracket, faUserShield, faUsers } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useNavigate } from "react-router-dom";
import { ANIMATE_ENTER_UP, ANIMATE_FADE_IN_UP, ANIM_DELAY_0, ANIM_DELAY_100, ANIM_DELAY_200, BASE_COLOR_BG, BASE_COLOR_TEXT, GRADIENT_COLOR_TEXT, HOVER_LIFT, STANDARD_BORDER, TITLE_COLOR_TEXT, TRANSITION_SPRING, staggerDelay } from "../../assets/styles/pre-set-styles";
import { ErrorBoundary } from "../../components/feedback/ErrorBoundary";
import { Skeleton } from "../../components/ui/Skeleton";
import { useDashboard } from "./dashboard.hook";

const ROLE_LABELS = {
    SUPER_ADMIN: "Super Administrator",
    ADMIN: "Administrator",
    USER: "Employee",
    APPROVER: "Approver",
    VIEWER: "Viewer",
    ROBOT: "Automation Account",
};

const ALL_SHORTCUTS = [
    {
        icon: faUsers,
        label: "Admin Management",
        desc: "Create and manage administrator accounts.",
        path: "/system/admin-management",
        roles: ["SUPER_ADMIN"],
        color: "text-danger-400",
        bg: "bg-danger-400/10 dark:bg-danger-400/15",
    },
    {
        icon: faChartBar,
        label: "Logging & Observability",
        desc: "View system activity and audit logs.",
        path: "/system/logging-and-observability",
        roles: ["SUPER_ADMIN"],
        color: "text-grey-400",
        bg: "bg-grey-400/10 dark:bg-grey-400/15",
    },
    {
        icon: faArrowTrendUp,
        label: "Version History",
        desc: "View the system's version history and changelog.",
        path: "/about/changelog",
        roles: ["SUPER_ADMIN"],
        color: "text-blue-400",
        bg: "bg-blue-400/10 dark:bg-blue-400/15",
    },
    {
        icon: faUserShield,
        label: "Change Password",
        desc: "Update your account password.",
        path: "/auth/change-password",
        roles: ["USER", "ADMIN", "SUPER_ADMIN", "APPROVER", "VIEWER", "ROBOT"],
        color: "text-(--accent-icon)",
        bg: "bg-orange-400/10 dark:bg-orange-400/15",
    },
];

function ShortcutCard({ item, index }) {
    const navigate = useNavigate();
    return (
        <button onClick={() => navigate(item.path)} className={`text-left w-full p-5 rounded-2xl ${BASE_COLOR_BG} ${STANDARD_BORDER} ${TRANSITION_SPRING} ${HOVER_LIFT} ${ANIMATE_ENTER_UP} ${staggerDelay(index)} flex items-start gap-4 focus:outline-none focus:ring-2 focus:ring-orange-400/40`}>
            <div className={`shrink-0 w-11 h-11 rounded-xl ${item.bg} flex items-center justify-center`}>
                <FontAwesomeIcon icon={item.icon} className={`text-lg ${item.color}`} />
            </div>
            <div className="min-w-0">
                <p className={`font-semibold text-sm ${TITLE_COLOR_TEXT}`}>{item.label}</p>
                <p className={`text-xs mt-0.5 ${BASE_COLOR_TEXT} opacity-70 line-clamp-2`}>{item.desc}</p>
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

    const shortcuts = ALL_SHORTCUTS.filter((s) => s.roles.includes(role));

    if (loading) {
        return (
            <div className="max-w-7xl mx-auto px-4 py-10 space-y-8">
                <div className="space-y-3">
                    <Skeleton className="h-9 w-64 rounded-lg" />
                    <Skeleton className="h-4 w-48 rounded-lg" />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
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
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                        {shortcuts.map((item, i) => (
                            <ShortcutCard key={item.path} item={item} index={i} />
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
