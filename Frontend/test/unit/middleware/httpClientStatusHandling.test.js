/**
 * httpClientStatusHandling.test.js — status routing through the REAL Axios
 * singleton, over MSW.
 *
 * `httpStatus.test.js` proves the decision table is right. This file proves the
 * interceptor obeys it: for every status the backend can return, WHICH screen
 * the user lands on — or that they stay where they are, with the error handed
 * back to the feature that asked.
 *
 * Nothing about the client is mocked except `HttpClient._navigate`. That seam
 * exists because jsdom's `window.location` is [Unforgeable]: a spy on `replace`
 * throws "Cannot redefine property", which makes the destination invisible.
 * Spying on the one prototype method closes the gap without giving production
 * code a way to repoint navigation.
 *
 * Envelope bodies come from `fail()`/`ok()` in test/helpers/fixtures/contract.js
 * so every fixture carries the same shape the real `ErrorHandlerMiddleware`
 * builds. `status-probe/*` paths are synthetic on purpose — the assertion is
 * about the STATUS, and pinning these sweeps to a real feature endpoint would
 * make them look like tests of that feature.
 */

import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fail, ok } from "../../helpers/fixtures/contract.js";
import { apiUrl } from "../../helpers/msw/api.js";
import { server } from "../../helpers/msw/server.js";
import httpClient from "../../../src/middleware/HttpClient.js";
import csrfMiddleware from "../../../src/middleware/security/CsrfMiddleware.js";
import { consumeErrorPagePayload, resetErrorPagePayloadCache } from "../../../src/utils/storage.js";

/** Registers a GET handler answering with one status, with or without our envelope. */
function respondWith(path, status, { type = "AppError", envelope = true, headers } = {}) {
    server.use(
        http.get(apiUrl(path), () => {
            if (!envelope) {
                // What an edge proxy or a dead origin actually returns: HTML,
                // no `status: "error"` field, nothing the app can read.
                return new HttpResponse(`<html><body>${status}</body></html>`, { status, headers: { "content-type": "text/html", ...headers } });
            }
            return HttpResponse.json(fail(`synthetic ${status}`, status, { type }), { status, headers });
        }),
    );
}

let navigate;

beforeEach(() => {
    navigate = vi.spyOn(httpClient, "_navigate").mockImplementation(() => {});
    localStorage.setItem("user_session", "1");
    sessionStorage.clear();
    resetErrorPagePayloadCache();
});

afterEach(() => {
    navigate.mockRestore();
    localStorage.clear();
    sessionStorage.clear();
    resetErrorPagePayloadCache();
    csrfMiddleware.clearToken();
});

describe("HttpClient — statuses that keep the user where they are", () => {
    /** Every backend error code with no takeover route. */
    const INLINE = [400, 401, 403, 404, 405, 408, 409, 410, 413, 422, 423, 428, 500, 507];

    it.each(INLINE)("status %i rejects to the caller without navigating away", async (status) => {
        const path = `status-probe/inline-${status}`;
        respondWith(path, status);

        await expect(httpClient.get(path)).rejects.toMatchObject({ response: { status } });

        expect(navigate).not.toHaveBeenCalled();
        // The view is still mounted, so the session must be intact.
        expect(localStorage.getItem("user_session")).toBe("1");
    });

    it("a business 403 is handed straight to the caller — no CSRF retry, no takeover", async () => {
        // `CSRF_ERROR_CODES` is an allow-list precisely so a permission denial
        // is not retried behind the user's back with a fresh token it never
        // needed. A blanket "retry any 403" would double every denied write.
        let attempts = 0;
        server.use(
            http.post(apiUrl("admin-management"), () => {
                attempts += 1;
                return HttpResponse.json(fail("You do not have permission to access this resource.", 403, { type: "AuthorizationError" }), { status: 403 });
            }),
        );

        await expect(httpClient.post("admin-management", { username: "x" })).rejects.toMatchObject({ response: { status: 403 } });

        expect(attempts).toBe(1);
        expect(navigate).not.toHaveBeenCalled();
    });

    it("surfaces the server's title and requestId on an inline error for <ApiErrorAlert>", async () => {
        respondWith("status-probe/inline-titled", 409);

        const err = await httpClient.get("status-probe/inline-titled").catch((e) => e);

        expect(err.response.data.title).toBe("Conflict Detected");
        expect(err.requestId).toEqual(expect.stringMatching(/^test-req-\d{6}$/));
    });

    it("falls back to the X-Request-ID header when the body carries no requestId", async () => {
        // A body that is not our envelope still has a correlation id in the
        // header — losing it would leave a user with nothing to quote to support.
        server.use(http.get(apiUrl("status-probe/header-id"), () => HttpResponse.json({}, { status: 409, headers: { "x-request-id": "hdr-req-9" } })));

        const err = await httpClient.get("status-probe/header-id").catch((e) => e);

        expect(err.requestId).toBe("hdr-req-9");
        expect(navigate).not.toHaveBeenCalled();
    });
});

describe("HttpClient — statuses that take over the screen", () => {
    it.each([
        [429, "/too-many-requests"],
        [440, "/login-timeout"],
        [498, "/invalid-token"],
    ])("status %i navigates to %s", async (status, route) => {
        const path = `status-probe/takeover-${status}`;
        respondWith(path, status);

        await expect(httpClient.get(path)).rejects.toMatchObject({ response: { status } });

        expect(navigate).toHaveBeenCalledTimes(1);
        expect(navigate).toHaveBeenCalledWith(route);
    });

    it.each([440, 498])("status %i clears the session before navigating", async (status) => {
        const path = `status-probe/session-end-${status}`;
        respondWith(path, status);

        await expect(httpClient.get(path)).rejects.toMatchObject({ response: { status } });

        // Leaving these in place would let the app render a signed-in shell for
        // a user the server has already forgotten.
        expect(localStorage.getItem("user_session")).toBeNull();
        expect(csrfMiddleware.getToken()).toBeNull();
    });

    it("never retries a rate-limited request — a retry extends the block it is escaping", async () => {
        // The backend limiter counts EVERY request in its window, so an
        // automatic retry lengthens the lockout the user is trying to leave.
        let attempts = 0;
        server.use(
            http.post(apiUrl("status-probe/throttled"), () => {
                attempts += 1;
                return HttpResponse.json(fail("Slow down.", 429), { status: 429 });
            }),
        );

        await expect(httpClient.post("status-probe/throttled", { a: 1 })).rejects.toMatchObject({ response: { status: 429 } });

        expect(attempts).toBe(1);
        expect(navigate).toHaveBeenCalledWith("/too-many-requests");
    });

    it("carries the server's retry-after and requestId across the 429 navigation", async () => {
        server.use(
            http.get(apiUrl("status-probe/throttled-countdown"), () =>
                HttpResponse.json(fail("Slow down.", 429, { details: [{ field: "retryAfter", issue: "42" }] }), { status: 429, headers: { "retry-after": "99" } }),
            ),
        );

        await expect(httpClient.get("status-probe/throttled-countdown")).rejects.toMatchObject({ response: { status: 429 } });

        const stashed = consumeErrorPagePayload();
        // The body's own detail wins over the header: the limiter that knows
        // the window wrote it, the header is the generic fallback.
        expect(stashed).toMatchObject({ code: 429, retryAfter: "42", title: "Too Many Requests", message: "Slow down." });
        expect(stashed.requestId).toEqual(expect.stringMatching(/^test-req-\d{6}$/));
    });

    it("falls back to the Retry-After header when the body has no detail", async () => {
        server.use(http.get(apiUrl("status-probe/throttled-header"), () => HttpResponse.json(fail("Slow down.", 429), { status: 429, headers: { "retry-after": "99" } })));

        await expect(httpClient.get("status-probe/throttled-header")).rejects.toMatchObject({ response: { status: 429 } });

        expect(consumeErrorPagePayload()).toMatchObject({ code: 429, retryAfter: "99" });
    });

    it.each([429, 440, 498])("hands the server's own title and message to the %i screen across the hard navigation", async (status) => {
        // `window.location.replace` destroys router state, so without this
        // hand-off every takeover screen falls back to hardcoded copy and tells
        // the user the same thing whatever actually happened.
        const path = `status-probe/handoff-${status}`;
        respondWith(path, status);

        await expect(httpClient.get(path)).rejects.toMatchObject({ response: { status } });

        expect(consumeErrorPagePayload()).toMatchObject({
            code: status,
            title: expect.any(String),
            message: `synthetic ${status}`,
        });
    });

    it("stashes a null retryAfter for a non-429 takeover", async () => {
        // Only the rate limiter reports a wait. A 440 carrying a countdown
        // would put a timer on a screen where waiting changes nothing.
        respondWith("status-probe/no-countdown", 440);

        await expect(httpClient.get("status-probe/no-countdown")).rejects.toMatchObject({ response: { status: 440 } });

        expect(consumeErrorPagePayload()).toMatchObject({ code: 440, retryAfter: null });
    });

    it("stashes nothing for an inline status — no screen is being handed to", async () => {
        respondWith("status-probe/no-handoff", 409);

        await expect(httpClient.get("status-probe/no-handoff")).rejects.toMatchObject({ response: { status: 409 } });

        expect(consumeErrorPagePayload()).toBeNull();
    });
});

describe("HttpClient — 5xx is only an outage when the backend says so", () => {
    it.each([
        [502, "EmailError"],
        [502, "NotificationError"],
        [503, "MetricsError"],
        [503, "AppError"],
        [504, "AppError"],
    ])("a business %i (%s) stays inline so the feature keeps its own recovery UI", async (status, type) => {
        const path = `status-probe/business-${status}-${type}`;
        respondWith(path, status, { type });

        await expect(httpClient.get(path)).rejects.toMatchObject({ response: { status } });

        expect(navigate).not.toHaveBeenCalled();
    });

    it("preserves a business 502's structured payload for the feature's own modal", async () => {
        server.use(http.post(apiUrl("admin-management"), () => HttpResponse.json(fail("Delivery failed.", 502, { type: "EmailError", details: [{ field: "cause", issue: "mailbox full" }] }), { status: 502 })));

        const err = await httpClient.post("admin-management", { email: "a@b.c" }).catch((e) => e);

        expect(navigate).not.toHaveBeenCalled();
        expect(err.response.data.error.type).toBe("EmailError");
        expect(err.response.data.error.details[0].issue).toBe("mailbox full");
    });

    it.each([
        [502, "DatabaseUnavailableError"],
        [503, "DatabaseUnavailableError"],
        [503, "DatabaseError"],
        [504, "DatabaseTimeoutError"],
        [504, "DatabaseError"],
        [523, "DatabaseError"],
    ])("a driver-level %i (%s) takes over with the outage screen", async (status, type) => {
        const path = `status-probe/outage-${status}-${type}`;
        respondWith(path, status, { type });

        await expect(httpClient.get(path)).rejects.toMatchObject({ response: { status } });

        expect(navigate).toHaveBeenCalledWith("/service-is-currently-unavailable");
    });

    it.each([502, 503, 504, 523])("a %i with no envelope at all takes over — an edge proxy or a dead origin", async (status) => {
        const path = `status-probe/bare-${status}`;
        respondWith(path, status, { envelope: false });

        await expect(httpClient.get(path)).rejects.toMatchObject({ response: { status } });

        expect(navigate).toHaveBeenCalledWith("/service-is-currently-unavailable");
    });

    it("keeps a bare 500 inline — an application that ran and threw is not an outage", async () => {
        respondWith("status-probe/bare-500", 500, { envelope: false });

        await expect(httpClient.get("status-probe/bare-500")).rejects.toMatchObject({ response: { status: 500 } });

        expect(navigate).not.toHaveBeenCalled();
    });
});

describe("HttpClient — the sign-in exemption", () => {
    it.each(["auth/login", "auth/refresh", "auth/change-password"])("never hijacks a 429 on %s — the form owns its own countdown", async (path) => {
        server.use(http.post(apiUrl(path), () => HttpResponse.json(fail("Too many attempts.", 429), { status: 429 })));

        await expect(httpClient.post(path, { username: "u", password: "p" })).rejects.toMatchObject({ response: { status: 429 } });

        expect(navigate).not.toHaveBeenCalled();
    });

    it("never hijacks a locked account on auth/login (423)", async () => {
        server.use(http.post(apiUrl("auth/login"), () => HttpResponse.json(fail("Too many failed sign-in attempts. Please wait before trying again.", 423), { status: 423 })));

        await expect(httpClient.post("auth/login", { username: "u", password: "p" })).rejects.toMatchObject({ response: { status: 423 } });

        expect(navigate).not.toHaveBeenCalled();
    });

    it("never hijacks a bad-credentials 401 on auth/login", async () => {
        server.use(http.post(apiUrl("auth/login"), () => HttpResponse.json(fail("Invalid username or password.", 401), { status: 401 })));

        await expect(httpClient.post("auth/login", { username: "u", password: "p" })).rejects.toMatchObject({ response: { status: 401 } });

        expect(navigate).not.toHaveBeenCalled();
        expect(localStorage.getItem("user_session")).toBe("1");
    });

    it("keeps a self-handled outage inline too — the sign-in form shows its own message", async () => {
        server.use(http.post(apiUrl("auth/login"), () => HttpResponse.json(fail("Service temporarily unavailable.", 503, { type: "DatabaseUnavailableError" }), { status: 503 })));

        await expect(httpClient.post("auth/login", { username: "u", password: "p" })).rejects.toMatchObject({ response: { status: 503 } });

        expect(navigate).not.toHaveBeenCalled();
    });

    it("STILL ends the session on a 440 from auth/refresh — a dead cookie is dead everywhere", async () => {
        server.use(http.post(apiUrl("auth/refresh"), () => HttpResponse.json(fail("Token has expired. Please log in again.", 440), { status: 440 })));

        await expect(httpClient.post("auth/refresh", {})).rejects.toMatchObject({ response: { status: 440 } });

        expect(localStorage.getItem("user_session")).toBeNull();
        expect(navigate).toHaveBeenCalledWith("/login-timeout");
    });
});

describe("HttpClient — everything else is left alone", () => {
    it("does not navigate on a 2xx", async () => {
        server.use(http.get(apiUrl("status-probe/fine"), () => HttpResponse.json(ok("fine", { a: 1 }))));

        const res = await httpClient.get("status-probe/fine");

        expect(res.data.status).toBe("success");
        expect(res.data.requestId).toEqual(expect.stringMatching(/^test-req-\d{6}$/));
        expect(navigate).not.toHaveBeenCalled();
    });

    it("does not navigate when the request never reached a server (timeout / network)", async () => {
        // No status means no plan. Navigating to the outage screen on every
        // dropped Wi-Fi packet would be a takeover for a transient blip.
        server.use(http.get(apiUrl("status-probe/dead"), () => HttpResponse.error()));

        await expect(httpClient.get("status-probe/dead")).rejects.toBeDefined();

        expect(navigate).not.toHaveBeenCalled();
        expect(localStorage.getItem("user_session")).toBe("1");
    });
});
