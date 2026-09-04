/**
 * auth.handlers.js — default auth handlers.
 *
 * The default state of the suite is UNAUTHENTICATED: `auth/me` answers 401 in
 * the real error envelope (`AuthenticationError`, the message the backend's
 * `AuthMiddleware.requireAccess` actually sends). Tests that need a signed-in
 * user call `loginAs()` from `test/helpers/auth.js`, which overrides `auth/me`
 * per-test via `server.use()`.
 *
 * `AuthMiddleware.isAuth()` fast-fails without any network call when the
 * `user_session` localStorage hint is absent, so most unauthenticated tests
 * never reach this handler at all. It exists so a stray verify call fails the
 * AUTH way — a 401 envelope the app knows how to read — instead of tripping
 * `onUnhandledRequest: "error"` and reporting a network bug that isn't one.
 *
 * `auth/login`, `auth/refresh` and `auth/change-password` are deliberately NOT
 * given a happy default. They are the three `SELF_HANDLED_ENDPOINTS`; a test
 * touching them is always testing a specific outcome and must say which.
 */

import { http, HttpResponse } from "msw";

import { fail, ok } from "../../fixtures/contract.js";
import { apiUrl } from "../api.js";

export const authHandlers = [
    http.get(apiUrl("auth/me"), () => HttpResponse.json(fail("Authentication required. Please log in.", 401, { type: "AuthenticationError" }), { status: 401 })),
    http.post(apiUrl("auth/logout"), () => HttpResponse.json(ok("Logged out successfully."))),
];
