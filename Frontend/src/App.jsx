/**
 * App.jsx — Router only.
 *
 * - ROLES defined here (string keys matching the JWT role payload)
 * - NO AREAS constant — permission strings defined inline at each route
 * - No providers — those live in main.jsx
 * - Lazy views with Suspense fallback
 * - Supports "top" (navbar) and "sidebar" layout modes via LayoutContext
 */

import { Suspense, lazy, useEffect, useRef } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import "./assets/styles/index.css";

import { ErrorBoundary } from "./components/feedback/ErrorBoundary";
import SessionWarningModal from "./components/feedback/SessionWarningModal";
import Footer from "./components/layout/Footer";
import Navbar from "./components/layout/Navbar";
import Sidebar from "./components/layout/Sidebar";
import SidebarHeader from "./components/layout/SidebarHeader";
import ProtectedRoute from "./components/routing/ProtectedRoute";
import { HelpAssistant } from "./components/shared/HelpAssistant";
import { ServerStatusBanner, ServerStatusWatch } from "./components/shared/serverStatus";
import Breadcrumb from "./components/ui/Breadcrumb";
import { useLayout } from "./contexts/layout/LayoutContext";
import { useScrollportHeightVar } from "./hooks/useScrollportHeightVar";
import { BadRequest, InvalidToken, LoginTimeOut, PageNotFound, ServiceUnavailable, SignatureMismatch, TooManyRequests, Unauthorized } from "./views/errors/ClientErrorResponses";

const LoginView = lazy(() => import("./features/auth/Login.view"));
const LogoutView = lazy(() => import("./features/auth/Logout.view"));
const ChangePasswordView = lazy(() => import("./features/auth/ChangePassword.view"));
const DashboardView = lazy(() => import("./features/dashboard/Dashboard.view"));
const HomeView = lazy(() => import("./features/home/Home.view"));

// About — reference pages
const GettingStartedView = lazy(() => import("./features/other/gettingstarted/GettingStarted.view"));
const DatabaseConnectionView = lazy(() => import("./features/other/databaseconnection/DatabaseConnection.view"));
const MiraOrmView = lazy(() => import("./features/other/miraorm/MiraOrm.view"));
const MoneyView = lazy(() => import("./features/other/money/Money.view"));
const CORSSetupView = lazy(() => import("./features/other/corssetup/CORSSetup.view"));

// System Admin
const AdminManagementView = lazy(() => import("./features/systemadmin/adminmanagement/AdminManagement.view"));
const LogsManagementView = lazy(() => import("./features/systemadmin/logsmanagement/LogsManagement.view"));
const DataIntegrityView = lazy(() => import("./features/systemadmin/integrity/IntegrityCenter.view"));
const DataPurgeView = lazy(() => import("./features/systemadmin/datapurge/DataPurge.view"));

// Support
const ChangelogView = lazy(() => import("./features/support/changelog/Changelog.view"));
const HelpView = lazy(() => import("./features/support/help/Help.view"));
// Lazy by necessity: react-markdown, a highlighter and (on first diagram) ~1 MB of mermaid.
const DevDocsView = lazy(() => import("./features/support/devdocs/DevDocs.view"));
// Lazy: a ~170 KB map payload and a large SVG that only Super Admins can open.
const ArchitectureView = lazy(() => import("./features/support/architecture/Architecture.view"));
const RuntimeView = lazy(() => import("./features/support/runtime/Runtime.view"));

// Role constants — must match the strings stored in T_ADMINS_DEV.ROLE
// and returned in the JWT payload as user.role.
const ROLES = {
    SADMIN: "SUPER_ADMIN",
    ADMIN: "ADMIN",
    USER: "USER",
};

const ALL_ROLES = [ROLES.USER, ROLES.ADMIN, ROLES.SADMIN];

// Routes that render with NO app chrome — no navbar, no sidebar, no breadcrumb,
// no footer. Every full-page error screen belongs here: wrapping a "the server
// is napping" page in a navbar whose links all lead to the same dead server is
// worse than no chrome at all.
const BARE_ROUTES = ["/auth", "/", "/user/logout", "/unauthorized", "/login-timeout", "/invalid-token", "/bad-request", "/page-not-found", "/too-many-requests", "/service-is-currently-unavailable", "/signature-mismatch", "/auth/change-password"];

function isBareRoute(pathname) {
    return BARE_ROUTES.some((r) => pathname === r || pathname.startsWith(r + "/"));
}

// Routes that render the top navbar ONLY, whatever the saved layout preference.
// Empty in the template — add a public page here that must not show the role-gated sidebar.
const NAVBAR_ONLY_ROUTES = [];

function isNavbarOnlyRoute(pathname) {
    return NAVBAR_ONLY_ROUTES.some((r) => pathname === r || pathname.startsWith(r + "/"));
}

function ConditionalNavbar() {
    const { pathname } = useLocation();
    const { layout } = useLayout();
    if (isBareRoute(pathname)) return null;
    if (isNavbarOnlyRoute(pathname)) return <Navbar />;
    if (layout === "sidebar") return null; // sidebar mode uses Sidebar.jsx instead
    return <Navbar />;
}

function ConditionalSidebar() {
    const { pathname } = useLocation();
    const { layout } = useLayout();
    if (isBareRoute(pathname)) return null;
    if (isNavbarOnlyRoute(pathname)) return null;
    if (layout !== "sidebar") return null;
    return <Sidebar />;
}

function ConditionalSidebarHeader() {
    const { pathname } = useLocation();
    const { layout } = useLayout();
    if (isBareRoute(pathname)) return null;
    if (isNavbarOnlyRoute(pathname)) return null;
    if (layout !== "sidebar") return null;
    return <SidebarHeader />;
}

// Per-segment crumb overrides (segment → label). Hoisted: Breadcrumb memoises on it.
const BREADCRUMB_LABELS = {};

function ConditionalBreadcrumb() {
    const { pathname } = useLocation();
    if (isBareRoute(pathname)) return null;
    if (isNavbarOnlyRoute(pathname)) return null;
    // Breadcrumb handles its own visibility per layout mode:
    // sidebar → hidden on lg+ (shown on tablet/mobile with sidebar toggle)
    // topbar  → always visible
    return <Breadcrumb auto homeIcon separator="chevron" size="md" variant="bar" labels={BREADCRUMB_LABELS} />;
}

function ConditionalFooter() {
    const { pathname } = useLocation();
    const { layout } = useLayout();
    if (isBareRoute(pathname)) return null;
    if (isNavbarOnlyRoute(pathname)) return null;
    if (layout === "sidebar") return null; // sidebar mode omits footer
    return <Footer />;
}

// Scroll the content area back to the top on every route change so navigating
// (e.g. a "Where to Go Next" link) lands at the top of the destination page.
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
            <div className="w-8 h-8 border-4 border-(--accent-foreground) rounded-full animate-spin border-t-transparent" />
        </div>
    );
}

function AppContent() {
    const { pathname } = useLocation();
    const { layout } = useLayout();
    const bare = isBareRoute(pathname);
    const scrollRef = useRef(null);
    useScrollportHeightVar(scrollRef);
    // Every route with app chrome uses the FIXED-HEIGHT shell, in both layout modes.
    // `#app-main-scroll` must be a real scrollport (bounded height) or every sticky
    // rail (Version History, Help, Dev Docs, DocShell) scrolls away under the top bar.
    // Only BARE routes (auth screens, error takeovers) keep min-h-screen.
    const fixedShell = layout === "sidebar" || !bare;

    return (
        <div className={`flex flex-col bg-(--bg-surface) transition-colors duration-300 ${fixedShell ? "h-screen overflow-hidden" : "min-h-screen"}`}>
            <ScrollToTop />
            {/* ── Global API reachability banner (every route, incl. auth) ── */}
            <ServerStatusBanner />
            {/* Keeps the banner told without user action: readiness push stream, poll fallback */}
            <ServerStatusWatch />

            {/* ── Full-width top bars (header + breadcrumb) ── */}
            <ConditionalNavbar />
            <ConditionalSidebarHeader />
            <ConditionalBreadcrumb />

            {/* ── Below the top bars: sidebar + main content side-by-side ── */}
            <div className="relative flex flex-1 overflow-hidden">
                <ConditionalSidebar />
                <div ref={scrollRef} id="app-main-scroll" className="flex flex-col flex-1 min-w-0 overflow-y-auto transition-all duration-300">
                    <main className="grow">
                        {/* Route-level boundary, OUTSIDE Suspense on purpose: a lazy() chunk
                            that fails to download rejects before the view's own boundary
                            exists. Keyed on pathname so navigating away clears the error. */}
                        <ErrorBoundary key={pathname}>
                            <Suspense fallback={<PageLoader />}>
                                <AppRoutes />
                            </Suspense>
                        </ErrorBoundary>
                    </main>
                    <ConditionalFooter />
                </div>
            </div>
            {!bare && <SessionWarningModal />}

            {/* Global Help Assistant — mounted unconditionally (no `bare` guard)
                so the searchable help launcher is reachable on EVERY route,
                including the unauthenticated /auth screen. It resolves the
                user's role lazily on first open to gate role-scoped articles;
                on /auth it resolves to tier 0 (general articles only). */}
            <HelpAssistant />
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
            <Route path="about/money" element={<MoneyView />} />
            <Route path="about/cors-setup" element={<CORSSetupView />} />
            {/* Version History — public. The view falls back to GET /changelog/public
                when the authenticated read 401s; every mutation stays SUPER_ADMIN-only
                and server-enforced. */}
            <Route path="about/changelog" element={<ChangelogView />} />
            {/* Help Center — public: unauthenticated visitors see general categories,
                authenticated users see up to their role tier. */}
            <Route path="about/help" element={<HelpView />} />

            {/* Change password — every authenticated role.
                Listed in BARE_ROUTES so no navbar/sidebar renders during this flow. */}
            <Route element={<ProtectedRoute role={ALL_ROLES} />}>
                <Route path="auth/change-password" element={<ChangePasswordView />} />
            </Route>

            {/* Dashboard — landing for every authenticated role. */}
            <Route element={<ProtectedRoute role={ALL_ROLES} />}>
                <Route path="dashboard" element={<DashboardView />} />
            </Route>

            {/* System — SUPER_ADMIN only */}
            <Route element={<ProtectedRoute role={[ROLES.SADMIN]} />}>
                <Route path="system/admin-management" element={<AdminManagementView />} />
                <Route path="system/logging-and-observability" element={<LogsManagementView />} />
                <Route path="system/data-integrity" element={<DataIntegrityView />} />
                <Route path="system/data-purge" element={<DataPurgeView />} />
            </Route>

            {/* Developer documentation — ADMIN + SUPER_ADMIN. Convenience guard only;
                the control is server-side on every /dev-docs endpoint. */}
            <Route element={<ProtectedRoute role={[ROLES.ADMIN, ROLES.SADMIN]} />}>
                <Route path="support/dev-docs" element={<DevDocsView />} />
            </Route>

            {/* System maps (Architecture, Runtime) — SUPER_ADMIN only. Convenience guard;
                the control is requireSuperAdmin on GET /api/v1/architecture[/runtime]. */}
            <Route element={<ProtectedRoute role={[ROLES.SADMIN]} />}>
                <Route path="support/architecture" element={<ArchitectureView />} />
                <Route path="support/runtime" element={<RuntimeView />} />
            </Route>

            {/* Error pages */}
            <Route path="unauthorized" element={<Unauthorized />} />
            <Route path="bad-request" element={<BadRequest />} />
            <Route path="login-timeout" element={<LoginTimeOut />} />
            <Route path="invalid-token" element={<InvalidToken />} />
            <Route path="page-not-found" element={<PageNotFound />} />
            <Route path="too-many-requests" element={<TooManyRequests />} />
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
