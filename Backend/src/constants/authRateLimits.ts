"use strict";

/**
 * @fileoverview Limits for the auth-route rate limiters (shared-PC sign-in
 * limits). Constants, not env overrides: these are security
 * controls. No imports.
 *
 * - LOGIN_IP is a per-IP ceiling on FAILED sign-ins (one shared PC / NAT egress).
 * - LOGIN_USER is the per-IP + per-account budget of FAILED sign-ins.
 * - REFRESH is per session family (falls back to the IP bucket for unverifiable cookies).
 * - CHANGE_PASSWORD is per authenticated account.
 *
 * @author senior-nodejs-engineer
 */

const WINDOW_MS = 15 * 60 * 1000;

/** @type {Readonly<{LOGIN_USER: object, LOGIN_IP: object, REFRESH: object, CHANGE_PASSWORD: object, MAX_STORE_KEYS: number, USER_KEY_RE: RegExp, NO_USER_KEY: string}>} */
const AUTH_RATE_LIMITS = Object.freeze({
    LOGIN_USER: Object.freeze({ MAX: 5, WINDOW_MS, LABEL: "RateLimit:login-user" }),
    LOGIN_IP: Object.freeze({ MAX: 30, WINDOW_MS, LABEL: "RateLimit:login-ip" }),
    REFRESH: Object.freeze({ MAX: 20, WINDOW_MS, LABEL: "RateLimit:refresh" }),
    CHANGE_PASSWORD: Object.freeze({ MAX: 5, WINDOW_MS, LABEL: "RateLimit:change-password" }),
    /** Local counter key cap (CWE-400); past it the limiter fails open. */
    MAX_STORE_KEYS: 100_000,
    /** A canonical login id that may become part of a counter key. */
    USER_KEY_RE: /^[A-Za-z0-9._@-]{1,64}$/,
    /** Key segment used when no usable user id was supplied. */
    NO_USER_KEY: "-",
});

/** What a limiter counts. FAILURES = reserve, then refund on success. */
const RATE_LIMIT_COUNT_MODES = Object.freeze({
    ALL: "all",
    FAILURES: "failures",
});

module.exports = { AUTH_RATE_LIMITS, RATE_LIMIT_COUNT_MODES };
