"use strict";

// Set test environment variables before any module is required.
// Prevents Oracle pool initialisation errors and suppresses log noise.
// IMPORTANT: dotenv.config() in database.js does NOT override already-set env
// vars, so these values are safe regardless of the real .env file contents.
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-for-unit-tests-only";
process.env.CSRF_SECRET = "test-csrf-secret-for-unit-tests-only";
process.env.COOKIE_SECRET = "test-cookie-secret";
process.env.ENABLE_IP_FILTER = "false";
process.env.ENABLE_CLUSTERING = "false";
process.env.LOG_LEVEL = "error";
process.env.ENABLE_CONSOLE_LOGS = "false";
process.env.LOG_EXCLUDE_HEALTH = "true";
process.env.DB_TYPE = "oracle";
process.env.DB_HOST = "127.0.0.1";
process.env.DB_PORT = "1521";
process.env.DB_SERVICE_NAME = "testdb";
process.env.UA_DB_USERNAME = "test_ua";
process.env.UA_DB_PASSWORD = "test_ua_pw";
process.env.UI_DB_USERNAME = "test_ui";
process.env.UI_DB_PASSWORD = "test_ui_pw";
// Set an effectively unlimited rate limit for tests — the full suite makes
// 3 000+ HTTP requests from 127.0.0.1, exhausting any realistic per-IP cap.
// Rate-limit behaviour is tested separately via RateLimiterMiddleware instances
// created with explicit { max, windowMs } in rate-limit.test.js.
process.env.RATE_LIMIT_MAX = "99999";
process.env.RATE_LIMIT_WINDOW_MS = "60000";
process.env.PORT = "4099";
process.env.DATA_SIGNING_SECRET =
    process.env.DATA_SIGNING_SECRET ||
    "test-signing-secret-for-unit-tests-only-must-be-32-chars";

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
    const AuditLogService = require("../../src/services/AuditLogService");
    vi.spyOn(AuditLogService, "insertAsync").mockResolvedValue(undefined);
});

afterAll(function () {
    vi.restoreAllMocks();
});
