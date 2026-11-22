

/**
 * @fileoverview General database operation log messages.
 * Used ONLY in logger calls — never thrown or sent to clients.
 */

const databaseMessages = {
  DB_OP_FAILED: (operation: unknown, table: unknown, err: unknown) =>
    `Database operation failed: ${operation} on ${table} — ${err}`,
  CONNECTION_TIMEOUT: (name: unknown, ms: unknown) =>
    `Connection timeout on "${name}" after ${ms}ms.`,
  CONNECTION_ACQUIRED: (name: unknown, ms: unknown) =>
    `Connection acquired on "${name}" in ${ms}ms.`,
  TRANSACTION_STARTED: (name: unknown) => `Transaction started on "${name}".`,
  TRANSACTION_COMMITTED: (name: unknown, ms: unknown) =>
    `Transaction committed on "${name}" in ${ms}ms.`,
  TRANSACTION_ROLLED_BACK: (name: unknown, reason: unknown) =>
    `Transaction rolled back on "${name}": ${reason}`,
  DB_TZ_OFFSET_INVALID: (raw: unknown, fallback: unknown) =>
    `DB_TIMEZONE_OFFSET_MINUTES="${raw}" is not a whole number of minutes between -720 and 840 — using ${fallback}.`,
  DB_CLOCK_OFFSET_MISMATCH: (dbMin: number, configuredMin: number, appMin: number) =>
    `Oracle server clock is UTC${fmtOffset(dbMin)} but DB_TIMEZONE_OFFSET_MINUTES says UTC${fmtOffset(configuredMin)} ` +
    `(app process UTC${fmtOffset(appMin)}). Columns stamped by the database (DEFAULT SYSTIMESTAMP, e.g. Alert History "Created") ` +
    `will show the wrong time. Set the database server's time zone to match, or correct DB_TIMEZONE_OFFSET_MINUTES.`,
  DB_CLOCK_OFFSET_CHECK_FAILED: (err: unknown) =>
    `Could not read the Oracle server clock offset at start-up: ${err}`,
};

/** @param {number} min @returns {string} e.g. "+08:00" */
function fmtOffset(min: number): string {
  const sign = min < 0 ? "-" : "+";
  const abs = Math.abs(min);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export { databaseMessages };
