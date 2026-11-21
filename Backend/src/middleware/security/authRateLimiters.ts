"use strict";

/**
 * @fileoverview The four auth-route rate limiters (shared-PC sign-in
 * limits). They replace the single per-IP `authRateLimiter`, which made
 * every user on a shared PC spend one 5-per-15-min budget and
 * counted successful sign-ins and refreshes against it.
 *
 * | Limiter                  | Key                                   | Limit      | Counts   |
 * | ------------------------ | ------------------------------------- | ---------- | -------- |
 * | loginIpLimiter (first)   | login:ip:<ip>                         | 30 / 15 m  | failures |
 * | loginUserLimiter         | login:u:<ip>:<canonical userId>       | 5 / 15 m   | failures |
 * | refreshRateLimiter       | refresh:f:<hash(fid)> or refresh:ip:<ip>    | 20 / 15 m  | all      |
 * | changePasswordRateLimiter| pwchange:<canonical sub>              | 5 / 15 m   | all      |
 *
 * Counting a "failure" is reserve-then-refund (see RateLimiterMiddleware): the
 * hit is taken atomically BEFORE the credential check, so parallel guesses each
 * need a slot (CWE-307), and is given back when the request succeeds. The IP
 * ceiling runs first so refused requests never create per-user keys, and it
 * refunds its hit when the per-user limiter refuses (hammering one account does
 * not block colleagues on the same PC).
 *
 * Key hygiene: a user-supplied id only enters a key when its canonical form is
 * 1-64 chars of `[A-Za-z0-9._@-]` (CWE-400 key flooding, CWE-117); everything
 * else collapses to one `-` segment. A refresh family only keys a bucket when the
 * signed cookie fully verifies (CWE-290/CWE-345).
 *
 * @author senior-nodejs-engineer
 */

const {
  RateLimiterMiddleware,
  RateLimiterGroup,
} = require("./RateLimiterMiddleware");
const {
  AUTH_RATE_LIMITS,
  RATE_LIMIT_COUNT_MODES,
} = require("../../constants/authRateLimits");
const { canonicalUserKey } = require("../../utils/auth/userKey");
const { refreshFamilyOf } = require("../../utils/auth/refreshFamily");
const { getStatusTitle } = require("../../constants/responses");
const { COOKIE_NAMES } = require("../../constants/authTokens");
const { hashJti } = require("../../utils/auth/tokenClaims");

/** Name of the refresh cookie (shared constant; never import AuthService here). */
const REFRESH_COOKIE = COOKIE_NAMES.REFRESH;

const ipOf = (req) => RateLimiterMiddleware.extractIp(req);

/**
 * Canonical user segment for a login key, or `-` when unusable.
 *
 * @param {unknown} userId
 * @returns {string}
 */
function userSegment(userId) {
  const usable =
    typeof userId === "string" ||
    (typeof userId === "number" && Number.isFinite(userId));
  if (!usable) return AUTH_RATE_LIMITS.NO_USER_KEY;
  const canonical = canonicalUserKey(userId);
  return AUTH_RATE_LIMITS.USER_KEY_RE.test(canonical)
    ? canonical
    : AUTH_RATE_LIMITS.NO_USER_KEY;
}

/** @param {import("express").Request} req @returns {string} */
function loginIpKey(req) {
  return `rl:login:ip:${ipOf(req)}`;
}

/** @param {import("express").Request} req @returns {string} */
function loginUserKey(req) {
  return `rl:login:u:${ipOf(req)}:${userSegment(req.body?.userId)}`;
}

/** @param {import("express").Request} req @returns {string} */
function refreshKey(req) {
  const fid = refreshFamilyOf(req.signedCookies?.[REFRESH_COOKIE]);
  // Hashed: the limiter key is logged, and the raw family id must not be (CWE-532).
  return fid ? `rl:refresh:f:${hashJti(fid).slice(0, 32)}` : `rl:refresh:ip:${ipOf(req)}`;
}

/** @param {import("express").Request} req @returns {string} */
function changePasswordKey(req) {
  const sub = req.user?.sub;
  if (sub === undefined || sub === null || sub === "") return `rl:pwchange:ip:${ipOf(req)}`;
  return `rl:pwchange:${canonicalUserKey(sub)}`;
}

/** Shared 429 body (unchanged from the former auth limiter; the UI parses it). */
const onLimit = (req, res, { retryAfter }) =>
  res.status(429).json({
    status: "error",
    code: 429,
    title: getStatusTitle(429),
    message: "Too many attempts. Please wait before trying again.",
    error: {
      type: "RateLimitExceeded",
      details: [{ field: "retryAfter", issue: `${retryAfter} seconds` }],
    },
  });

const make = (cfg, keyBy, countMode) =>
  new RateLimiterMiddleware({
    max: cfg.MAX,
    windowMs: cfg.WINDOW_MS,
    label: cfg.LABEL,
    keyBy,
    countMode,
    maxKeys: AUTH_RATE_LIMITS.MAX_STORE_KEYS,
    onLimit,
  });

const loginIpLimiter = make(
  AUTH_RATE_LIMITS.LOGIN_IP,
  loginIpKey,
  RATE_LIMIT_COUNT_MODES.FAILURES,
);
const loginUserLimiter = make(
  AUTH_RATE_LIMITS.LOGIN_USER,
  loginUserKey,
  RATE_LIMIT_COUNT_MODES.FAILURES,
);
const refreshRateLimiter = make(
  AUTH_RATE_LIMITS.REFRESH,
  refreshKey,
  RATE_LIMIT_COUNT_MODES.ALL,
);
const changePasswordRateLimiter = make(
  AUTH_RATE_LIMITS.CHANGE_PASSWORD,
  changePasswordKey,
  RATE_LIMIT_COUNT_MODES.ALL,
);

const authRateLimiters = new RateLimiterGroup([
  loginIpLimiter,
  loginUserLimiter,
  refreshRateLimiter,
  changePasswordRateLimiter,
]);

module.exports = {
  loginIpKey,
  loginUserKey,
  refreshKey,
  changePasswordKey,
  loginIpLimiter,
  loginUserLimiter,
  refreshRateLimiter,
  changePasswordRateLimiter,
  authRateLimiters,
};
