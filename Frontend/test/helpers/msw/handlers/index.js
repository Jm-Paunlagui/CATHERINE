/**
 * Default MSW handler set — the "everything is healthy and boring" baseline.
 *
 * Tests that need a specific response (an error, an empty list, a particular
 * row) override per-test with `server.use(...)` rather than editing these.
 * Keeping the default green means a test that does NOT care about, say, CSRF
 * bootstrapping never has to stub it.
 */

import { csrfHandlers } from "./csrf.handlers";
import { metricsHandlers } from "./metrics.handlers";
import { auditLogHandlers } from "./auditLog.handlers";

export const handlers = [
    ...csrfHandlers,
    ...metricsHandlers,
    ...auditLogHandlers,
];
