"use strict";

/**
 * @fileoverview Single source of truth for DEMO_MODE detection.
 *
 * DEMO_MODE=true makes the template run with ZERO database setup: authentication,
 * audit logs, admin management, and changelog are served from in-memory fixtures
 * (see src/models/demo/demoStore.js). No Oracle pools are opened.
 *
 * DEMO_MODE=false (or unset) is the normal path — the app connects to Oracle via
 * the `appDb` connection and the SQL schema in Backend/sql/.
 *
 * Read as a function (not a cached const) so it reflects process.env after
 * dotenv has loaded, and so tests can toggle it at runtime.
 *
 * @returns {boolean}
 */
function isDemoMode() {
    return String(process.env.DEMO_MODE).toLowerCase() === "true";
}

module.exports = { isDemoMode };
