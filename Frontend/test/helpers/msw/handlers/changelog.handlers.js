/**
 * changelog.handlers.js — default handlers for the Version History feature.
 *
 * `VersionProvider` (src/contexts/version/VersionContext.jsx) fetches
 * `GET changelog` once per mount to resolve the version badge, and that
 * provider sits in the chain `renderWithProviders` mounts — so this endpoint is
 * hit by essentially every component test in the suite. Without a default
 * handler, `onUnhandledRequest: "error"` would fail tests that have nothing to
 * do with the changelog.
 *
 * The endpoint is PUBLIC on the backend (`changelog.route.js` registers
 * `GET /` with no `AuthMiddleware.authenticate`), so the badge resolves for
 * anonymous visitors too — one handler covers both the signed-in and
 * signed-out cases.
 *
 * The default list is EMPTY on purpose: `VersionProvider` reads
 * `data[0].version` and leaves the build-time fallback in place when it is
 * absent, so no test inherits a version string it did not ask for. Feature
 * tests override with richer fixtures via `server.use()`.
 */

import { http, HttpResponse } from "msw";

import { ok } from "../../fixtures/contract.js";
import { apiUrl } from "../api.js";

export const changelogHandlers = [
    http.get(apiUrl("changelog"), () => HttpResponse.json(ok("Data fetched successfully.", []))),
];
