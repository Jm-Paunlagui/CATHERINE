/**
 * routeViewStub.jsx — Marker component factory for App.jsx route-table tests.
 *
 * WHY THIS EXISTS
 *   src/App.jsx is nothing but a route table: a set of `lazy()` views, a stack
 *   of `<ProtectedRoute>` wrappers, and the chrome conditionals. The thing
 *   under test is "does path X resolve to view Y, behind gate Z" — the views
 *   themselves already have their own feature suites, and mounting the real
 *   ones would mean standing up the MSW surface of every feature in the app
 *   just to prove the router wired them up.
 *
 *   So the route-table tests mock each `*.view` module to a marker rendered by
 *   this factory. Everything that actually belongs to App.jsx stays REAL:
 *   the <Routes> tree, ProtectedRoute + AuthMiddleware.isAuth() over MSW,
 *   Suspense, the ErrorBoundary, and every chrome component.
 *
 *   Nothing here is ever asserted as "a mock was called" — the assertion is
 *   always that this marker's TEXT is in the document, i.e. that the router
 *   really rendered that route's element.
 *
 * The marker text is the module's own path so a failure names the module that
 * did (or did not) render, not an anonymous "stub".
 */

/**
 * @param {string} name module path fragment, e.g. "dashboard/Dashboard"
 * @returns {() => import('react').ReactElement} a component rendering `view:<name>`
 */
export function makeStubView(name) {
    function StubView() {
        return <div data-testid="route-view">{`view:${name}`}</div>;
    }
    StubView.displayName = `StubView(${name})`;
    return StubView;
}

export default makeStubView;
