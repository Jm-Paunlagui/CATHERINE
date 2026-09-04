/**
 * renderWithProviders.jsx — the canonical render helper.
 *
 * Reproduces the REAL provider chain from `src/main.jsx`:
 *
 *   Router → ThemeProvider → CsrfProvider → LayoutProvider → VersionProvider
 *
 * ⚠ That is the chain main.jsx RENDERS. Its own header comment says
 * "BrowserRouter → CsrfProvider → LayoutProvider → VersionProvider → App" and
 * omits ThemeProvider — the comment is stale, the JSX is the contract. Anything
 * calling `useTheme()` would explode under the commented chain.
 *
 * Two deliberate substitutions:
 *   • `MemoryRouter` for `BrowserRouter` — jsdom has no navigable history, and
 *     `initialEntries` is how a test lands a component on the route it is
 *     actually rendered at.
 *   • `<ToastContainer>` mounted exactly as `App.jsx` mounts it, so a test that
 *     asserts on a toast has somewhere for the toast to land.
 *
 * `CsrfGate` (main.jsx's boot gate) is deliberately NOT reproduced. It only
 * blocks first paint until `csrf/token` resolves, and the default MSW handler
 * resolves that instantly — reproducing it would add an await to every single
 * render for no assertion. Its own branching (429 → throttled screen, anything
 * else → outage screen) is boot-path behaviour that belongs to a reliability
 * suite, not to every component test.
 *
 * All user interaction goes through `@testing-library/user-event`, never
 * `fireEvent`.
 */

import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ToastContainer } from "react-toastify";

import { LayoutProvider } from "../../src/contexts/layout/LayoutContext.jsx";
import { CsrfProvider } from "../../src/contexts/security/CsrfContext.jsx";
import { ThemeProvider } from "../../src/contexts/theme/ThemeContext.jsx";
import { VersionProvider } from "../../src/contexts/version/VersionContext.jsx";

/**
 * jsdom implements no `window.matchMedia` at all — not a stub, not a throwing
 * stub, nothing. `ThemeProvider` calls it in a `useState` initialiser
 * (`getSystemTheme()`) and subscribes to its "change" event, so WITHOUT this
 * shim every render through this helper dies with
 * `TypeError: window.matchMedia is not a function` before the component under
 * test ever mounts.
 *
 * It lives here rather than in `test/helpers/setup.js` because this is the only
 * module that mounts `ThemeProvider`: the gap belongs to whoever opens it. If a
 * future suite needs OS-theme switching it should install its own richer
 * double — this one is deliberately inert.
 *
 * `matches: false` = "the OS is in light mode", which makes the resolved theme
 * deterministic across machines. A test asserting dark-mode CLASSES does not
 * need dark mode to be active; the classes are in the markup either way.
 */
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
    window.matchMedia = (query) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        // Deprecated MediaQueryList API — present because a library in the tree
        // may still call it, and a missing method here is a crash, not a warning.
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
    });
}

/**
 * localStorage key `LayoutContext` persists the shell mode under. Set BEFORE
 * render — `LayoutProvider` reads it in a `useState` lazy initialiser, so a
 * write after mount is invisible for the life of that tree.
 */
const LAYOUT_KEY = "aumovio-layout";

/**
 * Render `ui` inside the full app provider chain.
 *
 * @param {import('react').ReactElement} ui Element under test.
 * @param {object} [options]
 * @param {string} [options.route="/"] Path the tree is rendered at. Shorthand
 *        for a single-entry history; `initialEntries` wins when both are given.
 * @param {string[]} [options.initialEntries] Full MemoryRouter history stack,
 *        for tests that assert on back-navigation.
 * @param {"top"|"sidebar"} [options.layout] Shell mode. Written to
 *        `localStorage["aumovio-layout"]` before mount; omit to let
 *        `LayoutContext` fall back to `VITE_LAYOUT_MODE` (then `"sidebar"`).
 * @param {boolean} [options.withVersion=true] Mount `VersionProvider`. Set
 *        false for tests that must assert ZERO changelog traffic — the
 *        provider fetches `changelog` once per mount to resolve the version
 *        badge.
 * @param {boolean} [options.withToasts=true] Mount `<ToastContainer>`.
 * @returns {import('@testing-library/react').RenderResult}
 *
 * @example
 * renderWithProviders(<TooManyRequests />, { route: "/too-many-requests" });
 * @example
 * renderWithProviders(<Shell />, { layout: "top", withVersion: false });
 */
export function renderWithProviders(ui, { route = "/", initialEntries, layout, withVersion = true, withToasts = true, ...renderOptions } = {}) {
    if (layout === "top" || layout === "sidebar") {
        try {
            localStorage.setItem(LAYOUT_KEY, layout);
        } catch {
            /* private-mode jsdom shim — LayoutContext falls back to the env default */
        }
    }

    const entries = initialEntries ?? [route];

    function Wrapper({ children }) {
        const versioned = withVersion ? <VersionProvider>{children}</VersionProvider> : children;
        return (
            <MemoryRouter initialEntries={entries}>
                <ThemeProvider>
                    <CsrfProvider>
                        <LayoutProvider>
                            {versioned}
                            {withToasts && <ToastContainer position="bottom-right" autoClose={5000} hideProgressBar={false} closeOnClick pauseOnHover draggable theme="colored" className="z-50" />}
                        </LayoutProvider>
                    </CsrfProvider>
                </ThemeProvider>
            </MemoryRouter>
        );
    }

    return render(ui, { wrapper: Wrapper, ...renderOptions });
}

export default renderWithProviders;
