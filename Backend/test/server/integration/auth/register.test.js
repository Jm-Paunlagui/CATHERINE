"use strict";

/**
 * @fileoverview Register route — not implemented.
 *
 * There is no POST /api/v1/auth/register endpoint.
 * User provisioning is handled via the AdminManagement routes:
 *   POST /api/v1/admin-management      — creates a new admin record
 *
 * All tests are intentionally skipped. This file is retained as
 * documentation so future contributors understand why registration
 * is absent from the auth router.
 */

describe("Auth — Register (no route exists)", function () {
  it.skip("user creation is handled by POST /api/v1/admin-management, not /auth/register", function () {});
  it.skip("see test/server/integration/admin-management/admin-management.test.js for coverage", function () {});
});
