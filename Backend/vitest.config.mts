// vitest.config.mts
// .mts: the package is CommonJS, so an ESM config needs the module extension.
// Vitest runs the TypeScript tests (CJS require or ESM import) directly.
// globals: true → describe/it/expect/vi/beforeAll/afterAll/beforeEach/afterEach
// are injected globally; no import needed in .test.ts files.
// pool: "forks" → each test file runs in its own Node child process (required for
// process.env mutation in setup files to be isolated per-suite).
// fileParallelism: false → test files run sequentially; the suite exercises
// shared in-memory middleware state that is not safe to run concurrently.

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { requireToImport } from "./vitest.requireToImport.mjs";

// Windows: a shell opened at `d:\` makes Vitest's root lowercase while Bun resolves
// imports to `D:\`, so vi.mock() and spies bind to a second module copy. Pin the drive
// letter to upper case (no-op on macOS/Linux).
const root = fileURLToPath(new URL(".", import.meta.url)).replace(/^[a-z]:/, (d) => d.toUpperCase());

export default defineConfig({
    root,
    plugins: [requireToImport()],
    test: {
        globals: true,
        // Console output is written straight to the fork's stdout instead of being relayed to the
        // main process over worker RPC. With 200+ files that log heavily, the relay could still be
        // pending when a worker closed, failing the whole run with EnvironmentTeardownError
        // ("Closing rpc while onUserConsoleLog was pending") even though every test passed.
        disableConsoleIntercept: true,
        environment: "node",
        include: ["test/**/*.test.ts"],
        exclude: [
            // Not a Vitest/mocha test — custom async runner with its own it/assert
            "test/encryption/cryptosuite.test.ts",
            // Oracle-wrapper dev/sample scripts — not test suites
            "test/oracle-mongo-wrapper/**",
            "node_modules/**",
        ],
        // ── Setup files ─────────────────────────────────────────────────────────
        // test/server/setup.ts → sets process.env + stubs AuditLogService for
        //                        every test file (it runs before module load).
        //
        // Vitest setupFiles run in the test file's context (same process/fork) so
        // process.env mutations land before any module is required by the test.
        setupFiles: [
            "./test/server/setupEnv.ts", // env first: imports nothing from src
            "./test/server/setup.ts",
        ],
        coverage: {
            provider: "v8",
            reporter: ["text", "lcov"],
            include: ["src/**/*.ts"],
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
