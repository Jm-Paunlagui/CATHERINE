/**
 * securityDemo.api.js — Raw HTTP calls for the live security demo.
 *
 * Uses a standalone axios instance WITHOUT CSRF/auth interceptors.
 * This is intentional — the demo needs to fire "malicious" requests that
 * the middleware chain will block, and the standard HttpClient would
 * interfere with CSRF headers and auth redirects.
 *
 * Security note: These probes fire GET, POST, TRACE, and PROPFIND requests
 * against public/protected endpoints with malicious patterns. No real state
 * is mutated — POST bodies are either empty or oversized garbage strings.
 *
 * @module securityDemo.api
 */

import axios from "axios";
import { API_BASE_URL } from "../../config/apiBase";

// Strip trailing "api/v1/" to get the server root — the SecurityFilterMiddleware
// runs on ALL paths, not just /api/v1/ routes.
const SERVER_ROOT = API_BASE_URL.replace(/api\/v1\/?$/, "");

/**
 * Standalone axios instance for demo probes.
 * - No withCredentials (no cookies sent — we want unauthenticated probes)
 * - Short timeout to keep the demo snappy
 * - validateStatus: never throw — we want to inspect 4xx/5xx responses
 */
const probe = axios.create({
    baseURL: SERVER_ROOT,
    timeout: 10_000,
    validateStatus: () => true, // never throw on any status code
    withCredentials: false,
});

/**
 * Fire a demo probe request and return a structured result.
 *
 * @param {object}  scenario
 * @param {string}  scenario.method   HTTP method (GET, POST, etc.)
 * @param {string}  scenario.path     Path to request (e.g. "/api/v1/health/../../../etc/passwd")
 * @param {object}  [scenario.headers] Extra headers to send.
 * @param {*}       [scenario.body]    Request body for POST/PUT.
 * @returns {Promise<object>} Structured demo result.
 */
export async function fireProbe(scenario) {
    const start = performance.now();

    try {
        const response = await probe.request({
            method: scenario.method || "GET",
            url: scenario.path,
            headers: scenario.headers || {},
            data: scenario.body || undefined,
        });

        const elapsed = Math.round(performance.now() - start);

        return {
            success: true,
            blocked: response.status >= 400,
            status: response.status,
            statusText: response.statusText,
            responseTime: elapsed,
            headers: {
                "content-type": response.headers["content-type"],
                "x-request-id": response.headers["x-request-id"],
                "x-content-type-options": response.headers["x-content-type-options"],
                "x-frame-options": response.headers["x-frame-options"],
                "x-response-time": response.headers["x-response-time"],
                "strict-transport-security": response.headers["strict-transport-security"],
                "content-security-policy": response.headers["content-security-policy"],
                "referrer-policy": response.headers["referrer-policy"],
                "cross-origin-opener-policy": response.headers["cross-origin-opener-policy"],
                "cross-origin-resource-policy": response.headers["cross-origin-resource-policy"],
                "ratelimit-limit": response.headers["ratelimit-limit"],
                "ratelimit-remaining": response.headers["ratelimit-remaining"],
                "retry-after": response.headers["retry-after"],
            },
            body: response.data,
        };
    } catch (err) {
        const elapsed = Math.round(performance.now() - start);

        // Network error (CORS block, timeout, server down)
        return {
            success: false,
            blocked: true,
            status: err.response?.status ?? 0,
            statusText: err.message || "Network Error",
            responseTime: elapsed,
            headers: {},
            body: err.response?.data ?? { error: err.message },
        };
    }
}
