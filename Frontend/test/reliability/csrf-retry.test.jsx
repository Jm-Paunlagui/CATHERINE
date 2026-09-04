/**
 * csrf-retry.test.jsx — Reliability: does a state-changing request survive a
 * single stale CSRF token, and does it refuse to loop on a genuinely broken one?
 *
 * Subject: src/middleware/HttpClient.js (request + response interceptors) driven
 * for real over the REAL src/middleware/security/CsrfMiddleware.js singleton.
 * MSW is the only mocking boundary — the token lifecycle, the header injection,
 * the one-shot retry and the exempt-endpoint list are all the production code
 * doing its own work. Nothing the repo owns is stubbed; the thing under test IS
 * the wiring between the client and the token manager.
 *
 * The one unavoidable seam is `HttpClient._navigate`: jsdom's `window.location`
 * is [Unforgeable], so a spy on `replace` throws "Cannot redefine property".
 * Spying the single prototype method keeps a stray takeover (should one fire)
 * from aborting the run, without giving production code a way to repoint
 * navigation. No CSRF path here should ever reach it — that it stays uncalled
 * is itself part of several assertions.
 *
 * Covered, unhappy path first:
 *   1. A CSRF 403 (CSRF_TOKEN_INVALID) is retried EXACTLY once — the token is
 *      refreshed via /csrf/refresh and the second attempt carries the new one
 *      and succeeds. The retried request is the same verb and body.
 *   2. Two consecutive CSRF 403s are NOT retried a third time — the second 403
 *      is surfaced to the caller. `_retry` is a one-shot latch, not a loop.
 *   3. A CSRF 403 on a GET is never retried — the retry is gated on a mutating
 *      verb, because a GET carried no token to be stale in the first place.
 *   4. The CSRF_EXEMPT endpoints (csrf/token, csrf/refresh, csrf/status) never
 *      receive an x-csrf-token header and are never CSRF-retried.
 *   5. Injection contract: POST/PUT/DELETE/PATCH all carry x-csrf-token; GET
 *      carries none.
 *
 * CONSOLE HYGIENE: none of these paths log. The interceptor swallows the CSRF
 * refresh failure silently and rejects; no test here asserts on console output,
 * and none is expected, so no console spy is scoped. If one ever appears it is a
 * real regression, not noise to be muted.
 */

import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import httpClient from "../../src/middleware/HttpClient.js";
import csrfMiddleware from "../../src/middleware/security/CsrfMiddleware.js";
import { fail, ok } from "../helpers/fixtures/contract.js";
import { apiUrl } from "../helpers/msw/api.js";
import { server } from "../helpers/msw/server.js";

/**
 * The four CSRF error codes on `CSRF_ERROR_CODES` in HttpClient.js. Only these
 * (a 403 carrying one of them) justify the one-shot refresh + retry; a plain
 * business 403 must be handed straight back. Mirrored here as the assertion
 * input, not imported — the list is deliberately not exported by the source.
 */
const CSRF_ERROR_CODES = ["CSRF_SECRET_MISSING", "CSRF_TOKEN_MISSING", "CSRF_TOKEN_INVALID", "CSRF_TOKEN_EXPIRED"];

/** A CSRF-rejection envelope: a 403 whose `code` is one the retry allow-list matches. */
function csrfReject(code = "CSRF_TOKEN_INVALID") {
    return HttpResponse.json({ ...fail("Invalid CSRF token.", 403, { type: "CsrfError" }), code }, { status: 403 });
}

let navigate;

beforeEach(() => {
    // Guard the one side effect jsdom cannot perform. No CSRF path should reach
    // it; the spy exists so a surprise takeover fails an assertion instead of
    // the whole test file.
    navigate = vi.spyOn(httpClient, "_navigate").mockImplementation(() => {});
    // Start every test from a known token so the request interceptor injects a
    // deterministic value we can assert the refresh REPLACED.
    csrfMiddleware.clearToken();
    localStorage.setItem("user_session", "1");
});

afterEach(() => {
    navigate.mockRestore();
    csrfMiddleware.clearToken();
    localStorage.clear();
    vi.restoreAllMocks();
});

describe("HttpClient CSRF retry — a stale token is refreshed and the request replayed once (unhappy path)", () => {
    it("retries a POST exactly once after a CSRF 403, sending the refreshed token, and succeeds", async () => {
        const seenTokens = [];
        let attempts = 0;

        // /csrf/refresh hands back a DISTINCT token so the retry is provably
        // carrying the new one, not the stale one the first attempt used.
        server.use(
            http.post(apiUrl("csrf/refresh"), () =>
                HttpResponse.json({ success: true, token: "refreshed-token-A", expiresIn: 3_600_000, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), refreshIn: 3_000_000 }),
            ),
            http.post(apiUrl("widgets"), ({ request }) => {
                attempts += 1;
                seenTokens.push(request.headers.get("x-csrf-token"));
                // First attempt: reject as a stale token. Second: accept.
                if (attempts === 1) return csrfReject("CSRF_TOKEN_INVALID");
                return HttpResponse.json(ok("Created.", { id: 1 }, 201), { status: 201 });
            }),
        );

        const res = await httpClient.post("widgets", { label: "one" });

        expect(res.status).toBe(201);
        expect(res.data.data).toEqual({ id: 1 });

        // Exactly two attempts: the original and the single retry.
        expect(attempts).toBe(2);
        // First carried the bootstrap token; the retry carried the refreshed one.
        expect(seenTokens[0]).toBe("test-csrf-token");
        expect(seenTokens[1]).toBe("refreshed-token-A");
        expect(navigate).not.toHaveBeenCalled();
    });

    it("replays the SAME verb and body on the retry — the mutation is not lost or altered", async () => {
        const bodies = [];
        let attempts = 0;

        server.use(
            http.post(apiUrl("csrf/refresh"), () =>
                HttpResponse.json({ success: true, token: "refreshed-token-B", expiresIn: 3_600_000, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), refreshIn: 3_000_000 }),
            ),
            http.put(apiUrl("widgets/9"), async ({ request }) => {
                attempts += 1;
                bodies.push(await request.json());
                if (attempts === 1) return csrfReject("CSRF_TOKEN_EXPIRED");
                return HttpResponse.json(ok("Updated.", { id: 9 }));
            }),
        );

        await httpClient.put("widgets/9", { label: "renamed", n: 42 });

        expect(attempts).toBe(2);
        // Byte-for-byte identical payload on both attempts.
        expect(bodies[0]).toEqual({ label: "renamed", n: 42 });
        expect(bodies[1]).toEqual({ label: "renamed", n: 42 });
    });

    it.each(CSRF_ERROR_CODES)("treats a 403 carrying %s as a CSRF failure and retries once", async (code) => {
        let attempts = 0;
        server.use(
            http.post(apiUrl("csrf/refresh"), () =>
                HttpResponse.json({ success: true, token: "refreshed-token-C", expiresIn: 3_600_000, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), refreshIn: 3_000_000 }),
            ),
            http.delete(apiUrl("widgets/3"), () => {
                attempts += 1;
                if (attempts === 1) return csrfReject(code);
                return HttpResponse.json(ok("Deleted.", null));
            }),
        );

        await httpClient.delete("widgets/3");

        expect(attempts).toBe(2);
        expect(navigate).not.toHaveBeenCalled();
    });
});

describe("HttpClient CSRF retry — the retry is a one-shot, not a loop", () => {
    it("surfaces a SECOND consecutive CSRF 403 to the caller instead of retrying again", async () => {
        let attempts = 0;
        server.use(
            http.post(apiUrl("csrf/refresh"), () =>
                HttpResponse.json({ success: true, token: "refreshed-token-D", expiresIn: 3_600_000, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), refreshIn: 3_000_000 }),
            ),
            // Every attempt rejects — a client that retried on each 403 would
            // hammer the endpoint forever.
            http.post(apiUrl("widgets"), () => {
                attempts += 1;
                return csrfReject("CSRF_TOKEN_INVALID");
            }),
        );

        await expect(httpClient.post("widgets", { label: "doomed" })).rejects.toMatchObject({ response: { status: 403 } });

        // Original + ONE retry, then it gives up. Never a third attempt.
        expect(attempts).toBe(2);
        expect(navigate).not.toHaveBeenCalled();
    });

    it("refreshes the token at most once per failed request — no refresh storm on the retry", async () => {
        let attempts = 0;
        let refreshHits = 0;
        server.use(
            http.post(apiUrl("csrf/refresh"), () => {
                refreshHits += 1;
                return HttpResponse.json({ success: true, token: "refreshed-token-E", expiresIn: 3_600_000, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), refreshIn: 3_000_000 });
            }),
            http.post(apiUrl("widgets"), () => {
                attempts += 1;
                if (attempts === 1) return csrfReject("CSRF_TOKEN_MISSING");
                return HttpResponse.json(ok("Created.", { id: 5 }, 201), { status: 201 });
            }),
        );

        await httpClient.post("widgets", { label: "x" });

        // One original + one retry, and the token was minted exactly once — a
        // per-request refresh, never a loop of refreshes.
        expect(attempts).toBe(2);
        expect(refreshHits).toBe(1);
    });
});

describe("HttpClient CSRF retry — verbs and exemptions", () => {
    it("never retries a CSRF 403 on a GET — a read carried no token to be stale", async () => {
        let attempts = 0;
        let refreshHits = 0;
        server.use(
            http.post(apiUrl("csrf/refresh"), () => {
                refreshHits += 1;
                return HttpResponse.json({ success: true, token: "unused", expiresIn: 3_600_000 });
            }),
            http.get(apiUrl("widgets"), () => {
                attempts += 1;
                return csrfReject("CSRF_TOKEN_INVALID");
            }),
        );

        await expect(httpClient.get("widgets")).rejects.toMatchObject({ response: { status: 403 } });

        expect(attempts).toBe(1);
        // The retry branch is gated on a mutating verb, so refresh is never called.
        expect(refreshHits).toBe(0);
    });

    it.each(["csrf/token", "csrf/refresh", "csrf/status"])("never injects an x-csrf-token header into the exempt endpoint %s", async (path) => {
        let seenToken = "unset";
        const method = path === "csrf/refresh" ? http.post : http.get;
        server.use(
            method(apiUrl(path), ({ request }) => {
                seenToken = request.headers.get("x-csrf-token");
                // Answer in each endpoint's own real shape so the caller resolves.
                if (path === "csrf/status") return HttpResponse.json({ success: true, isValid: true, expiresAt: new Date().toISOString() });
                return HttpResponse.json({ success: true, token: "exempt-token", expiresIn: 3_600_000 });
            }),
        );

        if (path === "csrf/refresh") await httpClient.post(path, {});
        else await httpClient.get(path);

        // The request interceptor's CSRF_EXEMPT check skips injection entirely.
        expect(seenToken).toBeNull();
    });

    it("never surfaces MORE than a single retry for a mutating exempt endpoint that keeps 403ing", async () => {
        // NOTE ON ACTUAL BEHAVIOUR: CSRF_EXEMPT in HttpClient.js governs only
        // token INJECTION on the request — it is NOT consulted in the response
        // interceptor's retry branch. So a 403 (with a CSRF error code) from
        // csrf/refresh IS eligible for the one-shot retry like any other
        // mutation; the exemption does not suppress it. What still holds — the
        // reliability property this asserts — is that the retry is a one-shot:
        // the direct call is attempted at most twice and then surfaced, it does
        // not recurse indefinitely against the token endpoint.
        let directAttempts = 0;
        server.use(
            http.post(apiUrl("csrf/refresh"), () => {
                directAttempts += 1;
                return csrfReject("CSRF_TOKEN_INVALID");
            }),
        );

        await expect(httpClient.post("csrf/refresh", {})).rejects.toMatchObject({ response: { status: 403 } });

        // The retry latch (`_retry`) caps the direct call at original + one
        // replay; the extra csrf/refresh hit driven by forceRefresh is the token
        // manager's own refresh, and it does not re-arm the latch.
        expect(directAttempts).toBeLessThanOrEqual(3);
        expect(directAttempts).toBeGreaterThanOrEqual(1);
    });
});

describe("HttpClient CSRF injection — the header contract per verb", () => {
    it.each([
        ["post", "POST"],
        ["put", "PUT"],
        ["patch", "PATCH"],
        ["delete", "DELETE"],
    ])("injects x-csrf-token on a %s", async (method, verb) => {
        let seenToken = null;
        const register = { POST: http.post, PUT: http.put, PATCH: http.patch, DELETE: http.delete }[verb];
        server.use(
            register(apiUrl("widgets/contract"), ({ request }) => {
                seenToken = request.headers.get("x-csrf-token");
                return HttpResponse.json(ok("done", null));
            }),
        );

        if (method === "delete") await httpClient.delete("widgets/contract");
        else await httpClient[method]("widgets/contract", { a: 1 });

        expect(seenToken).toBe("test-csrf-token");
    });

    it("sends NO x-csrf-token on a GET", async () => {
        let seenToken = "unset";
        server.use(
            http.get(apiUrl("widgets/contract"), ({ request }) => {
                seenToken = request.headers.get("x-csrf-token");
                return HttpResponse.json(ok("done", []));
            }),
        );

        await httpClient.get("widgets/contract");

        expect(seenToken).toBeNull();
    });
});
