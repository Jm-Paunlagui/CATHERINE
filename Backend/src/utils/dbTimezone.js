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

module.exports = { dbTimezoneOffsetMinutes, DEFAULT_DB_TZ_OFFSET_MINUTES };
