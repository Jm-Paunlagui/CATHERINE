/**
 * smart-home.spec.js — real-browser simulation of the "return users to where they left off" flow.
 *
 * Every backend call is mocked with `page.route("**\/api/**")` — no real API is touched. The app's own
 * code paths run unmodified: HttpClient's takeover interceptor, CsrfGate's boot-time 429 branch,
 * ProtectedRoute (records the last location), the error pages and LoginView.
 *
 * Areas covered:
 *   1. 429 loop — "Try again" after the countdown returns to the ORIGINAL page, never reloads the 429 page.
 *   2. 6-case matrix (session valid|invalid x returnTo safe|absent|unsafe) on the 404 and 429 home links.
 *   3. A signed-in user opening /auth is sent back to their last page, else their role landing page;
 *      a signed-out visitor stays on /auth.
 *   4. 440 / 498 still end the session and lead to /auth (and the bounce-back is forgotten).
 *
 * State the app reads (see src/utils/lastLocation.js, src/utils/storage.js, AuthMiddleware):
 *   localStorage   user_session = "1", user_display = { userId, ... }   → "signed in" hint
 *   sessionStorage app.lastLocation = { path, userId }                   → recorded by ProtectedRoute
 *   sessionStorage app.errorPage.payload = { code, retryAfter, returnTo } → error-page hand-off
 * The session itself is verified by GET auth/me (mocked per test).
 */
import { expect, test } from "@playwright/test";

const APP_ORIGIN = "http://localhost:5173";
const USER_ID = "e2e.admin";
const LAST_LOCATION_KEY = "app.lastLocation";
const ERROR_PAYLOAD_KEY = "app.errorPage.payload";

// A protected page (ADMIN + SUPER_ADMIN) whose only data call is GET dev-docs/tree.
const PROTECTED_PAGE = "/support/dev-docs";
const PROTECTED_DATA = "dev-docs/tree";
const SAFE_RETURN = "/system/logging-and-observability?tab=metrics";
const UNSAFE_RETURN = "//evil.example/phish";
const PUBLIC_RETURN = "/about/help?topic=sessions";

function buildUser(role = "ADMIN") {
    return {
        id: 1,
        userId: USER_ID,
        username: USER_ID,
        userLevel: role === "SUPER_ADMIN" ? 3 : role === "ADMIN" ? 2 : 1,
        roleSource: role === "USER" ? "user" : "admin",
        firstName: "E2E",
        lastName: "User",
        email: "e2e.user@example.com",
        role,
        requiresPasswordChange: false,
        permissions: {},
    };
}

const ok = (data = null) => ({ status: "success", code: 200, message: "OK", requestId: "e2e-req", data });
const fail = (code, title, message, type = "AppError") => ({ status: "error", code, title, message, requestId: `e2e-${code}`, error: { type } });

/**
 * Installs the API mock. `api.user` (null = signed out) drives auth/me; `api.handlers[endpoint]`
 * overrides any endpoint (endpoint = path after /api/v1/, no query). Returns the mutable mock state.
 */
async function mockApi(page, { user = null } = {}) {
    const api = { user, handlers: {}, calls: [] };
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
        if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
        const endpoint = url.pathname.replace(/^.*\/api\/v1\//, "");
        api.calls.push(`${req.method()} ${endpoint}`);
        const reply = (status, body, headers = {}) => route.fulfill({ status, headers: { ...cors, ...headers }, contentType: "application/json", body: JSON.stringify(body) });

        const custom = api.handlers[endpoint];
        if (custom) {
            const res = custom(req);
            if (res) return reply(res.status, res.body, res.headers);
        }
        if (endpoint === "csrf/token" || endpoint === "csrf/refresh") return reply(200, { success: true, token: "e2e-csrf", expiresIn: 3_600_000 });
        if (endpoint === "csrf/status") return reply(200, { success: true, isValid: true });
        if (endpoint === "auth/me") return api.user ? reply(200, ok(api.user)) : reply(401, fail(401, "Unauthorized", "Not signed in."));
        if (endpoint === PROTECTED_DATA) return reply(200, ok({ sections: [] }));
        return reply(200, ok([]));
    });
    return api;
}

/**
 * Seeds storage ONCE per tab (guarded), before any app script runs. Re-runs on later navigations are
 * no-ops, so whatever the app writes afterwards (lastLocation, signout) is what the next page sees.
 */
async function seedStorage(page, { signedIn = false, lastLocation = null, payload = null } = {}) {
    await page.addInitScript(
        ({ signedIn, lastLocation, payload, userId, LAST_LOCATION_KEY, ERROR_PAYLOAD_KEY }) => {
            if (sessionStorage.getItem("e2e.seeded")) return;
            sessionStorage.setItem("e2e.seeded", "1");
            if (signedIn) {
                localStorage.setItem("user_session", "1");
                localStorage.setItem("user_display", JSON.stringify({ firstName: "E2E", lastName: "User", userId }));
            }
            if (lastLocation) sessionStorage.setItem(LAST_LOCATION_KEY, JSON.stringify({ path: lastLocation, userId }));
            if (payload) sessionStorage.setItem(ERROR_PAYLOAD_KEY, JSON.stringify(payload));
        },
        { signedIn, lastLocation, payload, userId: USER_ID, LAST_LOCATION_KEY, ERROR_PAYLOAD_KEY },
    );
}

/** Opens the protected page as a signed-in user so ProtectedRoute genuinely records it. */
async function visitProtectedPage(page) {
    await page.goto(PROTECTED_PAGE);
    await expect(page).toHaveURL(`${APP_ORIGIN}${PROTECTED_PAGE}`);
    await expect.poll(() => page.evaluate((k) => sessionStorage.getItem(k), LAST_LOCATION_KEY), { message: "ProtectedRoute should record the last location" }).toContain(PROTECTED_PAGE);
}

const stashPayload = (page, payload) => page.evaluate(([k, v]) => sessionStorage.setItem(k, JSON.stringify(v)), [ERROR_PAYLOAD_KEY, payload]);
const pathOf = (page) => new URL(page.url()).pathname;
const homeLink = (page, name) => page.getByRole("link", { name });

/* ─── 1. 429 loop ──────────────────────────────────────────────────────────────────────────────── */
test.describe("1. 429 'Try again' returns to the original page (no reload loop)", () => {
    test("API 429 on a protected page → countdown → Try again lands back on that page", async ({ page }) => {
        const api = await mockApi(page, { user: buildUser("ADMIN") });
        await seedStorage(page, { signedIn: true });
        let throttled = true;
        api.handlers[PROTECTED_DATA] = () => (throttled ? { status: 429, headers: { "retry-after": "1" }, body: fail(429, "Too Many Requests", "Slow down.", "RateLimitError") } : null);

        await page.goto(`${PROTECTED_PAGE}?doc=readme`);
        await expect(page).toHaveURL(/\/too-many-requests$/);
        throttled = false;

        const retry = page.getByRole("button", { name: /try again/i });
        await expect(retry).toBeEnabled({ timeout: 5_000 }); // Retry-After: 1 → countdown is ~1s
        await retry.click();

        await expect(page).toHaveURL(/\/support\/dev-docs\?doc=readme$/);
        expect(pathOf(page)).not.toBe("/too-many-requests");
    });

    test("boot-time CSRF 429 (CsrfGate) → Try again lands back on the page the user opened", async ({ page }) => {
        const api = await mockApi(page, { user: buildUser("ADMIN") });
        await seedStorage(page, { signedIn: true });
        let throttled = true;
        api.handlers["csrf/token"] = () => (throttled ? { status: 429, headers: { "retry-after": "1" }, body: fail(429, "Too Many Requests", "Slow down.", "RateLimitError") } : null);

        await page.goto(PROTECTED_PAGE);
        await expect(page).toHaveURL(/\/too-many-requests$/);
        throttled = false;

        const retry = page.getByRole("button", { name: /try again/i });
        await expect(retry).toBeEnabled({ timeout: 5_000 });
        await retry.click();

        await expect(page).toHaveURL(`${APP_ORIGIN}${PROTECTED_PAGE}`);
    });
});

/* ─── 2. 6-case matrix on the error pages' home link ───────────────────────────────────────────── */
test.describe("2. error-page home link — 6-case matrix", () => {
    // `expected` is the href (PATH only, never the query).
    const MATRIX = [
        { name: "signed in + safe returnTo → returnTo", signedIn: true, returnTo: SAFE_RETURN, expected: "/system/logging-and-observability" },
        { name: "signed in + absent returnTo → last location", signedIn: true, returnTo: undefined, expected: PROTECTED_PAGE },
        { name: "signed in + unsafe returnTo → last location", signedIn: true, returnTo: UNSAFE_RETURN, expected: PROTECTED_PAGE },
        { name: "signed out + protected returnTo → '/'", signedIn: false, returnTo: SAFE_RETURN, expected: "/" },
        { name: "signed out + public returnTo → returnTo", signedIn: false, returnTo: PUBLIC_RETURN, expected: "/about/help" },
        { name: "signed out + absent returnTo → '/'", signedIn: false, returnTo: undefined, expected: "/" },
        { name: "signed out + unsafe returnTo → '/'", signedIn: false, returnTo: UNSAFE_RETURN, expected: "/" },
    ];

    for (const { name, signedIn, returnTo, expected } of MATRIX) {
        test(`404: ${name}`, async ({ page }) => {
            await mockApi(page, { user: signedIn ? buildUser("ADMIN") : null });
            if (signedIn) {
                await seedStorage(page, { signedIn: true });
                await visitProtectedPage(page); // the app itself records the last location
            } else {
                await page.goto("/about/help");
            }
            await stashPayload(page, { code: 404, returnTo: returnTo ?? null });
            await page.goto("/page-not-found");

            const link = homeLink(page, /beam me home/i);
            await expect(link).toHaveAttribute("href", expected);
            expect(await link.getAttribute("href")).not.toContain("?");
        });
    }

    test("signed in + absent returnTo + no last location → '/dashboard'", async ({ page }) => {
        await mockApi(page, { user: buildUser("ADMIN") });
        await seedStorage(page, { signedIn: true });
        await page.goto("/page-not-found");
        await expect(homeLink(page, /beam me home/i)).toHaveAttribute("href", "/dashboard");
    });

    test("404 home link actually navigates a signed-in user back to the last page (not /auth)", async ({ page }) => {
        await mockApi(page, { user: buildUser("ADMIN") });
        await seedStorage(page, { signedIn: true });
        await visitProtectedPage(page);
        await page.goto("/some/route/that/does/not/exist"); // router catch-all → /page-not-found
        await expect(page).toHaveURL(/\/page-not-found$/);
        await homeLink(page, /beam me home/i).click();
        await expect(page).toHaveURL(`${APP_ORIGIN}${PROTECTED_PAGE}`);
    });

    const MATRIX_429 = [
        { name: "signed in + safe returnTo", signedIn: true, returnTo: SAFE_RETURN, expectedHref: "/system/logging-and-observability", expectedNav: /\/system\/logging-and-observability\?tab=metrics$/ },
        { name: "signed in + unsafe returnTo", signedIn: true, returnTo: UNSAFE_RETURN, expectedHref: PROTECTED_PAGE, expectedNav: /\/support\/dev-docs$/ },
        { name: "signed out + public returnTo", signedIn: false, returnTo: PUBLIC_RETURN, expectedHref: "/about/help", expectedNav: /\/about\/help\?topic=sessions$/ },
        { name: "signed out + protected returnTo", signedIn: false, returnTo: SAFE_RETURN, expectedHref: "/", expectedNav: /\/home$/ }, // "/" → /home public landing
    ];

    for (const { name, signedIn, returnTo, expectedHref, expectedNav } of MATRIX_429) {
        test(`429: ${name} → link ${expectedHref}, Try again navigates there`, async ({ page }) => {
            await mockApi(page, { user: signedIn ? buildUser("ADMIN") : null });
            if (signedIn) {
                await seedStorage(page, { signedIn: true });
                await visitProtectedPage(page);
            } else {
                await page.goto("/about/help");
            }
            await stashPayload(page, { code: 429, retryAfter: 1, returnTo });
            await page.goto("/too-many-requests");

            await expect(homeLink(page, /back to home/i)).toHaveAttribute("href", expectedHref);
            const retry = page.getByRole("button", { name: /try again/i });
            await expect(retry).toBeEnabled({ timeout: 5_000 });
            await retry.click();
            await expect(page).toHaveURL(expectedNav);
        });
    }
});

/* ─── 3. Signed-in visits to /auth and "/" ─────────────────────────────────────────────────────── */
test.describe("3. signed-in user at /auth goes back to where they left off", () => {
    test("/auth → last page used", async ({ page }) => {
        await mockApi(page, { user: buildUser("ADMIN") });
        await seedStorage(page, { signedIn: true });
        await visitProtectedPage(page);
        await page.goto("/auth");
        await expect(page).toHaveURL(`${APP_ORIGIN}${PROTECTED_PAGE}`);
    });

    test("/auth with no last page → role landing (/dashboard)", async ({ page }) => {
        await mockApi(page, { user: buildUser("USER") });
        await seedStorage(page, { signedIn: true });
        await page.goto("/auth");
        await expect(page).toHaveURL(/\/dashboard$/);
    });

    test("signed-out visitor at /auth stays on /auth (login form shown)", async ({ page }) => {
        const api = await mockApi(page, { user: null });
        await page.goto("/auth");
        await expect(page.getByRole("button", { name: /sign in|log in/i }).first()).toBeVisible();
        await expect(page).toHaveURL(/\/auth$/);
        expect(api.calls).not.toContain("GET auth/me"); // no session hint → no verification request
    });
});

/* ─── 4. 440 / 498 still go to /auth ───────────────────────────────────────────────────────────── */
test.describe("4. 440 / 498 end the session and lead to /auth", () => {
    const CASES = [
        { code: 440, route: /\/login-timeout$/, label: /sign in again/i },
        { code: 498, route: /\/invalid-token$/, label: /get a fresh token/i },
    ];

    for (const { code, route, label } of CASES) {
        test(`${code}: while signed in /auth bounces back; after the ${code} takeover the link goes to /auth and it stays there`, async ({ page }) => {
            const api = await mockApi(page, { user: buildUser("ADMIN") });
            await seedStorage(page, { signedIn: true });
            await visitProtectedPage(page);

            // Precondition: a live session at /auth is returned to the last page.
            await page.goto("/auth");
            await expect(page).toHaveURL(`${APP_ORIGIN}${PROTECTED_PAGE}`);

            // The session dies mid-use.
            api.handlers[PROTECTED_DATA] = () => ({ status: code, body: fail(code, "Session ended", "Your session ended.") });
            api.handlers["auth/me"] = () => ({ status: code, body: fail(code, "Session ended", "Your session ended.") });
            await page.goto(`${PROTECTED_PAGE}?again=1`);
            await expect(page).toHaveURL(route);

            const link = homeLink(page, label);
            await expect(link).toHaveAttribute("href", "/auth");
            expect(await page.evaluate(() => localStorage.getItem("user_session"))).toBeNull();
            expect(await page.evaluate((k) => sessionStorage.getItem(k), LAST_LOCATION_KEY)).toBeNull();

            await link.click();
            await expect(page).toHaveURL(/\/auth$/);
            await expect(page.getByRole("button", { name: /sign in|log in/i }).first()).toBeVisible();
            await expect(page).toHaveURL(/\/auth$/); // not bounced to the old last page
        });

        test(`${code} page link is /auth even for a signed-in hint with a safe returnTo`, async ({ page }) => {
            await mockApi(page, { user: buildUser("ADMIN") });
            await seedStorage(page, { signedIn: true, lastLocation: PROTECTED_PAGE, payload: { code, returnTo: SAFE_RETURN } });
            await page.goto(code === 440 ? "/login-timeout" : "/invalid-token");
            await expect(homeLink(page, label)).toHaveAttribute("href", "/auth");
        });
    }
});
