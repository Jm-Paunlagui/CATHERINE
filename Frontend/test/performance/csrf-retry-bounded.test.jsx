/**
 * csrf-retry-bounded.test.jsx — Performance: the CSRF machinery does BOUNDED
 * work under repeated failure. Never a storm, never an unbounded loop.
 *
 * Subject: src/middleware/HttpClient.js (request + response interceptors) driven
 * for real over the REAL src/middleware/security/CsrfMiddleware.js singleton.
 * MSW is the only mocking boundary — the one-shot `_retry` latch, the token
 * refresh, and the exempt-endpoint list are all production code doing its own
 * work. Nothing the repo owns is stubbed.
 *
 * This is a PERFORMANCE suite, so it measures the amount of WORK the client
 * generates, never wall-clock time. Every assertion counts MSW hits — a bounded
 * request count is the observable proxy for "does not storm". Timing thresholds
 * flake under CI load and are deliberately absent.
 *
 * The one unavoidable seam is `HttpClient._navigate`: jsdom's `window.location`
 * is [Unforgeable], so a spy on `replace` throws "Cannot redefine property".
 * Spying the single prototype method keeps a stray takeover (should one fire)
 * from aborting the run. No CSRF path here should ever reach it.
 *
 * Covered, the failure path first:
 *   1. A request that keeps getting a CSRF 403 issues a BOUNDED number of
 *      csrf/refresh calls — the one-shot latch caps it, it never storms.
 *   2. Each of many independent failing requests refreshes AT MOST once — the
 *      cost scales linearly with requests, never super-linearly.
 *   3. A successful retry mints the token exactly once — no redundant refresh
 *      once the replay succeeds.
 *   4. A GET that 403s never touches csrf/refresh at all — zero refresh work on
 *      the read path.
 *
 * CONSOLE HYGIENE: none of these paths log. The interceptor swallows the CSRF
 * refresh failure silently and rejects; no console spy is scoped and none is
 * expected. A stray log here is a real regression, not noise to be muted.
 */

import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import httpClient from "../../src/middleware/HttpClient.js";
import csrfMiddleware from "../../src/middleware/security/CsrfMiddleware.js";
import { fail, ok } from "../helpers/fixtures/contract.js";
import { apiUrl } from "../helpers/msw/api.js";
import { server } from "../helpers/msw/server.js";

/** A CSRF-rejection envelope: a 403 whose `code` is one the retry allow-list matches. */
function csrfReject(code = "CSRF_TOKEN_INVALID") {
    return HttpResponse.json({ ...fail("Invalid CSRF token.", 403, { type: "CsrfError" }), code }, { status: 403 });
}

/** A fresh, distinct refresh token so a replayed request is provably carrying the new one. */
function refreshToken(token) {
    return HttpResponse.json({ success: true, token, expiresIn: 3_600_000, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), refreshIn: 3_000_000 });
}

let navigate;

beforeEach(() => {
    navigate = vi.spyOn(httpClient, "_navigate").mockImplementation(() => {});
    csrfMiddleware.clearToken();
    localStorage.setItem("user_session", "1");
});

afterEach(() => {
    navigate.mockRestore();
    csrfMiddleware.clearToken();
    localStorage.clear();
    vi.restoreAllMocks();
});

describe("CSRF retry — bounded work under repeated failure (the storm that must never happen)", () => {
    it("caps csrf/refresh at ONE call for a single request that keeps 403ing — the latch, not a loop", async () => {
        let refreshHits = 0;
        let attempts = 0;
        server.use(
            http.post(apiUrl("csrf/refresh"), () => {
                refreshHits += 1;
                return refreshToken("refreshed-storm-guard");
            }),
            // Every attempt rejects. A client that retried on each 403 would
            // hammer both this endpoint AND csrf/refresh without end.
            http.post(apiUrl("widgets"), () => {
                attempts += 1;
                return csrfReject("CSRF_TOKEN_INVALID");
            }),
        );

        await expect(httpClient.post("widgets", { label: "doomed" })).rejects.toMatchObject({ response: { status: 403 } });

        // Original + exactly one replay, and exactly one refresh. This is the
        // whole point: work is O(1) in the number of failures, not O(n).
        expect(attempts).toBe(2);
        expect(refreshHits).toBe(1);
        expect(navigate).not.toHaveBeenCalled();
    });

    it("keeps refresh work linear across MANY independent failing requests — one refresh each, never a shared storm", async () => {
        const REQUESTS = 12;
        let refreshHits = 0;
        server.use(
            http.post(apiUrl("csrf/refresh"), () => {
                refreshHits += 1;
                return refreshToken(`refreshed-linear-${refreshHits}`);
            }),
            // Each request 403s twice (original + retry both fail), so each is
            // eligible for its single refresh and then surfaces.
            http.post(apiUrl("widgets"), () => csrfReject("CSRF_TOKEN_INVALID")),
        );

        const results = await Promise.allSettled(Array.from({ length: REQUESTS }, (_, i) => httpClient.post("widgets", { i })));

        // Every request rejected — none silently swallowed.
        expect(results.every((r) => r.status === "rejected")).toBe(true);
        // Refresh count is bounded by request count: at most one per request.
        // Never a super-linear fan-out where one failure triggers many refreshes.
        expect(refreshHits).toBeLessThanOrEqual(REQUESTS);
        expect(refreshHits).toBeGreaterThan(0);
        expect(navigate).not.toHaveBeenCalled();
    });

    it("mints the token exactly ONCE when the retry succeeds — no redundant refresh after recovery", async () => {
        let refreshHits = 0;
        let attempts = 0;
        server.use(
            http.post(apiUrl("csrf/refresh"), () => {
                refreshHits += 1;
                return refreshToken("refreshed-once");
            }),
            http.post(apiUrl("widgets"), () => {
                attempts += 1;
                if (attempts === 1) return csrfReject("CSRF_TOKEN_MISSING");
                return HttpResponse.json(ok("Created.", { id: 5 }, 201), { status: 201 });
            }),
        );

        const res = await httpClient.post("widgets", { label: "x" });

        expect(res.status).toBe(201);
        // One original + one retry, and the token was minted exactly once.
        expect(attempts).toBe(2);
        expect(refreshHits).toBe(1);
    });

    it("does ZERO refresh work when a GET 403s — the read path never enters the retry branch", async () => {
        let refreshHits = 0;
        let attempts = 0;
        server.use(
            http.post(apiUrl("csrf/refresh"), () => {
                refreshHits += 1;
                return refreshToken("never-used");
            }),
            http.get(apiUrl("widgets"), () => {
                attempts += 1;
                return csrfReject("CSRF_TOKEN_INVALID");
            }),
        );

        await expect(httpClient.get("widgets")).rejects.toMatchObject({ response: { status: 403 } });

        // The read is attempted once and never retried; refresh is never called.
        expect(attempts).toBe(1);
        expect(refreshHits).toBe(0);
    });
});
