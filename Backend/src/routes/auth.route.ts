"use strict";

const express = require("express");
const router = express.Router();

const AuthController = require("../controllers/AuthControllers");
const AuthMiddleware = require("../middleware/authentication/AuthMiddleware");
const { CacheMiddleware, registry } = require("../middleware/cache");
const {
  loginIpLimiter,
  loginUserLimiter,
  refreshRateLimiter,
  changePasswordRateLimiter,
} = require("../middleware/security/authRateLimiters");

// ── Public endpoints (no auth required) ──────────────────────────────────────

// Order matters: the per-IP ceiling runs first so a refused request never
// creates per-user keys. Both count FAILED sign-ins only (reserve, then refund).
router.post(
  "/login",
  loginIpLimiter.handle,
  loginUserLimiter.handle,
  AuthMiddleware.validateRequiredFields(["userId", "password"]),
  AuthMiddleware.validatePasswordFields({ verify: ["password"] }),
  AuthController.login,
);

// Keyed by the verified session family (falls back to the IP bucket).
router.post("/refresh", refreshRateLimiter.handle, AuthController.refresh);

// ── Protected endpoints ───────────────────────────────────────────────────────
// These three admit a session restricted to setting a new password (temporary
// or legacy default password) — every other authenticated route refuses it
// with 403 PasswordChangeRequiredError.

router.post("/logout", AuthMiddleware.authenticatePendingPasswordChange, AuthController.logout);

router.get("/me", AuthMiddleware.authenticatePendingPasswordChange, AuthController.me);

// Change password (authenticated — user knows their current password).
// changePasswordRateLimiter (5 / 15 min per account) throttles brute force
// against the current-password step; it is mounted AFTER authentication so it
// can key on the signed-in user instead of a shared IP.
// Invalidation: the Access Control admin list shows each row's outstanding
// temporary-password expiry, which a successful change clears.
router.patch(
  "/change-password",
  AuthMiddleware.authenticatePendingPasswordChange,
  changePasswordRateLimiter.handle,
  CacheMiddleware.invalidate(registry.resolve("adminList"), () => "adminList", {
    usePattern: true,
  }),
  AuthMiddleware.validateRequiredFields(["currentPassword", "newPassword"]),
  AuthMiddleware.validatePasswordFields({
    verify: ["currentPassword"],
    hash: ["newPassword"],
  }),
  AuthController.changePassword,
);

module.exports = router;
