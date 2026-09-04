/**
 * auth.js — put a signed-in user in front of the component under test.
 *
 * Stubs the session THE WAY `AuthMiddleware.isAuth()` actually sees it, with
 * nothing internal to the middleware mocked:
 *
 *   1. `localStorage["user_session"] = "1"` — the non-PII hint
 *      `AuthMiddleware.authenticate()` writes after a real login. Without it,
 *      `isAuth()` fast-fails before any network call and the user is invisible
 *      however good the fixture is.
 *   2. `localStorage["user_display"]` — the traceability identity `HttpClient`
 *      reads to build the `X-Client-Username` header.
 *   3. A per-test MSW override for `GET auth/me` returning the profile in the
 *      real `sendSuccess` envelope.
 *
 * `isAuth()` then genuinely calls `auth/me` through `HttpClient` and caches the
 * result for five minutes, exactly as in production. The cache is cleared first
 * so the previous test's user cannot bleed through.
 *
 * ROLE MODEL — source of truth is `App.jsx` ROLES and the backend's
 * `AuthService._issueTokens()` claim object. `role` is a STRING:
 *   "SUPER_ADMIN" | "ADMIN" | "USER" | "APPROVER" | "VIEWER" | "ROBOT"
 * The numeric form lives in `user.userLevel`, and the backend's
 * `_roleToUserLevel()` maps SUPER_ADMIN → 3, ADMIN → 2, everything else → 1.
 * APPROVER, VIEWER and ROBOT are all level 1 — do not invent higher levels for
 * them, `requireAccess` predicates read this number.
 */

import { http, HttpResponse } from "msw";

import AuthMiddleware from "../../src/middleware/authentication/AuthMiddleware.js";
import { ok } from "./fixtures/contract.js";
import { apiUrl } from "./msw/api.js";
import { server } from "./msw/server.js";

/** Role → userLevel, mirroring `AuthService._roleToUserLevel()`. */
function userLevelFor(role) {
    if (role === "SUPER_ADMIN") return 3;
    if (role === "ADMIN") return 2;
    return 1;
}

/**
 * Build a profile payload matching the backend's JWT claims — the object
 * `GET auth/me` returns via `AuthService.getProfile()`, which hands the decoded
 * token straight back.
 *
 * @param {"SUPER_ADMIN"|"ADMIN"|"USER"|"APPROVER"|"VIEWER"|"ROBOT"} [role="USER"]
 * @param {object} [overrides] Extra or replacement fields.
 * @returns {object} The user payload.
 */
export function buildUser(role = "USER", overrides = {}) {
    const isAdminAccount = role !== "USER";
    return {
        sub: "testuser",
        userId: "testuser",
        id: 1001,
        username: "testuser",
        userLevel: userLevelFor(role),
        firstName: "Test",
        lastName: "User",
        email: "test.user@example.com",
        role,
        loginSource: isAdminAccount ? "admin" : "user",
        isDefaultPassword: false,
        requiresPasswordChange: false,
        ...overrides,
    };
}

/**
 * Sign a user in for the current test.
 *
 * @param {"SUPER_ADMIN"|"ADMIN"|"USER"|"APPROVER"|"VIEWER"|"ROBOT"} [role="USER"]
 * @param {object} [overrides] Extra or replacement user fields.
 * @returns {object} The payload `auth/me` will return.
 * @example
 * loginAs("SUPER_ADMIN");
 * renderWithProviders(<AdminManagementView />, { route: "/system/admin-management" });
 */
export function loginAs(role = "USER", overrides = {}) {
    const user = buildUser(role, overrides);

    AuthMiddleware.clearAuthCache();
    localStorage.setItem("user_session", "1");
    AuthMiddleware.setLocalStorage("user_display", {
        firstName: user.firstName,
        lastName: user.lastName,
        userId: user.userId,
    });

    server.use(http.get(apiUrl("auth/me"), () => HttpResponse.json(ok("Data fetched successfully.", user))));

    return user;
}

/**
 * Clear all client-side auth state — the same path the app's signout takes.
 * @returns {void}
 */
export function logoutUser() {
    AuthMiddleware.signout();
}
