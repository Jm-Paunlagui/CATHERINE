/**
 * App.jsx — Router only.
 *
 * - ROLES defined here (numeric, universal)
 * - NO AREAS constant — permission strings defined inline at each route
 * - No providers — those live in main.jsx
 * - Lazy views with Suspense fallback
 * - Supports "top" (navbar) and "sidebar" layout modes via LayoutContext
 */

import { Component, Suspense, lazy, useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import "./assets/styles/index.css";

import SessionWarningModal from "./components/feedback/SessionWarningModal";
import Footer from "./components/layout/Footer";
import Navbar from "./components/layout/Navbar";
import Sidebar from "./components/layout/Sidebar";
import SidebarHeader from "./components/layout/SidebarHeader";
import ProtectedRoute from "./components/routing/ProtectedRoute";
import Breadcrumb from "./components/ui/Breadcrumb";
import Button from "./components/ui/Button";
import { useLayout } from "./contexts/layout/LayoutContext";
import { BadRequest, InvalidToken, LoginTimeOut, PageNotFound, ServiceUnavailable, SignatureMismatch, Unauthorized } from "./views/errors/ClientErrorResponses";

const LoginView = lazy(() => import("./features/auth/Login.view"));
const LogoutView = lazy(() => import("./features/auth/Logout.view"));
const ChangePasswordView = lazy(() => import("./features/auth/ChangePassword.view"));
const DashboardView = lazy(() => import("./features/dashboard/Dashboard.view"));

// Management
const LogsManagementView = lazy(() => import("./features/management/logsmanagement/LogsManagement.view"));
const AdminManagementView = lazy(() => import("./features/management/adminmanagement/AdminManagement.view"));

// Support
const ChangelogView = lazy(() => import("./features/support/changelog/Changelog.view"));
const GettingStartedView = lazy(() => import("./features/other/gettingstarted/GettingStarted.view"));
const DatabaseConnectionView = lazy(() => import("./features/other/databaseconnection/DatabaseConnection.view"));
const MiraOrmView = lazy(() => import("./features/other/miraorm/MiraOrm.view"));
const CORSSetupView = lazy(() => import("./features/other/corssetup/CORSSetup.view"));
const HomeView = lazy(() => import("./features/home/Home.view"));

// Role constants — must match the strings stored in T_ADMINS_DEV.ROLE
// and returned in the JWT payload as user.role.
// APPROVER and VIEWER are valid admin roles introduced in the Admin Management feature.
// ROBOT is an RPA/automation account for system integrations.
const ROLES = {
    SADMIN: "SUPER_ADMIN",
    ADMIN: "ADMIN",
    USER: "USER",
    APPROVER: "APPROVER",
    VIEWER: "VIEWER",
    ROBOT: "ROBOT",
};

// NOTE: /about/getting-started is intentionally NOT bare — it renders inside the
// normal app shell (sidebar + header + breadcrumb). Its own section navigation
// lives in the page as a right-hand "On this page" rail, like the Tailwind docs.
const BARE_ROUTES = ["/auth", "/", "/user/logout", "/unauthorized", "/login-timeout", "/invalid-token", "/bad-request", "/page-not-found", "/service-is-currently-unavailable", "/signature-mismatch", "/auth/change-password"];

function isBareRoute(pathname) {
    return BARE_ROUTES.some((r) => pathname === r || pathname.startsWith(r + "/"));
}

function ConditionalNavbar() {
    const { pathname } = useLocation();
    const { layout } = useLayout();
    if (isBareRoute(pathname)) return null;
    if (layout === "sidebar") return null; // sidebar mode uses Sidebar.jsx instead
    return <Navbar />;
}

function ConditionalSidebar() {
    const { pathname } = useLocation();
    const { layout } = useLayout();
    if (isBareRoute(pathname)) return null;
    if (layout !== "sidebar") return null;
    return <Sidebar />;
}

function ConditionalSidebarHeader() {
    const { pathname } = useLocation();
    const { layout } = useLayout();
    if (isBareRoute(pathname)) return null;
    if (layout !== "sidebar") return null;
    return <SidebarHeader />;
}

function ConditionalBreadcrumb() {
    const { pathname } = useLocation();
    if (isBareRoute(pathname)) return null;
    // Breadcrumb handles its own visibility per layout mode:
    // sidebar → hidden on lg+ (shown on tablet/mobile with sidebar toggle)
    // topbar  → always visible
    return <Breadcrumb auto homeIcon separator="chevron" size="md" variant="bar" />;
}

function ConditionalFooter() {
    const { pathname } = useLocation();
    const { layout } = useLayout();
    if (isBareRoute(pathname)) return null;
    if (layout === "sidebar") return null; // sidebar mode omits footer
    return <Footer />;
}

// Scroll the content area back to the top on every route change so navigating
// (e.g. a "Where to Go Next" link) lands at the top of the destination page.
// The scroll container differs by layout: sidebar mode = the inner content div
// (#app-main-scroll); top mode = the window. Scroll both — the other is a no-op.
function ScrollToTop() {
    const { pathname } = useLocation();
    useEffect(() => {
        document.getElementById("app-main-scroll")?.scrollTo({ top: 0, behavior: "smooth" });
        window.scrollTo({ top: 0, behavior: "smooth" });
    }, [pathname]);
    return null;
}

function PageLoader() {
    return (
        <div className="flex items-center justify-center min-h-screen">
            <div className="w-8 h-8 border-4 border-orange-400 rounded-full animate-spin border-t-transparent" />
        </div>
    );
}

// A stale-chunk failure happens when a lazy `import()` resolves to a JS/CSS
// filename that no longer exists on the server (a new IIS deploy rotated the
// hashed filenames after this tab already loaded index.html). The browser's
// module loader throws one of these messages — never a React-specific error.
const CHUNK_ERROR_PATTERN = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

// sessionStorage guard so a genuinely broken deploy (chunk missing even after
// reload) can't trap the tab in a reload loop — we only ever auto-reload once
// per tab session, then fall back to a manual "Reload" prompt.
const CHUNK_RELOAD_KEY = "chunk-reload";

// Catches errors thrown while committing a lazy route (both the
// removeChildFromContainer NotFoundError seen during a route transition and
// stale dynamic-import failures) so AppRoutes never unmounts to a blank page.
// Sits inside the Suspense boundary — only the route content is replaced by
// the fallback, the surrounding shell (Navbar/Sidebar/Footer) stays mounted.
class RouteErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, isChunkError: false };
        this.handleReload = this.handleReload.bind(this);
    }

    static getDerivedStateFromError(error) {
        return { hasError: true, isChunkError: CHUNK_ERROR_PATTERN.test(error?.message || "") };
    }

    componentDidMount() {
        // Reaching a clean mount means the current route committed without
        // throwing — clear the one-shot guard so the next stale-chunk deploy
        // can trigger an auto-reload again instead of staying suppressed forever.
        sessionStorage.removeItem(CHUNK_RELOAD_KEY);
    }

    componentDidCatch(error) {
        if (!CHUNK_ERROR_PATTERN.test(error?.message || "")) return;
        if (sessionStorage.getItem(CHUNK_RELOAD_KEY)) return; // already tried once this session — avoid a reload loop
        sessionStorage.setItem(CHUNK_RELOAD_KEY, "1");
        window.location.reload();
    }

    handleReload() {
        window.location.reload();
    }

    render() {
        if (!this.state.hasError) return this.props.children;

        return (
            <div className="flex flex-col items-center justify-center min-h-55 p-6 text-center gap-3">
                <p className="text-sm font-aumovio text-grey-500 dark:text-grey-400 max-w-xs">{this.state.isChunkError ? "A new version of this app is available. Reloading…" : "Something went wrong loading this page."}</p>
                <Button variant="primary" size="sm" onClick={this.handleReload}>
                    Reload
                </Button>
            </div>
        );
    }
}

function AppContent() {
    const { pathname } = useLocation();
    const { layout } = useLayout();
    const bare = isBareRoute(pathname);
    const isSidebar = layout === "sidebar";

    return (
        // Sidebar mode = bounded app-shell scroll (inner content area scrolls).
        // Top mode = normal document scroll (window scrolls under the sticky Navbar);
        // the inner overflow utilities are dropped so they don't trap `position: sticky`
        // (e.g. the Getting Started "On this page" rail) inside a non-scrolling box.
        <div className={`flex flex-col bg-(--bg-surface) transition-colors duration-300 ${isSidebar ? "h-screen overflow-hidden" : "min-h-screen"}`}>
            <ScrollToTop />
            {/* ── Full-width top bars (header + breadcrumb) ── */}
            <ConditionalNavbar />
            <ConditionalSidebarHeader />
            <ConditionalBreadcrumb />

            {/* ── Below the top bars: sidebar + main content side-by-side ── */}
            <div className={`relative flex flex-1 ${isSidebar ? "overflow-hidden" : ""}`}>
                <ConditionalSidebar />
                <div id="app-main-scroll" className={`flex flex-col flex-1 min-w-0 transition-all duration-300 ${isSidebar ? "overflow-y-auto" : ""}`}>
                    <main className="grow">
                        <Suspense fallback={<PageLoader />}>
                            <RouteErrorBoundary>
                                <AppRoutes />
                            </RouteErrorBoundary>
                        </Suspense>
                    </main>
                    <ConditionalFooter />
                </div>
            </div>
            {!bare && <SessionWarningModal />}
        </div>
    );
}

function AppRoutes() {
    return (
        <Routes>
            {/* Public */}
            <Route path="/" element={<Navigate to="/home" replace />} />
            <Route path="home" element={<HomeView />} />
            <Route path="auth" element={<LoginView />} />
            <Route path="user/logout" element={<LogoutView />} />
            <Route path="about/getting-started" element={<GettingStartedView />} />
            <Route path="about/database-connection" element={<DatabaseConnectionView />} />
            <Route path="about/mira-orm" element={<MiraOrmView />} />
            <Route path="about/cors-setup" element={<CORSSetupView />} />
            {/* Version History — public read-only (backend GET /changelog is unauthenticated) */}
            <Route path="about/changelog" element={<ChangelogView />} />

            {/* Change password — accessible to all valid roles including APPROVER/VIEWER/ROBOT.
                Listed in BARE_ROUTES so no navbar/sidebar renders during this flow. */}
            <Route element={<ProtectedRoute role={[ROLES.USER, ROLES.ADMIN, ROLES.SADMIN, ROLES.APPROVER, ROLES.VIEWER, ROLES.ROBOT]} />}>
                <Route path="auth/change-password" element={<ChangePasswordView />} />
            </Route>

            {/* Protected — role only */}
            <Route element={<ProtectedRoute role={[ROLES.USER, ROLES.ADMIN, ROLES.SADMIN]} />}>
                <Route path="dashboard" element={<DashboardView />} />
            </Route>

            {/* Management — Logs + Admin Management: SUPER_ADMIN only */}
            <Route element={<ProtectedRoute role={[ROLES.SADMIN]} />}>
                <Route path="system/logging-and-observability" element={<LogsManagementView />} />
                <Route path="system/admin-management" element={<AdminManagementView />} />
            </Route>

            {/* Error pages */}
            <Route path="unauthorized" element={<Unauthorized />} />
            <Route path="bad-request" element={<BadRequest />} />
            <Route path="login-timeout" element={<LoginTimeOut />} />
            <Route path="invalid-token" element={<InvalidToken />} />
            <Route path="page-not-found" element={<PageNotFound />} />
            <Route path="service-is-currently-unavailable" element={<ServiceUnavailable />} />
            <Route path="signature-mismatch" element={<SignatureMismatch />} />
            <Route path="*" element={<Navigate to="/page-not-found" replace />} />
        </Routes>
    );
}

export default function App() {
    return (
        <>
            <ToastContainer position="bottom-right" autoClose={5000} hideProgressBar={false} closeOnClick pauseOnHover draggable theme="colored" className="z-50" />
            <AppContent />
        </>
    );
}
