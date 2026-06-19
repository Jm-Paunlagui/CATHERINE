/**
 * App.jsx — Router only.
 *
 * - ROLES defined here (numeric, universal)
 * - NO AREAS constant — permission strings defined inline at each route
 * - No providers — those live in main.jsx
 * - Lazy views with Suspense fallback
 * - Supports "top" (navbar) and "sidebar" layout modes via LayoutContext
 */

import { Suspense, lazy, useEffect } from "react";
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
import { useLayout } from "./contexts/layout/LayoutContext";
import { BadRequest, InvalidToken, LoginTimeOut, PageNotFound, ServiceUnavailable, SignatureMismatch, Unauthorized } from "./views/errors/ClientErrorResponses";

const LoginView = lazy(() => import("./features/auth/Login.view"));
const LogoutView = lazy(() => import("./features/auth/Logout.view"));
const ChangePasswordView = lazy(() => import("./features/auth/ChangePassword.view"));
const DashboardView = lazy(() => import("./features/dashboard/Dashboard.view"));

// Management
const LogsManagementView = lazy(() => import("./features/management/logsmanagement/LogsManagement.view"));
const AdminManagementView = lazy(() => import("./features/management/adminmanagement/AdminManagement.view"));

// Other
const ChangelogView = lazy(() => import("./features/other/changelog/Changelog.view"));
const GettingStartedView = lazy(() => import("./features/other/gettingstarted/GettingStarted.view"));
const DatabaseConnectionView = lazy(() => import("./features/other/databaseconnection/DatabaseConnection.view"));
const MiraOrmView = lazy(() => import("./features/other/miraorm/MiraOrm.view"));
const CORSSetupView = lazy(() => import("./features/other/corssetup/CORSSetup.view"));

// Role constants — must match the strings stored in T_EMP_MGMT_ADMIN.EMP_ROLE
// and returned in the JWT payload as user.role.
// APPROVER and VIEWER are valid admin roles introduced in the Admin Management feature.
// ROBOT is an RPA/automation account that accesses RFID Management and Subsidy Management Upload.
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
                            <AppRoutes />
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
            <Route path="/" element={<Navigate to="/about/getting-started" replace />} />
            <Route path="auth" element={<LoginView />} />
            <Route path="user/logout" element={<LogoutView />} />
            <Route path="about/getting-started" element={<GettingStartedView />} />
            <Route path="about/database-connection" element={<DatabaseConnectionView />} />
            <Route path="about/mira-orm" element={<MiraOrmView />} />
            <Route path="about/cors-setup" element={<CORSSetupView />} />
            {/* Version History — public read-only (backend GET /changelog is unauthenticated) */}
            <Route path="about/changelog" element={<ChangelogView />} />

            {/* Dashboard */}
            <Route path="dashboard" element={<DashboardView />} />

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
