/**
 * client-logger-no-fanout.test.jsx — Performance: reporting one error costs one
 * network call. The logger does not fan a single error out into a burst.
 *
 * Subject: src/utils/clientLogger.js driven for real over the REAL
 * src/middleware/HttpClient.js. MSW is the only mocking boundary — the POST
 * client/errors round trip is the production path; nothing the repo owns is
 * stubbed. The thing under test is that `clientLogger.error()` issues exactly
 * one request per call and does not retry, recurse, or amplify on failure.
 *
 * This is a PERFORMANCE suite: it counts POST client/errors hits, never
 * wall-clock time. An error logger that retried on its own failure — or that a
 * failing dependency caused to loop — would turn one render crash into a flood
 * of log traffic exactly when the backend is least able to absorb it. The
 * invariant: N calls → N requests, one-to-one, no multiplier.
 *
 * NOTE: clientLogger echoes to console.error under import.meta.env.DEV. Every
 * test scopes a console.error spy for the duration of the awaited round trip so
 * that understood dev echo is silenced — the assertions never depend on it.
 *
 * Covered, the failure path first:
 *   1. A call whose POST client/errors returns 500 issues exactly ONE request —
 *      the logger swallows the failure, it does not retry.
 *   2. A call whose POST fails with a network error issues exactly ONE request.
 *   3. N sequential error() calls issue exactly N requests — strictly linear,
 *      no per-call amplification.
 */

import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import clientLogger from "../../src/utils/clientLogger.js";
import { ok } from "../helpers/fixtures/contract.js";
import { apiUrl } from "../helpers/msw/api.js";
import { server } from "../helpers/msw/server.js";

let errSpy;

beforeEach(() => {
    // clientLogger's DEV echo (console.error("[ClientLogger]", …)) is understood
    // noise; silence it for the awaited round trip. Assertions never read it.
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    localStorage.clear();
});

afterEach(() => {
    errSpy.mockRestore();
    localStorage.clear();
    vi.restoreAllMocks();
});

describe("clientLogger — one error, one request (no fan-out)", () => {
    it("issues exactly ONE POST client/errors when the endpoint returns 500 — the failure is swallowed, not retried", async () => {
        let hits = 0;
        server.use(
            http.post(apiUrl("client/errors"), () => {
                hits += 1;
                return new HttpResponse(null, { status: 500 });
            }),
        );

        // error() must never throw and must never retry on a 5xx.
        const requestId = await clientLogger.error(new Error("boom"));

        expect(hits).toBe(1);
        // A failed report yields no request id, but does not amplify traffic.
        expect(requestId).toBeNull();
    });

    it("issues exactly ONE POST client/errors when the request fails with a network error", async () => {
        let hits = 0;
        server.use(
            http.post(apiUrl("client/errors"), () => {
                hits += 1;
                return HttpResponse.error();
            }),
        );

        const requestId = await clientLogger.error(new Error("network down"));

        expect(hits).toBe(1);
        expect(requestId).toBeNull();
    });

    it("keeps traffic strictly linear — N sequential error() calls issue exactly N requests", async () => {
        const CALLS = 6;
        let hits = 0;
        server.use(
            http.post(apiUrl("client/errors"), () => {
                hits += 1;
                return HttpResponse.json(ok("Error logged.", { received: true }));
            }),
        );

        for (let i = 0; i < CALLS; i += 1) {
            // Sequential is the point: prove one request per call, not a burst.
            await clientLogger.error(new Error(`err ${i}`));
        }

        // Exactly one request per call — no hidden retry or duplicate emission.
        expect(hits).toBe(CALLS);
    });
});
