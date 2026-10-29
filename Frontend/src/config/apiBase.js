/**
 * Single source of truth for the backend API base URL.
 *
 * Resolution: `VITE_API_BASE_URL`, baked at BUILD time by Vite (there is no
 * runtime configuration), with a localhost fallback for local development
 * only. Production builds are guarded in vite.config.js: the build FAILS
 * when the variable is unset — a shipped localhost fallback bricks the whole
 * app (every API call, the CSRF bootstrap, and all SSE streams would target
 * the CLIENT's own machine, and the CsrfGate then hard-redirects to the
 * service-unavailable page) — and when it points at plain `http://`, because
 * an HTTPS-served page cannot call an HTTP API (mixed content).
 *
 * Local dev: the backend's `.env.example` listens on plain `http://` port 2108,
 * which is the fallback below.
 *
 * Deployment (same-host topology): FE `https://SERVER/` (IIS), BE
 * `https://SERVER:2108` → `VITE_API_BASE_URL=https://SERVER:2108/api/v1/`.
 * Auth cookies are SameSite=Strict and survive the cross-PORT split
 * (SameSite ignores ports); a different HOSTNAME would silently drop them.
 */

const _raw =
    import.meta.env.VITE_API_BASE_URL || "http://localhost:2108/api/v1/";

/** Backend API base URL — normalised to always end with a trailing slash. */
export const API_BASE_URL = _raw.endsWith("/") ? _raw : `${_raw}/`;

/** Same URL without the trailing slash — for SSE / fetch path joining. */
export const API_BASE_URL_TRIMMED = API_BASE_URL.replace(/\/$/, "");
