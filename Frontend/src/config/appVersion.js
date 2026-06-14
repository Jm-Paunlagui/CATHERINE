/**
 * appVersion.js — Single source of truth for the application version & release stage.
 *
 * Two things drive what the version badge shows across the app (navbar, sidebar,
 * version history):
 *
 *   1. VERSION — the semantic version string, e.g. "1.23.4".
 *      Resolution order:
 *        a) import.meta.env.VITE_APP_VERSION   (deployment override)
 *        b) __APP_VERSION__                    (injected from package.json by Vite)
 *        c) "0.0.0"                            (last-resort fallback)
 *
 *   2. STAGE — the release stage (developer preview → alpha → beta → rc → stable).
 *      Resolution order:
 *        a) import.meta.env.VITE_APP_STAGE     (explicit override: dev|alpha|beta|rc|stable)
 *        b) the semver pre-release tag on the version (e.g. "1.2.0-beta.1" → beta)
 *        c) "stable" when the build is production (import.meta.env.PROD / VITE_ENV)
 *        d) "dev" otherwise (you're running a development build)
 *
 * Standard release ladder (least → most stable):
 *   dev  →  alpha  →  beta  →  rc  →  stable
 */

// ── Stage metadata ──────────────────────────────────────────────────────────
// `variant` maps to a Badge colour; `dot` shows an animated pulse to signal an
// in-progress (non-production) build; `short` is for tight/collapsed spaces.

export const STAGE_META = {
    dev: { id: "dev", label: "Developer Preview", short: "DEV", variant: "purple", dot: true, order: 0 },
    alpha: { id: "alpha", label: "Alpha", short: "α", variant: "red", dot: true, order: 1 },
    beta: { id: "beta", label: "Beta", short: "β", variant: "amber", dot: true, order: 2 },
    rc: { id: "rc", label: "Release Candidate", short: "RC", variant: "blue", dot: true, order: 3 },
    stable: { id: "stable", label: "Stable", short: "", variant: "green", dot: false, order: 4 },
};

export const STAGE_IDS = Object.keys(STAGE_META);

const PROD_FALLBACK_STAGE = "stable";
const DEV_FALLBACK_STAGE = "dev";

/**
 * Detects a release stage from a semver string's pre-release tag.
 * Recognises common conventions, e.g.:
 *   "1.2.0"            → null      (no pre-release tag — a final release)
 *   "1.2.0-beta.3"     → "beta"
 *   "1.2.0-alpha"      → "alpha"
 *   "1.2.0-rc.1"       → "rc"
 *   "1.2.0-dev.20240101" / "-nightly" / "-canary" → "dev"
 *
 * @param {string} version
 * @returns {("dev"|"alpha"|"beta"|"rc"|null)} the inferred stage, or null when none.
 */
export function parseStageFromVersion(version) {
    if (!version || typeof version !== "string") return null;
    const dash = version.indexOf("-");
    if (dash === -1) return null;
    const tag = version.slice(dash + 1).toLowerCase();
    if (/^(rc)/.test(tag)) return "rc";
    if (/^(beta|b\d)/.test(tag)) return "beta";
    if (/^(alpha|a\d)/.test(tag)) return "alpha";
    if (/^(dev|nightly|canary|snapshot|pre)/.test(tag)) return "dev";
    return null;
}

/**
 * Resolves the effective stage id, applying the documented precedence.
 *
 * @param {string} version
 * @param {string} [explicit] - VITE_APP_STAGE override
 * @param {boolean} [isProd]  - whether this is a production build
 * @returns {string} a valid key of STAGE_META
 */
export function resolveStage(version, explicit, isProd) {
    const override = (explicit ?? "").trim().toLowerCase();
    if (override && STAGE_META[override]) return override;

    const inferred = parseStageFromVersion(version);
    if (inferred) return inferred;

    return isProd ? PROD_FALLBACK_STAGE : DEV_FALLBACK_STAGE;
}

// ── Resolved, app-wide values ─────────────────────────────────────────────────

// __APP_VERSION__ is injected at build time by Vite (see vite.config.js).
const PACKAGE_VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";

const env = import.meta.env;
const IS_PROD = env.PROD === true || (env.VITE_ENV ?? "").toLowerCase() === "production";

/** Resolved version string, e.g. "1.23.4". */
export const APP_VERSION = (env.VITE_APP_VERSION || PACKAGE_VERSION || "0.0.0").trim();

/** Resolved stage id — a key of STAGE_META. */
export const APP_STAGE = resolveStage(APP_VERSION, env.VITE_APP_STAGE, IS_PROD);

/** Convenience: the full metadata object for the resolved stage. */
export const APP_STAGE_META = STAGE_META[APP_STAGE] ?? STAGE_META.stable;

/** True when the running build is the production / stable release. */
export const IS_STABLE = APP_STAGE === "stable";
