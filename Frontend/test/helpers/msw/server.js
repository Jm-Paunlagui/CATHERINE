/**
 * MSW node server shared by every test file.
 *
 * Lifecycle is wired once in test/helpers/setup.js:
 *   listen({ onUnhandledRequest: "error" }) — an un-stubbed request is a test
 *   bug, not a silent pass-through to a real backend, so it fails loudly.
 *   resetHandlers() after each test — per-test `server.use(...)` overrides never
 *   leak into the next test.
 */

import { setupServer } from "msw/node";
import { handlers } from "./handlers";

export const server = setupServer(...handlers);

/** Base URL every handler is registered against — matches vitest.config.js env. */
export const API = "http://localhost:3000/api/v1";
