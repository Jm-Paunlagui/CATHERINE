// test/server/setupEnv.ts
// First setup file (see vitest.config.mts). Owns the test environment and must
// import nothing from src/.
//
// Why a separate file: vitest.requireToImport.mts hoists every relative
// require() in a setup file to a top-level import, so a src module required by
// setup.ts is evaluated BEFORE setup.ts's own body runs. Env assigned in that
// body arrived too late for modules that read process.env at load time
// (src/config/database.ts reads the Oracle credentials once, on load).
//
// Bun loads Backend/.env into every Vitest fork, so .env values (SMTP, DEMO_MODE,
// LOG_* ...) reach the tests on purpose. The Oracle credentials below override
// .env so tests never log in to the developer's real database schema.

// Set test environment variables before any module is required.
// Prevents Oracle pool initialisation errors and suppresses log noise.
process.env.NODE_ENV = "test";
// Same process zone server.ts pins via src/config/bootEnv.ts, so date-dependent
// tests behave identically on every developer machine and CI host, not only on
// hosts that happen to sit in Asia/Manila.
process.env.TZ = process.env.APP_TZ || "Asia/Manila";
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
process.env.DB_APP_SERVICE_NAME = "testdb";
process.env.APP_DB_USERNAME = "test_app";
process.env.APP_DB_PASSWORD = "test_app_pw";
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
