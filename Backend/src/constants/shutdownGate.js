"use strict";

/**
 * @fileoverview Shared shutdown-gate constants. Kept outside the middleware so the health routes can
 * import the value without pulling the middleware module.
 */

/** Seconds a client should wait before retrying while the process drains (Retry-After). */
const SHUTDOWN_RETRY_AFTER_SEC = 5;

module.exports = Object.freeze({ SHUTDOWN_RETRY_AFTER_SEC });
