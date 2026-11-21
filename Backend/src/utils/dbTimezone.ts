"use strict";

/**
 * @fileoverview The Oracle server's UTC offset in minutes, read from
 * DB_TIMEZONE_OFFSET_MINUTES. This is the ONE reader of that variable.
 *
 * Every consumer stamps or labels a time in the DB's wall-clock zone, so a bad
 * value is never harmless. A typo ("+8h") gave NaN: ARCHIVED_AT was bound as an
 * Invalid Date and every e-mail read "Invalid Date UTC-NaN:NaN". A BLANK value
 * (`DB_TIMEZONE_OFFSET_MINUTES=`) slipped past `?? 480` and `Number("")` is 0,
 * which silently moved every stamp and label to UTC, eight hours early.
 *
 * Unset or blank means the default. Anything that is not a whole number of
 * minutes inside the real-world UTC range falls back to the default, with one
 * WARNING per distinct bad value.
 */

const { logger } = require("./logger");
const { databaseMessages } = require("../constants/messages");

/** UTC+8 — Asia/Manila, the deployment zone. */
const DEFAULT_DB_TZ_OFFSET_MINUTES = 480;

/** Real-world UTC offsets run from UTC−12:00 to UTC+14:00. */
const MIN_OFFSET_MINUTES = -12 * 60;
const MAX_OFFSET_MINUTES = 14 * 60;

let _lastWarnedValue = null;

/**
 * @returns {number} DB server UTC offset in minutes (e.g. 480 for UTC+8)
 */
function dbTimezoneOffsetMinutes() {
    const raw = process.env.DB_TIMEZONE_OFFSET_MINUTES;
    if (raw === undefined || raw.trim() === "") return DEFAULT_DB_TZ_OFFSET_MINUTES;

    const minutes = Number(raw);
    if (
        Number.isInteger(minutes) &&
        minutes >= MIN_OFFSET_MINUTES &&
        minutes <= MAX_OFFSET_MINUTES
    ) {
        return minutes;
    }

    if (_lastWarnedValue !== raw) {
        _lastWarnedValue = raw;
        logger.warning(
            databaseMessages.DB_TZ_OFFSET_INVALID(raw, DEFAULT_DB_TZ_OFFSET_MINUTES),
        );
    }
    return DEFAULT_DB_TZ_OFFSET_MINUTES;
}

const CLOCK_OFFSET_SQL =
    "SELECT EXTRACT(TIMEZONE_HOUR FROM SYSTIMESTAMP) * 60 + EXTRACT(TIMEZONE_MINUTE FROM SYSTIMESTAMP) AS OFF_MIN FROM dual";

/**
 * Start-up check: compares the Oracle server's own clock offset (what
 * every `DEFAULT SYSTIMESTAMP` column is stamped in) with
 * DB_TIMEZONE_OFFSET_MINUTES and with this process's offset. A database
 * container left on UTC while the app runs on UTC+8 stores Alert History rows
 * 8 hours early, silently. Logs one WARNING on mismatch; never throws.
 *
 * @param {{ withConnection: Function, oracledb?: object }} db - src/config adapter
 * @param {{ appOffsetMinutes?: number }} [opts]
 * @returns {Promise<{ dbOffsetMinutes: number, configuredMinutes: number, appOffsetMinutes: number, match: boolean } | null>}
 *          null when the clock could not be read
 */
async function verifyDbClockOffset(db, { appOffsetMinutes = -new Date().getTimezoneOffset() } = {}) {
    try {
        const raw = await db.withConnection("appDb", async (conn) => {
            const r = await conn.execute(CLOCK_OFFSET_SQL, [], { outFormat: db.oracledb?.OUT_FORMAT_OBJECT });
            const row = r.rows?.[0];
            return Array.isArray(row) ? row[0] : row?.OFF_MIN;
        });
        const dbOffsetMinutes = raw == null || raw === "" ? NaN : Number(raw);
        if (!Number.isInteger(dbOffsetMinutes)) throw new Error(`unexpected offset value ${raw}`);
        const configuredMinutes = dbTimezoneOffsetMinutes();
        const match = dbOffsetMinutes === configuredMinutes && dbOffsetMinutes === appOffsetMinutes;
        if (!match) {
            logger.warning(
                databaseMessages.DB_CLOCK_OFFSET_MISMATCH(dbOffsetMinutes, configuredMinutes, appOffsetMinutes),
            );
        }
        return { dbOffsetMinutes, configuredMinutes, appOffsetMinutes, match };
    } catch (err) {
        logger.warning(databaseMessages.DB_CLOCK_OFFSET_CHECK_FAILED(err.message));
        return null;
    }
}

module.exports = { dbTimezoneOffsetMinutes, verifyDbClockOffset, DEFAULT_DB_TZ_OFFSET_MINUTES };
