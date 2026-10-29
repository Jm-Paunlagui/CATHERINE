const js = require("@eslint/js");
const globals = require("globals");
const { defineConfig, globalIgnores } = require("eslint/config");

module.exports = defineConfig([
  // BLOCK 0 — global ignores
  globalIgnores(["dist", "coverage", "node_modules"]),

  // BLOCK 1 — base: all .js (src + server.js + root configs)
  {
    files: ["**/*.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      // ES2022: logger.js uses private class methods (#foo). 2020 would parse-error.
      ecmaVersion: 2022,
      sourceType: "commonjs", // repo uses require/module.exports throughout
      globals: { ...globals.node },
    },
    rules: {
      "no-console": "error", // enforce CLAUDE.md logger-not-console going forward
      "no-unused-vars": [
        "error",
        {
          varsIgnorePattern: "^[A-Z_]",
          argsIgnorePattern: "^_",
          // Deliberate throwaway catch bindings follow the repo's existing `_` /
          // `_err` convention (see the many `catch (_)` guards in src/services).
          // Bindings NOT starting with `_` still error, so genuine unused catches
          // are still caught.
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  // BLOCK 2 — console-exempt production files: these two ARE the logging/console
  // plumbing itself, so routing their own output through the logger would be
  // circular.
  {
    files: [
      "src/utils/consoleManager.js",
      "src/utils/logger.js",
    ],
    rules: { "no-console": "off" },
  },

  // BLOCK 3 — scripts (CLI tools; console allowed)
  {
    files: ["scripts/**/*.js"],
    languageOptions: { globals: { ...globals.node } },
    rules: { "no-console": "off" },
  },

  // BLOCK 4 — test files (vitest globals: true → injected, not imported; environment: node)
  {
    files: ["test/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
        describe: "readonly",
        it: "readonly",
        test: "readonly",
        expect: "readonly",
        vi: "readonly",
        suite: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        assert: "readonly",
      },
    },
  },

  // BLOCK 5 — oracle-mongo-wrapper suites are mocha/chai (run via `npx mocha`),
  // not vitest. They use mocha's `after`/`before` lifecycle globals, which BLOCK 4
  // does not inject. Add the mocha global set for these two files only so they lint
  // cleanly without touching the (correct, runtime-tested) source.
  {
    files: ["test/oracle-mongo-wrapper/test.js", "test/oracle-mongo-wrapper/test.dev.js"],
    languageOptions: {
      globals: { ...globals.node, ...globals.mocha },
    },
  },

  // BLOCK 6 — this one test file is authored as an ES module (top-level `import`
  // from "vitest" + dynamic `import()`); vitest executes it as ESM regardless of
  // package "type". Parse it as a module here rather than rewriting working test
  // code to CommonJS (which could alter module-isolation behavior it relies on).
  {
    files: ["test/server/unit/utils/snowflake.test.js"],
    languageOptions: { sourceType: "module" },
  },

  // BLOCK 7 — standalone CLI diagnostic harnesses. These paths are explicitly
  // EXCLUDED from the vitest suite (see vitest.config.js `exclude`): they are
  // hand-run report generators (like scripts/), and console output IS their
  // function. Allow console here for the same reason BLOCK 3 allows it in scripts.
  {
    files: ["test/encryption/**/*.js", "test/oracle-mongo-wrapper/**/*.js"],
    rules: { "no-console": "off" },
  },

  // BLOCK 8 — chaos suite. These tests deliberately emit conditional "[CHAOS
  // NOTE]/[CHAOS GAP FOUND]" console lines as their documented output channel —
  // a passing chaos test surfaces a discovered gap to a human reading CI logs
  // (the source comments state this explicitly). The console call is the test's
  // designed reporting mechanism, not stray debug logging, so allow it here only.
  {
    files: ["test/server/chaos/**/*.js"],
    rules: { "no-console": "off" },
  },
]);
