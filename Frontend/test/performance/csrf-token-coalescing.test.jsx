/**
 * csrf-token-coalescing.test.jsx — Performance: concurrent demand for the CSRF
 * token collapses into ONE network fetch, not N.
 *
 * Subject: src/middleware/security/CsrfMiddleware.js singleton, driven for real.
 * MSW is the only mocking boundary — the `_fetchPromise` guard, the
 * `_isInitialized` latch, and the token cache are all production code. Nothing
 * the repo owns is stubbed; the thing under test IS the de-duplication those
 * guards provide.
 *
 * This is a PERFORMANCE suite: it counts network hits, never wall-clock time. A
 * token manager that let every caller launch its own GET csrf/token would, on a
 * cold boot where dozens of features fire their first mutation at once, storm
 * the token endpoint. The invariant is that N concurrent callers cost ONE fetch.
 *
 * The subject calls `fetch()` directly (not Axios), so MSW intercepts the raw
 * request at the same boundary. The default csrf handler is overridden here so
 * the hit counter is under the test's control.
 *
 * NOTE ON TIMEOUTS: CsrfMiddleware._fetchWithRetry retries 3× with exponential
 * backoff (~7s total) ONLY on failure. Every handler here resolves on the first
 * hit, so that slow path is never entered and the 5s Vitest default is safe.
 *
 * Covered:
 *   1. N concurrent ensureTokenReady() callers → exactly ONE GET csrf/token.
 *   2. A caller arriving AFTER the token is cached does no network work at all.
 *   3. The single in-flight fetch is what every concurrent caller resolves to —
 *      they all receive the same token, proving they awaited one promise.
 */

import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import csrfMiddleware from "../../src/middleware/security/CsrfMiddleware.js";
import { apiUrl } from "../helpers/msw/api.js";
import { server } from "../helpers/msw/server.js";

/** A token-endpoint body in the real GET /csrf/token shape. */
function tokenBody(token) {
    return HttpResponse.json({ success: true, token, expiresIn: 3_600_000, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), refreshIn: 3_000_000 });
}

beforeEach(() => {
    // Start every test cold — no cached token, not initialised — so the first
    // ensureTokenReady() is forced down the fetch path.
    csrfMiddleware.clearToken();
    localStorage.clear();
});

afterEach(() => {
    csrfMiddleware.clearToken();
    localStorage.clear();
    vi.restoreAllMocks();
});

describe("CsrfMiddleware — concurrent token demand coalesces into one fetch", () => {
    it("serves N concurrent ensureTokenReady() callers from a SINGLE GET csrf/token", async () => {
        const CALLERS = 10;
        let tokenHits = 0;
        server.use(
            http.get(apiUrl("csrf/token"), () => {
                tokenHits += 1;
                return tokenBody("coalesced-token");
            }),
        );

        // Fire all callers in the same tick, BEFORE any of them resolves, so
        // they genuinely contend for the in-flight fetch rather than each
        // finding a cache warmed by the previous one.
        const tokens = await Promise.all(Array.from({ length: CALLERS }, () => csrfMiddleware.ensureTokenReady()));

        // The whole point: many demands, one network call.
        expect(tokenHits).toBe(1);
        // Every caller received a token, and it is the same one — they all
        // awaited the same promise.
        expect(tokens).toHaveLength(CALLERS);
        expect(new Set(tokens)).toEqual(new Set(["coalesced-token"]));
    });

    it("does NO network work for a caller that arrives after the token is already cached", async () => {
        let tokenHits = 0;
        server.use(
            http.get(apiUrl("csrf/token"), () => {
                tokenHits += 1;
                return tokenBody("warm-token");
            }),
        );

        // First call warms the cache with one fetch.
        const first = await csrfMiddleware.ensureTokenReady();
        expect(tokenHits).toBe(1);
        expect(first).toBe("warm-token");

        // A later, sequential caller reads the cached token — zero extra work.
        const second = await csrfMiddleware.ensureTokenReady();
        expect(tokenHits).toBe(1);
        expect(second).toBe("warm-token");
    });

    it("keeps fetch work at ONE even when concurrent demand is mixed with a cached read", async () => {
        let tokenHits = 0;
        server.use(
            http.get(apiUrl("csrf/token"), () => {
                tokenHits += 1;
                return tokenBody("mixed-token");
            }),
        );

        // Warm the cache first.
        await csrfMiddleware.ensureTokenReady();
        expect(tokenHits).toBe(1);

        // A burst of concurrent callers after warming: all served from cache,
        // no second fetch launched.
        const tokens = await Promise.all(Array.from({ length: 8 }, () => csrfMiddleware.ensureTokenReady()));

        expect(tokenHits).toBe(1);
        expect(new Set(tokens)).toEqual(new Set(["mixed-token"]));
    });
});
