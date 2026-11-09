/**
 * server-lock-redirect.spec.js — real-browser check of the server lock: when the API goes away the app locks
 * every control (theme toggle excepted), the banner counts down to the automatic redirect, the app
 * navigates in-app (SPA, `replace`) to the 523 page at "danger", and "Continue" returns the user to where
 * they were once the server is back.
 *
 * Every backend call is mocked with `page.route("**\/api/**")`; "the server goes away" = `route.abort()` on
 * every API call (incl. health/ready and health/stream). Time is driven by Playwright's clock
 * (`page.clock`), so the 60 s danger timer runs in milliseconds.
 *
 * The outage is detected by the app's own readiness watch (idle store polls health/ready every 10 s, or the
 * stream's failure fallback), so no user action is needed to "trigger a request". Exact second values depend
 * on WHEN detection happens, so the spec asserts the countdown's shape and its rate (≈30 s elapsed → ≈30 s
 * fewer), not an absolute number.
 *
 * CsrfGate (main.jsx) still hard-navigates to the 523 page for a boot-time outage, so the mock lets CSRF
 * init succeed before the outage starts.
 */
import { expect, test } from "@playwright/test";

const APP_ORIGIN = "http://localhost:5173";
const OUTAGE_PATH = "/service-is-currently-unavailable";
const PAGE_PATH = "/dashboard?tab=2";
const USER_ID = "100001";

const ok = (data = null) => ({ status: "success", code: 200, message: "OK", requestId: "e2e-req", data });

const buildUser = () => ({
    sub: USER_ID,
    userId: USER_ID,
    userLevel: 2,
    firstName: "E2E",
    lastName: "User",
    email: "e2e.user@example.com",
    role: "ADMIN",
    isDefaultPassword: false,
    requiresPasswordChange: false,
    permissions: {},
});

/** Mocks the API. `state.down` aborts everything; `state.readyUp` lets only health/ready answer 200 while down. */
async function mockApi(page, state) {
    await page.route("**/api/**", async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        if (url.origin === APP_ORIGIN) return route.continue(); // never a Vite module
        const cors = {
            "access-control-allow-origin": APP_ORIGIN,
            "access-control-allow-credentials": "true",
            "access-control-allow-headers": "content-type, x-client-username, x-csrf-token",
            "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
            "access-control-expose-headers": "retry-after, x-request-id",
        };
        const endpoint = url.pathname.replace(/^.*\/api\/v1\//, "");
        const reply = (status, body) => route.fulfill({ status, headers: cors, contentType: "application/json", body: JSON.stringify(body) });

        if (state.down) {
            if (endpoint === "health/ready" && state.readyUp) return reply(200, { status: "ready" });
            return route.abort("connectionrefused");
        }
        if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
        if (endpoint === "csrf/token" || endpoint === "csrf/refresh") return reply(200, { success: true, token: "e2e-csrf", expiresIn: 3_600_000 });
        if (endpoint === "csrf/status") return reply(200, { success: true, isValid: true });
        if (endpoint === "auth/me") return reply(200, ok(buildUser()));
        if (endpoint === "health/ready") return reply(200, { status: "ready" });
        return reply(200, ok([]));
    });
}

const secondsOf = async (page) => Number(await page.getByTestId("server-status-countdown").getAttribute("data-seconds"));

test("outage: lock + countdown → SPA redirect to 523 → Continue returns to the page", async ({ page }) => {
    test.setTimeout(90_000); // cold Vite dev server: first paint + lazy chunks alone can take ~20 s
    const state = { down: false, readyUp: false };
    await mockApi(page, state);
    await page.addInitScript(
        ({ userId }) => {
            if (sessionStorage.getItem("e2e.seeded")) return;
            sessionStorage.setItem("e2e.seeded", "1");
            localStorage.setItem("user_session", "1");
            localStorage.setItem("user_display", JSON.stringify({ firstName: "E2E", lastName: "User", userId }));
            // Top layout: the Navbar (with the Personalize button asserted below) renders in this mode.
            localStorage.setItem("aumovio-layout", "top");
        },
        { userId: USER_ID },
    );
    await page.clock.install({ time: new Date("2026-10-25T10:00:00Z") });

    await page.goto(PAGE_PATH);
    await expect(page).toHaveURL(`${APP_ORIGIN}${PAGE_PATH}`);
    await expect(page.getByTestId("server-status-banner")).toBeEmpty();
    await page.clock.pauseAt(new Date("2026-10-25T10:00:30Z"));

    // 1. The API disappears. The idle readiness watch notices within 10 s; the banner needs 3 s more.
    state.down = true;
    await page.clock.runFor(15_000);
    await expect(page.getByTestId("server-status-countdown")).toBeVisible();

    // 2. Locked: html switch set, controls inert, the theme toggle is not.
    await expect(page.locator("html")).toHaveAttribute("data-server-locked", "");
    await expect(page.getByRole("button", { name: "Personalize" })).toHaveAttribute("inert", "");
    await expect(page.getByRole("button", { name: /^(System|Light|Dark) theme$/ })).not.toHaveAttribute("inert", "");
    await expect(page.getByTestId("server-status-countdown")).toContainText(/Redirecting in\s*\d+\s*s/);

    // 3. The countdown follows the clock.
    const before = await secondsOf(page);
    await page.clock.runFor(20_000);
    const after = await secondsOf(page);
    expect(before - after).toBeGreaterThanOrEqual(19);
    expect(before - after).toBeLessThanOrEqual(21);

    // 4. Danger: red banner, no countdown, in-app redirect, no lock on the outage page.
    await page.clock.runFor(after * 1000 + 2_000);
    await expect(page).toHaveURL(new RegExp(`${OUTAGE_PATH}$`));
    await expect(page.getByTestId("server-status-countdown")).toHaveCount(0);
    await expect(page.locator("html")).not.toHaveAttribute("data-server-locked", "");

    // 5. The server comes back (only the readiness probe answers); the page offers Continue.
    state.readyUp = true;
    await page.clock.runFor(20_000);
    const cta = page.getByTestId("service-status-cta");
    await expect(cta).toContainText(/continue/i);

    // 6. Continue returns to the page the user was on (full navigation: let the API answer again).
    state.down = false;
    await page.clock.resume();
    await cta.click();
    await expect(page).toHaveURL(`${APP_ORIGIN}${PAGE_PATH}`);
});
