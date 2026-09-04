/**
 * changelog-httpclient.test.jsx — Integration: does a feature's api module reach
 * the network through the REAL HttpClient, inheriting CSRF injection and the
 * traceability header for free, with MSW faking only the wire?
 *
 * Subject, driven for real, nothing repo-owned stubbed:
 *   • src/features/support/changelog/changelog.api.js (list / create / update / delete)
 *   • src/middleware/HttpClient.js                    (request interceptor)
 *   • src/middleware/security/CsrfMiddleware.js       (token singleton)
 *
 * The changelog feature was picked because it is zero-domain (a version-history
 * list every template ships) and because it exercises BOTH sides of the
 * injection contract: `list()` is a GET that must carry NO CSRF token, while
 * `create`/`update`/`delete` are mutations that must. A feature author writes
 * `httpClient.get("changelog")` and gets the whole cross-cutting stack —
 * exemption logic, token injection, traceability — without writing a line of
 * it. This suite proves that wiring end to end.
 *
 * MSW is the only network boundary; `onUnhandledRequest: "error"` (setup.js)
 * fails any un-stubbed request loudly instead of leaking to a real backend.
 *
 * Covered, unhappy path first:
 *   1. A create() the server rejects (500) rejects the promise AND still
 *      carried the CSRF token on the way out — a server-side failure is not a
 *      client-side injection failure.
 *   2. list() (GET) reaches the real endpoint and carries NO x-csrf-token.
 *   3. create()/update()/delete() (mutations) each carry the bootstrapped
 *      x-csrf-token and the same well-formed X-Client-Username as any other
 *      request.
 *   4. The response envelope the feature receives is the backend's real
 *      `{ status, code, message, requestId, data }` shape, unwrapped by Axios.
 *
 * CONSOLE HYGIENE: none of these paths log. The rejected create() surfaces as a
 * rejected Axios promise, caught by the test's `expect().rejects`. No console
 * spy is scoped; a log here would be a real regression.
 */

import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { changelogApi } from "../../src/features/support/changelog/changelog.api.js";
import AuthMiddleware from "../../src/middleware/authentication/AuthMiddleware.js";
import csrfMiddleware from "../../src/middleware/security/CsrfMiddleware.js";
import { fail, ok } from "../helpers/fixtures/contract.js";
import { apiUrl } from "../helpers/msw/api.js";
import { server } from "../helpers/msw/server.js";

/** A zero-domain changelog entry payload — no feature vocabulary. */
function sampleEntry() {
    return {
        displayDate: "2026-01-01",
        version: "1.0.0",
        title: "Initial entry",
        message: "First release note.",
        whatChanged: [{ text: "Set up the project." }],
        type: "feature",
        authors: ["Test User"],
        coAuthors: [],
    };
}

beforeEach(async () => {
    csrfMiddleware.clearToken();
    localStorage.clear();
    // Bootstrap the token via the REAL singleton, exactly as CsrfProvider would
    // on app boot — the mutations below must carry THIS value.
    await csrfMiddleware.ensureTokenReady();
    // A traceability identity so X-Client-Username is a real name, not the
    // anonymous fallback — proves the interceptor reads what the app wrote.
    AuthMiddleware.setLocalStorage("user_display", { firstName: "Test", lastName: "User", userId: "testuser" });
});

afterEach(() => {
    csrfMiddleware.clearToken();
    localStorage.clear();
    vi.restoreAllMocks();
});

describe("changelog api over HttpClient — a rejected mutation still injected its token (unhappy path)", () => {
    it("rejects create() on a 500 but proves the CSRF token WAS sent — a server failure is not an injection failure", async () => {
        let seenToken = "unset";
        server.use(
            http.post(apiUrl("changelog"), ({ request }) => {
                seenToken = request.headers.get("x-csrf-token");
                return HttpResponse.json(fail("Storage failed.", 500, { type: "AppError" }), { status: 500 });
            }),
        );

        await expect(changelogApi.create(sampleEntry())).rejects.toMatchObject({ response: { status: 500 } });

        // The client did its job — the failure was entirely server-side.
        expect(seenToken).toBe("test-csrf-token");
    });
});

describe("changelog api over HttpClient — the injection contract per verb", () => {
    it("list() (GET) reaches the real endpoint carrying NO x-csrf-token and unwraps the success envelope", async () => {
        let seenToken = "unset";
        server.use(
            http.get(apiUrl("changelog"), ({ request }) => {
                seenToken = request.headers.get("x-csrf-token");
                return HttpResponse.json(ok("Data fetched successfully.", [sampleEntry()]));
            }),
        );

        const res = await changelogApi.list();

        // A read carries no CSRF token — the exemption is verb-driven.
        expect(seenToken).toBeNull();
        // Axios hands the feature the raw envelope; assert the real contract keys.
        expect(res.status).toBe(200);
        expect(res.data).toMatchObject({ status: "success", code: 200, data: expect.any(Array) });
        expect(res.data).toHaveProperty("requestId");
    });

    it.each([
        ["create", () => changelogApi.create(sampleEntry()), "post", "changelog"],
        ["update", () => changelogApi.update("42", sampleEntry()), "put", "changelog/42"],
        ["delete", () => changelogApi.delete("42"), "delete", "changelog/42"],
    ])("%s() (mutation) carries the bootstrapped x-csrf-token and a well-formed X-Client-Username", async (_name, call, verb, path) => {
        let seenToken = "unset";
        let seenClientUser = "unset";
        const register = { post: http.post, put: http.put, delete: http.delete }[verb];
        server.use(
            register(apiUrl(path), ({ request }) => {
                seenToken = request.headers.get("x-csrf-token");
                seenClientUser = request.headers.get("x-client-username");
                return HttpResponse.json(ok("Done.", null));
            }),
        );

        await call();

        expect(seenToken).toBe("test-csrf-token");
        // "Test User@testuser" — the identity the app wrote, joined by the interceptor.
        expect(seenClientUser).toBe("Test User@testuser");
    });
});
