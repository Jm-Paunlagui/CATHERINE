/**
 * helpTelemetry.test.js — Unit tests for
 * src/features/support/help/helpTelemetry.js.
 *
 * Real reportHelpMiss + real httpClient under MSW (we never mock what we own).
 * The endpoint POST client/help-miss is intercepted at the network boundary so
 * we can assert exactly what was sent and how many times.
 *
 * PORT NOTE (MEAL → CATHERINE): behaviour is identical; only the example query
 * vocabulary is retuned to CATHERINE topics (sessions, metrics, caching, oracle
 * — never MEAL's top-up/payslip/subsidy). The endpoint is `client/help-miss`.
 *
 * Contract under test:
 *   - reports a settled miss to POST client/help-miss with { query, surface }
 *   - dedupes: the SAME (surface, query) is sent at most once per session
 *   - different surfaces / different queries are distinct sends
 *   - trims + bounds the query client-side before send
 *   - drops an empty/blank query (no request at all)
 *   - fire-and-forget: a server error NEVER rejects to the caller, and the
 *     failed key is rolled back so a later retry can re-send
 *
 * __resetHelpTelemetry() clears the per-session dedupe memory between cases.
 */
import { waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reportHelpMiss, __resetHelpTelemetry } from "../../../src/features/support/help/helpTelemetry.js";
import csrfMiddleware from "../../../src/middleware/security/CsrfMiddleware.js";
import { apiUrl } from "../../helpers/msw/api.js";
import { server } from "../../helpers/msw/server.js";

/** Capture every help-miss body MSW sees; default handler returns 200. */
let received;

/** Install the capturing 200 handler for client/help-miss. */
function captureOk() {
    server.use(
        http.post(apiUrl("client/help-miss"), async ({ request }) => {
            received.push(await request.json());
            return HttpResponse.json({ status: "success", code: 200, message: "Recorded.", data: null });
        }),
    );
}

beforeEach(async () => {
    received = [];
    __resetHelpTelemetry();
    csrfMiddleware.clearToken();
    // help-miss is a POST, so HttpClient's interceptor gates it on
    // CsrfMiddleware.ensureTokenReady() (a real GET csrf/token, globally
    // handled). Pre-warm the token so the send is not delayed by a token fetch.
    await csrfMiddleware.ensureTokenReady();
    captureOk();
});

afterEach(() => {
    csrfMiddleware.clearToken();
});

/** Let any erroneous extra / late sends arrive so a negative assertion is real. */
const settle = () => new Promise((r) => setTimeout(r, 40));

describe("reportHelpMiss — fire-and-forget zero-result reporter", () => {
    it("sends { query, surface } to POST client/help-miss", async () => {
        reportHelpMiss("how do i see my session", "center");

        await waitFor(() => expect(received).toHaveLength(1));
        expect(received[0]).toEqual({ query: "how do i see my session", surface: "center" });
    });

    it("dedupes the same (surface, query) — sent at most once per session", async () => {
        reportHelpMiss("cors", "assistant");
        reportHelpMiss("cors", "assistant");
        reportHelpMiss("cors", "assistant");

        await waitFor(() => expect(received).toHaveLength(1));
        await settle();
        expect(received).toHaveLength(1);
    });

    it("treats a different surface as a distinct miss", async () => {
        reportHelpMiss("cors", "assistant");
        reportHelpMiss("cors", "center");

        await waitFor(() => expect(received).toHaveLength(2));
    });

    it("treats a different query as a distinct miss", async () => {
        reportHelpMiss("cors", "center");
        reportHelpMiss("caching", "center");

        await waitFor(() => expect(received).toHaveLength(2));
    });

    it("trims the query before sending", async () => {
        reportHelpMiss("   metrics   ", "center");

        await waitFor(() => expect(received).toHaveLength(1));
        expect(received[0].query).toBe("metrics");
    });

    it("bounds an over-long query to 120 chars before sending", async () => {
        reportHelpMiss("a".repeat(500), "center");

        await waitFor(() => expect(received).toHaveLength(1));
        expect(received[0].query).toHaveLength(120);
    });

    it("drops an empty query — no request is made", async () => {
        reportHelpMiss("   ", "center");
        reportHelpMiss("", "assistant");

        await settle();
        expect(received).toHaveLength(0);
    });

    it("never rejects to the caller when the server errors (fire-and-forget)", async () => {
        server.use(
            http.post(apiUrl("client/help-miss"), () => HttpResponse.json({ status: "error" }, { status: 500 })),
        );

        // reportHelpMiss returns void and must never throw synchronously; the
        // swallowed rejection must not surface as an unhandled rejection either.
        expect(() => reportHelpMiss("boom", "center")).not.toThrow();
        await settle();
    });

    it("rolls back the dedupe key on failure so a later identical miss retries", async () => {
        // First attempt fails.
        server.use(
            http.post(apiUrl("client/help-miss"), () => HttpResponse.json({ status: "error" }, { status: 500 })),
        );
        reportHelpMiss("retry-me", "center");
        // Let the failed attempt settle and roll back the dedupe key.
        await settle();

        // Endpoint recovers; the same query must be allowed through again.
        received = [];
        captureOk();
        reportHelpMiss("retry-me", "center");

        await waitFor(() => expect(received).toHaveLength(1));
        expect(received[0].query).toBe("retry-me");
    });
});
