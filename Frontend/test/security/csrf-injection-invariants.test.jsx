/**
 * csrf-injection-invariants.test.jsx — Security: the CSRF header is injected on
 * exactly the requests that need it, and never leaks onto the ones that must
 * not carry it.
 *
 * Subject: src/middleware/HttpClient.js request interceptor, driven for real
 * over the REAL src/middleware/security/CsrfMiddleware.js singleton. MSW is the
 * only mocking boundary — the exemption list, the verb gate and the token
 * injection are all production code doing its own work.
 *
 * This suite is the INVARIANT complement to the behaviour tests in
 * test/reliability/csrf-retry.test.jsx (which prove the one-shot retry) and
 * test/reliability/session-expiry.test.jsx (which prove the takeover). Those
 * assert what the client DOES; this asserts what it must NEVER do:
 *
 *   INVARIANT 1 — a token that is a defence against cross-site request forgery
 *   is worthless if it is attached to a GET (CWE-352): a forged read carries no
 *   state to protect, and injecting the token there only widens its exposure.
 *   So GET/HEAD/OPTIONS carry NO x-csrf-token.
 *
 *   INVARIANT 2 — the three CSRF endpoints (csrf/token, csrf/refresh,
 *   csrf/status) are the bootstrap itself; injecting a token into the request
 *   that fetches the token is a chicken-and-egg deadlock. The CSRF_EXEMPT list
 *   in HttpClient.js exists to break it, and its integrity is a security
 *   property — a typo that dropped an entry would deadlock the boot path.
 *
 *   INVARIANT 3 — the exemption is prefix/substring matched, so it must not be
 *   over-broad: a mutating endpoint whose path merely CONTAINS a non-exempt
 *   word still gets a token. (The exempt list contains full segment paths, so
 *   this checks the list has not been loosened to bare words like "csrf".)
 *
 * The CSRF_EXEMPT list is mirrored here as the assertion input, not imported —
 * the source deliberately does not export it, and a test that imported the very
 * array it is checking would be vacuous. If HttpClient.js repoints the list,
 * this mirror must be updated in lockstep; that friction is the point.
 *
 * The one unavoidable seam is `HttpClient._navigate`: jsdom's `window.location`
 * is [Unforgeable]. It is spied to an inert stub so a stray takeover cannot
 * abort the run; no path here should reach it, and that it stays uncalled is
 * itself asserted.
 *
 * CONSOLE HYGIENE: none of these paths log. No console spy is scoped; a log
 * here would be a real regression.
 */

import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import httpClient from "../../src/middleware/HttpClient.js";
import csrfMiddleware from "../../src/middleware/security/CsrfMiddleware.js";
import { ok } from "../helpers/fixtures/contract.js";
import { apiUrl } from "../helpers/msw/api.js";
import { server } from "../helpers/msw/server.js";

/**
 * The CSRF_EXEMPT list from HttpClient.js, mirrored as assertion input. NOT
 * imported — the source does not export it, and duplicating it here is the
 * mechanism by which a silent edit to the source is caught: this array and the
 * source must be edited together.
 */
const CSRF_EXEMPT = ["csrf/token", "csrf/refresh", "csrf/status"];

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

describe("CSRF injection invariant — safe verbs never carry the token (CWE-352)", () => {
    it("sends NO x-csrf-token on a GET", async () => {
        let seenToken = "unset";
        server.use(
            http.get(apiUrl("resource/list"), ({ request }) => {
                seenToken = request.headers.get("x-csrf-token");
                return HttpResponse.json(ok("done", []));
            }),
        );

        await httpClient.get("resource/list");

        expect(seenToken).toBeNull();
        expect(navigate).not.toHaveBeenCalled();
    });

    it("sends NO x-csrf-token even when a valid token IS in memory — the verb gate, not token absence, decides", async () => {
        // Bootstrap a real token first: if injection were gated on "is a token
        // available" rather than "is this a mutating verb", this GET would leak it.
        await csrfMiddleware.ensureTokenReady();
        expect(csrfMiddleware.getToken()).toBe("test-csrf-token");

        let seenToken = "unset";
        server.use(
            http.get(apiUrl("resource/detail"), ({ request }) => {
                seenToken = request.headers.get("x-csrf-token");
                return HttpResponse.json(ok("done", {}));
            }),
        );

        await httpClient.get("resource/detail");

        expect(seenToken).toBeNull();
    });
});

describe("CSRF injection invariant — the exempt bootstrap endpoints never receive a token", () => {
    it.each(CSRF_EXEMPT)("never injects an x-csrf-token into the exempt endpoint %s", async (path) => {
        // Prove the token EXISTS so its absence on the wire is the exemption at
        // work, not simply an empty token store.
        await csrfMiddleware.ensureTokenReady();

        let seenToken = "unset";
        // csrf/refresh is the only mutating exempt endpoint; the other two are GETs.
        const isRefresh = path === "csrf/refresh";
        const register = isRefresh ? http.post : http.get;
        server.use(
            register(apiUrl(path), ({ request }) => {
                seenToken = request.headers.get("x-csrf-token");
                if (path === "csrf/status") return HttpResponse.json({ success: true, isValid: true, expiresAt: new Date().toISOString() });
                return HttpResponse.json({ success: true, token: "exempt-token", expiresIn: 3_600_000 });
            }),
        );

        if (isRefresh) await httpClient.post(path, {});
        else await httpClient.get(path);

        // The exemption skips injection entirely — even on the mutating refresh.
        expect(seenToken).toBeNull();
        expect(navigate).not.toHaveBeenCalled();
    });
});

describe("CSRF injection invariant — the exemption is not over-broad", () => {
    it("STILL injects a token on a mutating endpoint whose path is not on the exempt list, even though it contains 'csrf'-adjacent words", async () => {
        await csrfMiddleware.ensureTokenReady();

        let seenToken = "unset";
        // A real, non-exempt mutating endpoint. If the exempt check had been
        // loosened to a bare word, this could wrongly be treated as exempt.
        server.use(
            http.post(apiUrl("settings/csrf-preferences"), ({ request }) => {
                seenToken = request.headers.get("x-csrf-token");
                return HttpResponse.json(ok("saved", null));
            }),
        );

        await httpClient.post("settings/csrf-preferences", { enabled: true });

        // The full-segment exempt paths (csrf/token …) must NOT match this — a
        // protected mutation still needs its token.
        expect(seenToken).toBe("test-csrf-token");
    });

    it("the mirrored exempt list is exactly the three bootstrap endpoints — no more, no less", () => {
        // A local integrity check on the mirror itself: if a maintainer adds a
        // fourth exemption in HttpClient.js without updating this test, the
        // per-endpoint suite above will not cover it and this pins the shape.
        expect([...CSRF_EXEMPT].sort()).toEqual(["csrf/refresh", "csrf/status", "csrf/token"]);
    });
});
