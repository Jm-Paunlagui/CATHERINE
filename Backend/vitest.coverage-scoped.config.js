// vitest.coverage-scoped.config.js
// TEMPORARY scoped-coverage config for branch-coverage measurement.
// Identical to vitest.config.js but WITHOUT coverage thresholds, so a partial
// (single-directory) test run can emit a json-summary without the global gate
// aborting the report write. Not used by CI. Safe to delete.
const base = require("./vitest.config.js");

// defineConfig returns a resolved object; strip thresholds off the coverage block.
const cfg = base.default || base;
if (cfg.test && cfg.test.coverage) {
    delete cfg.test.coverage.thresholds;
    cfg.test.coverage.reporter = ["text", "json-summary"];
}
module.exports = cfg;
