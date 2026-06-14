/**
 * auth.api.js — Authentication API calls.
 *
 * Only HTTP calls live here. No state, no side effects, no React.
 * All functions return the raw Axios response.
 *
 * Backend contract:
 *   POST auth/login    { userId, password } → { data: { user, accessToken } }
 *   POST auth/logout   (protected, clears HTTP-only cookies)
 *   POST auth/refresh  (reads refreshToken HTTP-only cookie)
 *   GET  auth/me       (protected, returns decoded JWT payload)
 */

import httpClient from "../../middleware/HttpClient";

export const authApi = {
    login: (credentials) => httpClient.post("auth/login", credentials),
    logout: () => httpClient.post("auth/logout"),
    refresh: () => httpClient.post("auth/refresh"),
    me: () => httpClient.get("auth/me"),
};
