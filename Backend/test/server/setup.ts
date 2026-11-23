"use strict";

// Environment variables live in test/server/setupEnv.ts, which runs first.

import supertest from "supertest";

// ── supertest: connect to the address the server actually bound ──────────────
//
// supertest(app) starts app.listen(0) — on a dual-stack host a wildcard (::)
// bind — then always connects to 127.0.0.1:<port>. macOS lets that wildcard bind
// take a port another process already holds on 127.0.0.1 (VS Code, Docker,
// Discord... listen there), and loopback traffic then goes to THAT process, the
// more specific binding: a test got a foreign empty-body 404/401 at random.
// When the server bound "::", connect over IPv6 loopback [::1] instead, where
// those 127.0.0.1-only listeners cannot shadow it. Any other bind (0.0.0.0 on an
// IPv4-only host, an explicit host) keeps supertest's own 127.0.0.1 URL.
// (Binding 127.0.0.1 instead was tried: the 500-request perf bursts then
// exhausted 127.0.0.1's ephemeral ports — EADDRNOTAVAIL.)
type ServerLike = { address(): { address: string; port: number } | string | null };
// serverAddress is supertest-internal (absent from its typings): look it up at
// runtime and fail loudly if an upgrade renames it, rather than silently not patching.
const testProto: object = supertest.Test.prototype;
const nativeServerAddress: unknown = Reflect.get(testProto, "serverAddress");
if (typeof nativeServerAddress !== "function") {
    throw new Error("supertest internals changed: Test#serverAddress not found; revisit test/server/setup.ts");
}
Reflect.set(testProto, "serverAddress", function (this: unknown, app: ServerLike, path: string): string {
    const url = String(nativeServerAddress.call(this, app, path));
    const addr = app.address();
    if (addr && typeof addr === "object" && addr.address === "::") {
        return url.replace("://127.0.0.1:", "://[::1]:");
    }
    return url;
});

// ── Global audit log stub ─────────────────────────────────────────────────────
//
// AuditLogMiddleware fires setImmediate(() => AuditLogService.insertAsync(...))
// after EVERY HTTP response. Without a stub, insertAsync tries to acquire an
// Oracle connection (connectTimeout: 15 000 ms, 3 retries → up to 15 s total)
// in the background. This background retry loop starves the event loop and
// causes subsequent HTTP requests in the same test run to timeout, even for
// routes that don't touch Oracle themselves.
//
// Individual test suites that specifically test AuditLogService (audit-log.test.js)
// stub the service with their own vi.spyOn on top of this — the inner mock takes
// precedence while their block is active, then restores to this outer stub.

beforeAll(function () {
    const AuditLogService = require("../../src/services/AuditLogService").default;
    vi.spyOn(AuditLogService, "insertAsync").mockResolvedValue(undefined);
});

afterAll(function () {
    vi.restoreAllMocks();
});
