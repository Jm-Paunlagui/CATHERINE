/**
 * malformed-response-body.test.jsx — Chaos: a malformed or empty response body
 * from the server is handled without an uncaught throw. The client neither
 * crashes on the parse nor loses the caller's promise.
 *
 * Subject: src/middleware/HttpClient.js response handling driven for real, with
 * src/constants/httpStatus.js resolving the UI reaction on the error paths. MSW
 * is the only mocking boundary — the fault (a body that is not the expected JSON
 * envelope) is INJECTED at the network and the assertion is that production code
 * absorbs it.
 *
 * A chaos test injects a fault and asserts graceful degradation. An edge proxy,
 * a half-dead origin, or a truncated stream can answer with HTML, an empty body,
 * or invalid JSON where the app expected `{ status, code, message, … }`. The
 * client must resolve/reject cleanly — never throw synchronously out of the
 * interceptor, never leave the caller's promise pending.
 *
 * The `_navigate` seam is spied (jsdom cannot assign window.location). Some
 * malformed-body paths on 5xx codes legitimately take over (the httpStatus
 * table routes an envelope-less 502/503/504/523 to an outage screen); the spy
 * captures that without performing the real navigation, and the tests assert on
 * whether it fired rather than letting it abort the run.
 *
 * Covered, the failure path first:
 *   1. A 200 whose body is invalid JSON resolves without throwing — data is the
 *      raw text, the caller is not handed a rejected-by-parse promise.
 *   2. A 200 with a completely EMPTY body resolves without throwing.
 *   3. A 500 whose body is HTML (no JSON envelope) rejects cleanly — the
 *      interceptor reads `error.response.data?.code` defensively and does not
 *      throw on the missing field.
 *   4. A 503 with an empty body is treated as an unreachable origin (takeover),
 *      driven entirely by the ABSENCE of an envelope — no parse crash.
 */

import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import httpClient from "../../src/middleware/HttpClient.js";
import csrfMiddleware from "../../src/middleware/security/CsrfMiddleware.js";
import { apiUrl } from "../helpers/msw/api.js";
import { server } from "../helpers/msw/server.js";

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

describe("Chaos — a malformed or empty response body does not crash the client", () => {
    it("resolves a 200 whose body is invalid JSON without throwing — the parse failure degrades to raw text", async () => {
        server.use(
            http.get(apiUrl("widgets"), () =>
                // Not JSON, but a 2xx. Axios attempts to parse and, on failure,
                // hands back the raw string rather than throwing.
                new HttpResponse("this is <not> json {{{", { status: 200, headers: { "Content-Type": "application/json" } }),
            ),
        );

        const res = await httpClient.get("widgets");

        expect(res.status).toBe(200);
        // The body survived as text — no synchronous parse throw reached us.
        expect(typeof res.data).toBe("string");
        expect(navigate).not.toHaveBeenCalled();
    });

    it("resolves a 200 with a completely empty body without throwing", async () => {
        server.use(http.get(apiUrl("widgets"), () => new HttpResponse(null, { status: 200 })));

        const res = await httpClient.get("widgets");

        expect(res.status).toBe(200);
        // Empty body → empty-ish data, never an exception.
        expect(res.data === "" || res.data === null || res.data === undefined).toBe(true);
        expect(navigate).not.toHaveBeenCalled();
    });

    it("rejects a 500 whose body is HTML (no JSON envelope) cleanly — the interceptor reads missing fields defensively", async () => {
        server.use(
            http.get(apiUrl("widgets"), () =>
                // A dead origin behind a proxy: 500 with an HTML error page and
                // no `code`/`status` fields. `error.response.data?.code` must
                // tolerate this rather than throw.
                new HttpResponse("<html><body>502 Bad Gateway</body></html>", { status: 500, headers: { "Content-Type": "text/html" } }),
            ),
        );

        let caught = null;
        try {
            await httpClient.get("widgets");
        } catch (err) {
            caught = err;
        }

        // A clean rejection carrying the response — not a synchronous throw out
        // of the interceptor, and not a pending promise.
        expect(caught).not.toBeNull();
        expect(caught.response?.status).toBe(500);
    });

    it("treats a 503 with an empty body as an unreachable origin (takeover) driven by the MISSING envelope — no parse crash", async () => {
        server.use(http.get(apiUrl("reports/summary"), () => new HttpResponse(null, { status: 503 })));

        // The request still rejects for the caller; the interceptor additionally
        // routes the outage takeover. Neither step throws on the empty body.
        await expect(httpClient.get("reports/summary")).rejects.toMatchObject({ response: { status: 503 } });

        // The absence of a `status: "error"` envelope is what marks this as an
        // origin failure, so the takeover navigation fires — captured by the
        // spy, never actually performed.
        expect(navigate).toHaveBeenCalledTimes(1);
    });
});
