"use strict";

/**
 * DB helpers for test seed/teardown.
 *
 * These are stubs — actual implementations require a live Oracle DB connection.
 * When a DB connection is available, these helpers can seed test tables
 * and clean them up after test runs.
 */

/**
 * Seed a scratch table with test data.
 * @param {string} tableName - The table to seed
 * @param {Object[]} rows - Array of row objects to insert
 * @returns {Promise<void>}
 */
async function seedTable(_tableName, _rows) {
  // Stub: requires live DB connection
  // const db = require('../../src/config');
  // await db.withConnection('appDb', async (conn) => { ... });
}

/**
 * Truncate a scratch table.
 * @param {string} tableName - The table to truncate
 * @returns {Promise<void>}
 */
async function truncateTable(_tableName) {
  // Stub: requires live DB connection
}

module.exports = { seedTable, truncateTable };
