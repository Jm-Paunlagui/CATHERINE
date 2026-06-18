"use strict";

const dotenv = require("dotenv");
dotenv.config({ path: ".env" });

// const isDevelopment = process.env.NODE_ENV === "development";

function buildSimpleConnectString(host, port, service) {
  return `${host}:${port}/${service}`;
}

function buildTNSConnectString(host, port, sid) {
  return (
    `(DESCRIPTION=` +
    `(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))` +
    `(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))` +
    `(LOAD_BALANCE=yes)` +
    `(CONNECT_DATA=(SERVER=DEDICATED)(SID=${sid})` +
    `(FAILOVER_MODE=(TYPE=SELECT)(METHOD=BASIC)(RETRIES=180)(DELAY=5))))`
  );
}

/**
 * Connection registry.
 *
 * HOW TO ADD A NEW CONNECTION:
 *   1. Add env vars to .env
 *   2. Add one entry here
 *   3. Use it: withConnection('yourKey', callback)
 *   — No other file needs to change.
 *
 * Per-entry fields:
 *   user           {string}  Oracle username
 *   password       {string}  Oracle password
 *   connectString  {string}  Oracle connect string
 *   poolMin        {number}  optional — overrides global default
 *   poolMax        {number}  optional — overrides global default
 */
const connections = {
  // ── appDb — the standalone template connection (T_USERS / T_ADMINS /
  //    T_AUDIT_LOGS). This is the only connection a fresh project needs.
  //    Skipped entirely when DEMO_MODE=true (no Oracle pool is opened).
  appDb: {
    user: process.env.APP_DB_USERNAME,
    password: process.env.APP_DB_PASSWORD,
    connectString: buildSimpleConnectString(
      process.env.DB_HOST,
      process.env.DB_PORT,
      process.env.DB_APP_SERVICE_NAME,
    ),
    poolMin: parseInt(process.env.APP_POOL_MIN, 10) || 2,
    poolMax: parseInt(process.env.APP_POOL_MAX, 10) || 10,
  },

  // ── Add new connections below ──────────────────────────────────────────
  // reportingDb: {
  //     user:          process.env.RPT_DB_USERNAME,
  //     password:      process.env.RPT_DB_PASSWORD,
  //     connectString: buildSimpleConnectString(
  //         process.env.RPT_DB_HOST,
  //         process.env.RPT_DB_PORT,
  //         process.env.RPT_DB_SERVICE_NAME,
  //     ),
  //     poolMax: 10,
  // },
};

function getConnectionConfig(name) {
  const config = connections[name];
  if (!config) {
    const available = Object.keys(connections).join(", ");
    throw new Error(`Unknown connection "${name}". Registered: ${available}`);
  }
  return config;
}

function getConnectionNames() {
  return Object.keys(connections);
}

/**
 * Named pool keys — single source of truth for pool name strings.
 * Import this into health.route.js and any other file that references pool names
 * to avoid magic strings.
 */
const POOL_NAMES = Object.freeze(Object.keys(connections));

module.exports = {
  connections,
  getConnectionConfig,
  getConnectionNames,
  POOL_NAMES,
  // isDevelopment,
  buildSimpleConnectString,
  buildTNSConnectString,
};
