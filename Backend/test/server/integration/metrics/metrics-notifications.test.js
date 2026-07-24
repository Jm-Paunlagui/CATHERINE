"use strict";

/**
 * @fileoverview Integration tests for the server-email-notification endpoints
 * on the /api/v1/metrics resource.
 *
 * Route map (from metrics.route.js):
 *   GET    /api/v1/metrics/notifications/status  Status      (auth: userLevel >= 2)
 *   POST   /api/v1/metrics/notifications/test    Test send   (auth: SUPER_ADMIN, 3/min)
 *   GET    /api/v1/metrics/alerts/history        History     (auth: userLevel >= 2)
 *   POST   /api/v1/metrics/alerts/ack            Acknowledge (auth: userLevel >= 2)
 *   DELETE /api/v1/metrics/alerts/ack            Unack       (auth: userLevel >= 2)
 *
 * AlertNotifierService is stubbed throughout — these tests own the HTTP
 * contract (auth tier, validation, response shape, rate limiting), NOT the
 * notifier's alert-state machine or its SMTP behaviour. A real send would make
 * the suite depend on an SMTP server; a real ack would depend on Oracle.
 *
 * Covers:
 *   - Happy paths for all 5 endpoints
 *   - Auth enforcement: 401 unauthenticated, 403 under-privileged
 *   - SUPER_ADMIN-only gate on test-send (ADMIN at userLevel 2 must NOT pass)
 *   - Required-field validation (400) on ack / unack / test-send
 *   - Query validation on history: bad severity, unparseable date, from > to
 *   - The strict 3/min limiter on test-send
 *   - CSRF gate on the mutating routes
 *   - Response shape contract + X-Request-ID
 */

const request = require("supertest");
const app = require("../../../../src/app");
const { signToken } = require("../../helpers/auth");
const AlertNotifierService = require("../../../../src/services/AlertNotifierService");
const {
    defaultRateLimiter,
} = require("../../../../src/middleware/security/RateLimiterMiddleware");
const {
    notificationTestLimiter,
} = require("../../../../src/routes/metrics.route");

// ── Rate-limit isolation ──────────────────────────────────────────────────────
// The shared in-process defaultRateLimiter accumulates across the whole suite
// from the same loopback IP; flush it so these tests start from a clean window.
beforeAll(function () {
    defaultRateLimiter.flushAll();
});

// ── Token factories ───────────────────────────────────────────────────────────

const adminToken = () =>
    signToken({ id: 2, userId: "ADM001", role: "ADMIN", userLevel: 2 });
const superToken = () =>
    signToken({ id: 1, userId: "SA001", role: "SUPER_ADMIN", userLevel: 3 });
const userToken = () =>
    signToken({ id: 3, userId: "USR001", role: "USER", userLevel: 1 });

// ── Stub return values ────────────────────────────────────────────────────────

const MOCK_STATUS = {
    enabled: true,
    running: true,
    pollIntervalMs: 60_000,
    cooldownMin: 30,
    ackTtlHours: 24,
    recipients: { "server-system-notification": ["o**@example.com"] },
    activeAlerts: [],
    recentSends: [],
};

const MOCK_HISTORY = { rows: [], total: 0, page: 1, limit: 25 };

const MOCK_ACK = {
    alertKey: "HIGH_HEAP::global",
    acknowledged: true,
    ackedBy: 2,
    ackedAt: "2026-07-24T00:00:00.000Z",
    ackExpiresAt: "2026-07-25T00:00:00.000Z",
    severityAtAck: "WARNING",
    note: null,
};

// ── Assertion helpers ─────────────────────────────────────────────────────────

function expectSuccessShape(body) {
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("code");
    expect(body).toHaveProperty("message");
    expect(body).toHaveProperty("data");
    expect(body.status).toBe("success");
}

function expectErrorShape(body) {
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("code");
    expect(body).toHaveProperty("message");
    expect(body).toHaveProperty("error");
    expect(body.status).toBe("error");
}

function expectRequestId(headers) {
    expect(headers["x-request-id"]).toMatch(/^(\d{13}-\d{4}-\d{4}|req_.+)$/);
}

/** Builds a supertest agent with a live CSRF token attached. */
async function csrfAgent() {
    const agent = request.agent(app);
    const res = await agent.get("/api/v1/csrf/token");
    agent._csrfToken = res.body?.token ?? "";
    return agent;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/metrics/notifications/status  (userLevel >= 2)
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/metrics/notifications/status", function () {
    beforeEach(function () {
        vi.spyOn(AlertNotifierService, "getStatus").mockResolvedValue(
            MOCK_STATUS,
        );
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    it("returns 200 with the status payload (ADMIN, userLevel 2)", async function () {
        const res = await request(app)
            .get("/api/v1/metrics/notifications/status")
            .set("Authorization", `Bearer ${adminToken()}`);

        expect(res.status).toBe(200);
        expectSuccessShape(res.body);
        expect(res.body.data).toHaveProperty("enabled");
        expect(res.body.data).toHaveProperty("ackTtlHours");
        expect(AlertNotifierService.getStatus).toHaveBeenCalledTimes(1);
    });

    it("returns 200 for SUPER_ADMIN", async function () {
        const res = await request(app)
            .get("/api/v1/metrics/notifications/status")
            .set("Authorization", `Bearer ${superToken()}`);
        expect(res.status).toBe(200);
    });

    it("returns 401 when unauthenticated", async function () {
        const res = await request(app).get(
            "/api/v1/metrics/notifications/status",
        );
        expect(res.status).toBe(401);
        expectErrorShape(res.body);
    });

    it("returns 403 for USER (userLevel 1 < 2 required)", async function () {
        const res = await request(app)
            .get("/api/v1/metrics/notifications/status")
            .set("Authorization", `Bearer ${userToken()}`);
        expect(res.status).toBe(403);
        expectErrorShape(res.body);
    });

    it("X-Request-ID is present", async function () {
        const res = await request(app)
            .get("/api/v1/metrics/notifications/status")
            .set("Authorization", `Bearer ${adminToken()}`);
        expectRequestId(res.headers);
    });

    it("responds in under 500ms", async function () {
        const start = Date.now();
        await request(app)
            .get("/api/v1/metrics/notifications/status")
            .set("Authorization", `Bearer ${adminToken()}`);
        expect(Date.now() - start).toBeLessThan(500);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/metrics/notifications/test  (SUPER_ADMIN only, 3/min)
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /api/v1/metrics/notifications/test", function () {
    let agent;

    beforeEach(async function () {
        // The limiter is module-level state shared across the whole run — flush
        // it so an earlier test's 3 calls do not 429 the next test's first call.
        notificationTestLimiter.flushAll();
        vi.spyOn(AlertNotifierService, "sendTestNotification").mockResolvedValue(
            { sent: true, notificationId: "NTF-1" },
        );
        agent = await csrfAgent();
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    const body = () => ({ channel: "server-system-notification" });

    it("returns 200 and forwards the channel to the service (SUPER_ADMIN)", async function () {
        const res = await agent
            .post("/api/v1/metrics/notifications/test")
            .set("Authorization", `Bearer ${superToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send(body());

        expect(res.status).toBe(200);
        expectSuccessShape(res.body);
        expect(AlertNotifierService.sendTestNotification).toHaveBeenCalledWith(
            "server-system-notification",
            expect.objectContaining({ role: "SUPER_ADMIN" }),
        );
    });

    it("returns 403 for ADMIN — userLevel 2 is NOT enough, this route is role-gated", async function () {
        const res = await agent
            .post("/api/v1/metrics/notifications/test")
            .set("Authorization", `Bearer ${adminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send(body());

        expect(res.status).toBe(403);
        expectErrorShape(res.body);
        expect(
            AlertNotifierService.sendTestNotification,
        ).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async function () {
        const res = await agent
            .post("/api/v1/metrics/notifications/test")
            .set("x-csrf-token", agent._csrfToken)
            .send(body());
        expect(res.status).toBe(401);
    });

    it("returns 400 when channel is missing", async function () {
        const res = await agent
            .post("/api/v1/metrics/notifications/test")
            .set("Authorization", `Bearer ${superToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send({});

        expect(res.status).toBe(400);
        expectErrorShape(res.body);
        expect(
            AlertNotifierService.sendTestNotification,
        ).not.toHaveBeenCalled();
    });

    it("returns 403 without a CSRF token", async function () {
        const res = await agent
            .post("/api/v1/metrics/notifications/test")
            .set("Authorization", `Bearer ${superToken()}`)
            .send(body());
        expect(res.status).toBe(403);
    });

    it("returns 429 on the 4th call within the window (3/min limiter)", async function () {
        for (let i = 0; i < 3; i++) {
            const ok = await agent
                .post("/api/v1/metrics/notifications/test")
                .set("Authorization", `Bearer ${superToken()}`)
                .set("x-csrf-token", agent._csrfToken)
                .send(body());
            expect(ok.status).toBe(200);
        }

        const limited = await agent
            .post("/api/v1/metrics/notifications/test")
            .set("Authorization", `Bearer ${superToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send(body());

        expect(limited.status).toBe(429);
        expect(AlertNotifierService.sendTestNotification).toHaveBeenCalledTimes(
            3,
        );
    });

    it("X-Request-ID is present", async function () {
        const res = await agent
            .post("/api/v1/metrics/notifications/test")
            .set("Authorization", `Bearer ${superToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send(body());
        expectRequestId(res.headers);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/metrics/alerts/history  (userLevel >= 2)
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/metrics/alerts/history", function () {
    beforeEach(function () {
        vi.spyOn(AlertNotifierService, "getAlertHistory").mockResolvedValue(
            MOCK_HISTORY,
        );
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    it("returns 200 with { rows, total, page, limit }", async function () {
        const res = await request(app)
            .get("/api/v1/metrics/alerts/history")
            .set("Authorization", `Bearer ${adminToken()}`);

        expect(res.status).toBe(200);
        expectSuccessShape(res.body);
        expect(res.body.data).toHaveProperty("rows");
        expect(res.body.data).toHaveProperty("total");
        expect(AlertNotifierService.getAlertHistory).toHaveBeenCalledTimes(1);
    });

    it("does not collide with GET /alerts — the two resolve to different handlers", async function () {
        vi.spyOn(AlertNotifierService, "decorateAlertsWithAckState");

        await request(app)
            .get("/api/v1/metrics/alerts/history")
            .set("Authorization", `Bearer ${adminToken()}`);

        expect(AlertNotifierService.getAlertHistory).toHaveBeenCalledTimes(1);
        expect(
            AlertNotifierService.decorateAlertsWithAckState,
        ).not.toHaveBeenCalled();
    });

    it("normalizes severity to upper case before querying", async function () {
        await request(app)
            .get("/api/v1/metrics/alerts/history?severity=warning")
            .set("Authorization", `Bearer ${adminToken()}`);

        expect(AlertNotifierService.getAlertHistory).toHaveBeenCalledWith(
            expect.objectContaining({ severity: "WARNING" }),
            expect.anything(),
        );
    });

    it("forwards rule / page / limit through to the service", async function () {
        await request(app)
            .get(
                "/api/v1/metrics/alerts/history?rule=HIGH_HEAP&page=2&limit=10",
            )
            .set("Authorization", `Bearer ${adminToken()}`);

        expect(AlertNotifierService.getAlertHistory).toHaveBeenCalledWith(
            expect.objectContaining({ rule: "HIGH_HEAP" }),
            expect.objectContaining({ page: "2", limit: "10" }),
        );
    });

    it("returns 400 for an unknown severity value", async function () {
        const res = await request(app)
            .get("/api/v1/metrics/alerts/history?severity=BOGUS")
            .set("Authorization", `Bearer ${adminToken()}`);

        expect(res.status).toBe(400);
        expectErrorShape(res.body);
        expect(AlertNotifierService.getAlertHistory).not.toHaveBeenCalled();
    });

    it("returns 400 for an unparseable date rather than silently widening the range", async function () {
        const res = await request(app)
            .get("/api/v1/metrics/alerts/history?from=not-a-date")
            .set("Authorization", `Bearer ${adminToken()}`);

        expect(res.status).toBe(400);
        expect(AlertNotifierService.getAlertHistory).not.toHaveBeenCalled();
    });

    it("returns 400 when from is after to", async function () {
        const res = await request(app)
            .get(
                "/api/v1/metrics/alerts/history?from=2026-07-20&to=2026-07-01",
            )
            .set("Authorization", `Bearer ${adminToken()}`);

        expect(res.status).toBe(400);
        expect(AlertNotifierService.getAlertHistory).not.toHaveBeenCalled();
    });

    it("accepts an empty severity as 'no filter'", async function () {
        const res = await request(app)
            .get("/api/v1/metrics/alerts/history?severity=")
            .set("Authorization", `Bearer ${adminToken()}`);

        expect(res.status).toBe(200);
        expect(AlertNotifierService.getAlertHistory).toHaveBeenCalledWith(
            expect.objectContaining({ severity: undefined }),
            expect.anything(),
        );
    });

    it("returns 401 when unauthenticated", async function () {
        const res = await request(app).get("/api/v1/metrics/alerts/history");
        expect(res.status).toBe(401);
    });

    it("returns 403 for USER (userLevel 1 < 2 required)", async function () {
        const res = await request(app)
            .get("/api/v1/metrics/alerts/history")
            .set("Authorization", `Bearer ${userToken()}`);
        expect(res.status).toBe(403);
    });

    it("X-Request-ID is present", async function () {
        const res = await request(app)
            .get("/api/v1/metrics/alerts/history")
            .set("Authorization", `Bearer ${adminToken()}`);
        expectRequestId(res.headers);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/metrics/alerts/ack  (userLevel >= 2)
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /api/v1/metrics/alerts/ack", function () {
    let agent;

    beforeEach(async function () {
        vi.spyOn(AlertNotifierService, "acknowledge").mockResolvedValue(
            MOCK_ACK,
        );
        agent = await csrfAgent();
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    it("returns 200 and passes alertKey + acting admin id + note to the service", async function () {
        const res = await agent
            .post("/api/v1/metrics/alerts/ack")
            .set("Authorization", `Bearer ${adminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send({ alertKey: "HIGH_HEAP::global", note: "ticket OPS-1" });

        expect(res.status).toBe(200);
        expectSuccessShape(res.body);
        expect(AlertNotifierService.acknowledge).toHaveBeenCalledWith(
            "HIGH_HEAP::global",
            2, // JWT `id` claim — the actor, not the username
            "ticket OPS-1",
        );
    });

    it("accepts an alertKey containing '::' and '/' (why it travels in the body)", async function () {
        const key = "HIGH_LATENCY::POST /api/v1/auth/login";
        const res = await agent
            .post("/api/v1/metrics/alerts/ack")
            .set("Authorization", `Bearer ${adminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send({ alertKey: key });

        expect(res.status).toBe(200);
        expect(AlertNotifierService.acknowledge).toHaveBeenCalledWith(
            key,
            2,
            undefined,
        );
    });

    it("returns 400 when alertKey is missing", async function () {
        const res = await agent
            .post("/api/v1/metrics/alerts/ack")
            .set("Authorization", `Bearer ${adminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send({ note: "no key" });

        expect(res.status).toBe(400);
        expectErrorShape(res.body);
        expect(AlertNotifierService.acknowledge).not.toHaveBeenCalled();
    });

    it("returns 400 when alertKey is an object (operator-injection guard)", async function () {
        const res = await agent
            .post("/api/v1/metrics/alerts/ack")
            .set("Authorization", `Bearer ${adminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send({ alertKey: { $ne: "" } });

        expect(res.status).toBe(400);
        expect(AlertNotifierService.acknowledge).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async function () {
        const res = await agent
            .post("/api/v1/metrics/alerts/ack")
            .set("x-csrf-token", agent._csrfToken)
            .send({ alertKey: "HIGH_HEAP::global" });
        expect(res.status).toBe(401);
    });

    it("returns 403 for USER (userLevel 1 < 2 required)", async function () {
        const res = await agent
            .post("/api/v1/metrics/alerts/ack")
            .set("Authorization", `Bearer ${userToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send({ alertKey: "HIGH_HEAP::global" });
        expect(res.status).toBe(403);
    });

    it("returns 403 without a CSRF token", async function () {
        const res = await agent
            .post("/api/v1/metrics/alerts/ack")
            .set("Authorization", `Bearer ${adminToken()}`)
            .send({ alertKey: "HIGH_HEAP::global" });
        expect(res.status).toBe(403);
    });

    it("X-Request-ID is present", async function () {
        const res = await agent
            .post("/api/v1/metrics/alerts/ack")
            .set("Authorization", `Bearer ${adminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send({ alertKey: "HIGH_HEAP::global" });
        expectRequestId(res.headers);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE /api/v1/metrics/alerts/ack  (userLevel >= 2)
// ═══════════════════════════════════════════════════════════════════════════════

describe("DELETE /api/v1/metrics/alerts/ack", function () {
    let agent;

    beforeEach(async function () {
        vi.spyOn(AlertNotifierService, "unacknowledge").mockResolvedValue({
            alertKey: "HIGH_HEAP::global",
            acknowledged: false,
        });
        agent = await csrfAgent();
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    it("returns 200 and forwards alertKey to the service", async function () {
        const res = await agent
            .delete("/api/v1/metrics/alerts/ack")
            .set("Authorization", `Bearer ${adminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send({ alertKey: "HIGH_HEAP::global" });

        expect(res.status).toBe(200);
        expectSuccessShape(res.body);
        expect(res.body.data).toMatchObject({ acknowledged: false });
        expect(AlertNotifierService.unacknowledge).toHaveBeenCalledWith(
            "HIGH_HEAP::global",
        );
    });

    it("returns 400 when alertKey is missing", async function () {
        const res = await agent
            .delete("/api/v1/metrics/alerts/ack")
            .set("Authorization", `Bearer ${adminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send({});

        expect(res.status).toBe(400);
        expectErrorShape(res.body);
        expect(AlertNotifierService.unacknowledge).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async function () {
        const res = await agent
            .delete("/api/v1/metrics/alerts/ack")
            .set("x-csrf-token", agent._csrfToken)
            .send({ alertKey: "HIGH_HEAP::global" });
        expect(res.status).toBe(401);
    });

    it("returns 403 for USER (userLevel 1 < 2 required)", async function () {
        const res = await agent
            .delete("/api/v1/metrics/alerts/ack")
            .set("Authorization", `Bearer ${userToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send({ alertKey: "HIGH_HEAP::global" });
        expect(res.status).toBe(403);
    });

    it("returns 403 without a CSRF token", async function () {
        const res = await agent
            .delete("/api/v1/metrics/alerts/ack")
            .set("Authorization", `Bearer ${adminToken()}`)
            .send({ alertKey: "HIGH_HEAP::global" });
        expect(res.status).toBe(403);
    });

    it("X-Request-ID is present", async function () {
        const res = await agent
            .delete("/api/v1/metrics/alerts/ack")
            .set("Authorization", `Bearer ${adminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send({ alertKey: "HIGH_HEAP::global" });
        expectRequestId(res.headers);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/metrics/alerts — ack decoration
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/metrics/alerts — ack-state decoration", function () {
    const MetricsService = require("../../../../src/services/MetricsService");

    afterEach(function () {
        vi.restoreAllMocks();
    });

    it("returns the DECORATED alerts, not the raw evaluateAlerts() output", async function () {
        const raw = [{ rule: "HIGH_HEAP", severity: "warning" }];
        const decorated = [
            {
                rule: "HIGH_HEAP",
                severity: "warning",
                alertKey: "HIGH_HEAP::global",
                acknowledged: true,
                ackedBy: 2,
                ackedByName: "admin",
            },
        ];
        vi.spyOn(MetricsService, "evaluateAlerts").mockReturnValue(raw);
        vi.spyOn(
            AlertNotifierService,
            "decorateAlertsWithAckState",
        ).mockResolvedValue(decorated);

        const res = await request(app)
            .get("/api/v1/metrics/alerts")
            .set("Authorization", `Bearer ${adminToken()}`);

        expect(res.status).toBe(200);
        expect(
            AlertNotifierService.decorateAlertsWithAckState,
        ).toHaveBeenCalledWith(raw);
        expect(res.body.data.alerts[0]).toMatchObject({
            alertKey: "HIGH_HEAP::global",
            acknowledged: true,
            ackedByName: "admin",
        });
        expect(res.body.data.count).toBe(1);
    });
});
