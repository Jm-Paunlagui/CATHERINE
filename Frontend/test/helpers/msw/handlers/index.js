/**
 * Default MSW handler set — the "everything is healthy and boring" baseline.
 *
 * Tests that need a specific response (an error, an empty list, a particular
 * row) override per-test with `server.use(...)` rather than editing these.
 * Keeping the default green means a test that does NOT care about, say, CSRF
 * bootstrapping never has to stub it.
 *
 * One module per feature. Three are registered by default because all three are
 * reached by the provider chain `renderWithProviders` mounts, not because they
 * are interesting:
 *   csrf      — CsrfProvider bootstraps a token before first paint.
 *   auth      — a stray auth/me verify must fail as a 401 envelope, not as an
 *               unhandled request.
 *   changelog — VersionProvider resolves the version badge on every mount.
 */

import { authHandlers } from "./auth.handlers";
import { changelogHandlers } from "./changelog.handlers";
import { csrfHandlers } from "./csrf.handlers";

export const handlers = [
    ...csrfHandlers,
    ...authHandlers,
    ...changelogHandlers,
];
