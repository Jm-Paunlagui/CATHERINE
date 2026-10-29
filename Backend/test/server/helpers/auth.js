"use strict";

const jwt = require("jsonwebtoken");
const {
  TOKEN_TYPES,
  TOKEN_ISSUER,
  TOKEN_AUDIENCES,
} = require("../../../src/constants/authTokens");

/** Claims AuthMiddleware requires on every access token (type/aud/iss). */
const ACCESS_CLAIMS = Object.freeze({
  type: TOKEN_TYPES.ACCESS,
  aud: TOKEN_AUDIENCES.ACCESS,
  iss: TOKEN_ISSUER,
});

function signToken(payload = {}, expiresIn = "1h") {
  return jwt.sign(
    { sub: "test-user", userLevel: 1, ...ACCESS_CLAIMS, ...payload },
    process.env.JWT_SECRET || "test-secret",
    { expiresIn },
  );
}

module.exports = { signToken, ACCESS_CLAIMS };
