// vitest.config.js
// CJS project — Vitest natively supports both CJS (require) and ESM test files.
// globals: true → describe/it/expect/vi/beforeAll/afterAll/beforeEach/afterEach
// are injected globally; no import needed in .test.js files.
// pool: "forks" → each test file runs in its own Node child process (required for
// process.env mutation in setup files to be isolated per-suite).
// fileParallelism: false → test files run sequentially; the suite exercises
// shared in-memory middleware state that is not safe to run concurrently.

const { defineConfig } = require("vitest/config");

module.exports = defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["test/**/*.test.js"],
        exclude: [
            // Not a Vitest/mocha test — custom async runner with its own it/assert
            "test/encryption/cryptosuite.test.js",
            // Oracle-wrapper dev/sample scripts — not test suites
            "test/oracle-mongo-wrapper/**",
            "node_modules/**",
        ],
        // ── Setup files ─────────────────────────────────────────────────────────
        // test/server/setup.js → sets process.env + stubs AuditLogService for
        //                        every test file (it runs before module load).
        //
        // Vitest setupFiles run in the test file's context (same process/fork) so
        // process.env mutations land before any module is required by the test.
        setupFiles: [
            "./test/server/setup.js",
        ],
        coverage: {
            provider: "v8",
            reporter: ["text", "lcov"],
            include: ["src/**/*.js"],
            exclude: [
                "src/config/**",
                "src/utils/oracle-mongo-wrapper/**",
                "node_modules/**",
            ],
            thresholds: {
                branches: 85,
                lines: 80,
                functions: 85,
                statements: 80,
            },
        },
        testTimeout: 60000,
        hookTimeout: 15000,
        pool: "forks",
        fileParallelism: false,
    },
});
