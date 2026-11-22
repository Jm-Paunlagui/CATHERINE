// vitest.coverage-scoped.config.mts
// Scoped-coverage config for branch-coverage measurement on a partial run.
// Same as vitest.config.mts but WITHOUT coverage thresholds, so a single-directory
// run can emit a json-summary without the global gate aborting the report write.
// Not used by CI. Run: bun --bun vitest run --config vitest.coverage-scoped.config.mts --coverage <dir>
import { mergeConfig } from "vitest/config";
import base from "./vitest.config.mjs";

export default mergeConfig(base, {
    test: {
        coverage: {
            // mergeConfig deep-merges, so the base thresholds are cleared explicitly.
            thresholds: { branches: 0, lines: 0, functions: 0, statements: 0 },
            reporter: ["text", "json-summary"],
        },
    },
});
