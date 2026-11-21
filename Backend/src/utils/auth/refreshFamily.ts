"use strict";

/**
 * @fileoverview Reads the session-family id (`fid`) out of a refresh token for
 * rate-limit keying. The token is fully verified (HS256, audience, issuer, type)
 * so a client cannot pick or forge a family id to rotate buckets (CWE-307).
 * Pure function: reads `JWT_SECRET` per call, never throws, never logs the token.
 * O(len) for the HMAC.
 *
 * @author senior-nodejs-engineer
 */

const jwt = require("jsonwebtoken");
const { TOKEN_TYPES, TOKEN_ISSUER, TOKEN_AUDIENCES } = require("../../constants/authTokens");

const FID_LENGTH = 36;

/**
 * @param {unknown} token - raw refresh JWT (from the signed cookie)
 * @returns {string|null} the 36-char family id, or null for anything unverifiable
 */
function refreshFamilyOf(token) {
    if (typeof token !== "string" || token === "" || token.length > 4096) return null;
    const secret = process.env.JWT_SECRET;
    if (!secret) return null;
    try {
        const decoded = jwt.verify(token, secret, {
            algorithms: ["HS256"],
            audience: TOKEN_AUDIENCES.REFRESH,
            issuer: TOKEN_ISSUER,
        });
        if (decoded?.type !== TOKEN_TYPES.REFRESH) return null;
        return typeof decoded.fid === "string" && decoded.fid.length === FID_LENGTH ? decoded.fid : null;
    } catch {
        return null;
    }
}

module.exports = { refreshFamilyOf };
