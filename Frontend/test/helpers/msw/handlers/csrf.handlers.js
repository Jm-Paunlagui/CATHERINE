/**
 * CSRF bootstrap handlers.
 *
 * HttpClient fetches a token before any mutating request, so without these
 * every POST/PUT/DELETE test would fail on an unhandled /csrf/token request
 * rather than on the thing it is actually asserting.
 */

import { http, HttpResponse } from "msw";

const API = "http://localhost:3000/api/v1";

const tokenPayload = {
    success: true,
    token: "test-csrf-token",
    expiresIn: 3_600_000,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshIn: 3_000_000,
};

export const csrfHandlers = [
    http.get(`${API}/csrf/token`, () => HttpResponse.json(tokenPayload)),
    http.post(`${API}/csrf/refresh`, () => HttpResponse.json(tokenPayload)),
    http.get(`${API}/csrf/status`, () =>
        HttpResponse.json({
            success: true,
            isValid: true,
            expiresAt: tokenPayload.expiresAt,
        }),
    ),
];
