"use strict";

/**
 * @fileoverview Security — GET/HEAD body guard on the real app (CVE-2026-123864).
 *
 * Defence in depth for the Node HTTPS llhttp re-entry leak: a handler that
 * flushes headers (SSE) while the request body is still streaming. Step 2
 * (SecurityFilterMiddleware) must refuse any GET/HEAD that declares a body
 * before any route handler can run.
 *
 * WHY A RAW SOCKET: supertest/superagent always END the request body, so they
 * cannot send an UNFINISHED chunked body — the actual trigger. Every case uses
 * the same raw exchange for consistency.
 *
 * CWE-444 (inconsistent HTTP request interpretation), CWE-400 (socket held by
 * an unfinished body), CWE-532 (the refusal log carries no header/body values).
 */

const http = require("http");
const net = require("net");
const app = require("../../../src/app").default;
const db = require("../../../src/config").default;
const { POOL_NAMES } = require("../../../src/config/database");
const HealthStreamHub = require("../../../src/services/HealthStreamHub").default;
const {
    defaultSecurityFilter,
} = require("../../../src/middleware/security/SecurityFilterMiddleware");
const { signToken } = require("../helpers/auth");

const HEAD_END = "\r\n\r\n";

// ── File-local harness (CATHERINE has no shared healthStreamHarness helper) ──

/** Every pool probe answers, so /health/stream would open if reached. No live Oracle. */
function stubPools() {
    return vi
        .spyOn(db, "withConnection")
        .mockImplementation(async (_name, cb) => cb({ execute: vi.fn().mockResolvedValue({}) }));
}

/** Starts `app` on an ephemeral loopback port. */
async function listen(expressApp) {
    const srv = http.createServer(expressApp);
    await new Promise<any>((r) => srv.listen(0, "127.0.0.1", r));
    return srv;
}

/**
 * Writes `raw` to a fresh loopback socket and reads one response: the head,
 * plus `content-length` body bytes when present (never for HEAD or a response
 * without content-length — an SSE head resolves as soon as it arrives).
 *
 * @param {number} port
 * @param {string} raw - exact request bytes
 * @param {{ timeoutMs?: number, isHead?: boolean }} [opts]
 * @returns {Promise<{ statusLine: string, status: number, headers: Record<string,string>, body: any, rawBody: string }>}
 */
function rawExchange(port, raw, { timeoutMs = 3000, isHead = false } = {}) {
    return new Promise<any>((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1");
        let buf = Buffer.alloc(0);
        let settled = false;
        const finish = (fn, val) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            fn(val);
        };
        const timer = setTimeout(
            () => finish(reject, new Error(`rawExchange timeout; received so far: ${JSON.stringify(buf.toString("latin1"))}`)),
            timeoutMs,
        );
        const tryParse = () => {
            const text = buf.toString("latin1");
            const idx = text.indexOf(HEAD_END);
            if (idx < 0) return;
            const [statusLine, ...lines] = text.slice(0, idx).split("\r\n");
            const headers: Record<string, any> = {};
            for (const l of lines) {
                const c = l.indexOf(":");
                if (c > 0) headers[l.slice(0, c).trim().toLowerCase()] = l.slice(c + 1).trim();
            }
            const bodyBuf = buf.subarray(Buffer.byteLength(text.slice(0, idx + HEAD_END.length), "latin1"));
            const cl = headers["content-length"];
            if (!isHead && cl !== undefined && bodyBuf.length < Number(cl)) return;
            const rawBody = !isHead && cl !== undefined ? bodyBuf.subarray(0, Number(cl)).toString("utf8") : "";
            let body: any = null;
            try {
                body = rawBody ? JSON.parse(rawBody) : null;
            } catch {
                body = rawBody;
            }
            const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1]);
            finish(resolve, { statusLine, status, headers, body, rawBody });
        };
        socket.on("data", (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            tryParse();
        });
        socket.on("error", (e) => finish(reject, e));
        socket.on("close", () => {
            tryParse();
            finish(reject, new Error(`socket closed before a full response; received: ${JSON.stringify(buf.toString("latin1"))}`));
        });
        socket.write(raw);
    });
}

/** Human-readable summary used in assertion messages (proof evidence). */
const describeRes = (r) => `${r.statusLine} | content-type=${r.headers["content-type"]} | error.type=${r.body?.error?.type}`;

function expectBodyNotAllowed(r) {
    const summary = describeRes(r);
    expect(r.statusLine, summary).toMatch(/^HTTP\/1\.1 400/);
    expect(r.headers["content-type"] ?? "", summary).toMatch(/^application\/json/);
    expect(r.body?.error?.type, summary).toBe("BodyNotAllowedError");
}

let server;
let port;
beforeEach(async function () {
    server = await listen(app);
    port = server.address().port;
    stubPools();
});
afterEach(async function () {
    HealthStreamHub._resetForTests();
    if (typeof db.__setPoolHealthForTest === "function") {
        for (const p of POOL_NAMES) db.__setPoolHealthForTest(p, true);
    }
    defaultSecurityFilter._suspiciousIPs.clear();
    vi.restoreAllMocks();
    server.closeAllConnections?.();
    await new Promise<any>((r) => server.close(r));
});

describe("CVE-2026-123864 guard — GET/HEAD with a body is refused at step 2", function () {
    it("I1: unfinished chunked GET /api/v1/health/stream → 400 JSON, never text/event-stream", async function () {
        const raw =
            "GET /api/v1/health/stream HTTP/1.1\r\n" +
            "Host: 127.0.0.1\r\n" +
            "Accept: text/event-stream\r\n" +
            "Content-Type: text/plain\r\n" +
            "Transfer-Encoding: chunked\r\n" +
            "\r\n" +
            "5\r\nhello\r\n";
        const r = await rawExchange(port, raw);
        const summary = describeRes(r);
        expect(r.headers["content-type"] ?? "", summary).not.toMatch(/text\/event-stream/);
        expectBodyNotAllowed(r);
        expect(r.headers.connection, summary).toBe("close");
        expect(r.headers["x-request-id"], summary).toBeTruthy();
        expect(HealthStreamHub.size()).toBe(0);
    });

    it("I2: GET /api/v1/health/live with Content-Length: 5 → 400", async function () {
        const raw =
            "GET /api/v1/health/live HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhello";
        expectBodyNotAllowed(await rawExchange(port, raw));
    });

    it("I3 (control): GET /api/v1/health/live with Content-Length: 0 → 200 alive", async function () {
        const raw = "GET /api/v1/health/live HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        const r = await rawExchange(port, raw);
        expect(r.status, describeRes(r)).toBe(200);
        expect(r.body?.data?.alive).toBe(true);
    });

    it("I4: HEAD /api/v1/health/live with unfinished chunked body → 400", async function () {
        const raw =
            "HEAD /api/v1/health/live HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n";
        const r = await rawExchange(port, raw, { isHead: true });
        expect(r.statusLine, describeRes(r)).toMatch(/^HTTP\/1\.1 400/);
    });

    it("I5 (control): POST /api/v1/metrics/frontend with a finished chunked body is not refused by the guard", async function () {
        const raw =
            "POST /api/v1/metrics/frontend HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n" +
            "Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n2\r\n{}\r\n0\r\n\r\n";
        const r = await rawExchange(port, raw);
        expect(r.body?.error?.type, describeRes(r)).not.toBe("BodyNotAllowedError");
    });

    it("I6 (control): switch off at runtime → the I2 request answers 200", async function () {
        const prev = defaultSecurityFilter._rejectBodyOnBodylessMethods;
        defaultSecurityFilter._rejectBodyOnBodylessMethods = false;
        try {
            const raw =
                "GET /api/v1/health/live HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: text/plain\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello";
            const r = await rawExchange(port, raw);
            expect(r.status, describeRes(r)).toBe(200);
        } finally {
            defaultSecurityFilter._rejectBodyOnBodylessMethods = prev === undefined ? true : prev;
        }
    });

    it("I7: authenticated SSE GET /api/v1/audit-logs/stream with unfinished chunked body → 400 before auth", async function () {
        const token = signToken({ sub: "test-user", userLevel: 1 });
        const raw =
            "GET /api/v1/audit-logs/stream HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
            `Authorization: Bearer ${token}\r\n` +
            "Accept: text/event-stream\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n";
        expectBodyNotAllowed(await rawExchange(port, raw));
    });
});
