"use strict";

/**
 * @fileoverview Barrel — Data Protection resilience primitives.
 * Import both `RetryPolicy` and `BatchGuard` from this single entry point.
 */

const { RetryPolicy } = require("./RetryPolicy");
const { BatchGuard } = require("./BatchGuard");

module.exports = { RetryPolicy, BatchGuard };
