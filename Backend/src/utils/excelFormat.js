"use strict";

/**
 * @fileoverview ONE money/date presentation layer for every ExcelJS workbook
 * this API produces (audit exports, table-dump "readable" backups, and any
 * money/report feature a project builds on top of this template).
 *
 * WHY THIS FILE EXISTS — two export defects that recur whenever date/money
 * formatting is copy-pasted per service instead of centralised in one helper:
 *
 * 1. **Dates exported a day early, with the time silently dropped.** ExcelJS
 *    converts a JS `Date` to an Excel serial with
 *    `25569 + d.getTime() / 86400000` (`exceljs/lib/utils/utils.js`) — a pure
 *    **UTC** epoch calculation. node-oracledb builds `DATE`/`TIMESTAMP` values
 *    as JS `Date`s from the raw stored wall-clock fields interpreted in the
 *    **process's local zone**. Those two conventions disagree by exactly the
 *    UTC offset, so a value stored `08/17/2026 06:01:11 AM` was written into the
 *    workbook as `08/16/2026 10:01:11 PM` — and because ExcelJS also defaults an
 *    unstyled date cell to numFmt `mm-dd-yy` (`styles-xform.js`), the reader saw
 *    only `8/16/2026`: a date that is wrong AND missing the time that would have
 *    made the shift obvious. {@link toExcelDate} pre-shifts by the value's own
 *    `getTimezoneOffset()` so ExcelJS's UTC arithmetic lands back on the stored
 *    wall clock. It is zone-agnostic and DST-correct (the offset is read at that
 *    instant), unlike a fixed offset constant, which is only right while the
 *    process happens to run at one particular UTC offset.
 *
 * 2. **Money exported without a consistent format.** When each service carries
 *    its own private `MONEY_FMT` string, the same figures render three different
 *    ways across three sheets. {@link MONEY_FMT} / {@link makeMoneyFmt} is the
 *    one definition.
 *
 * ⚠ CURRENCY IS DELIBERATELY NOT HARD-CODED. This template's money capability is
 * multi-currency and stores figures as raw numbers with NO embedded currency
 * symbol, so the default {@link MONEY_FMT} is symbol-free (`#,##0.00`). When a
 * report knows its currency, build a symbol-bearing format with
 * {@link makeMoneyFmt} (e.g. `makeMoneyFmt("$")`) rather than editing this file.
 *
 * THE RULE: never write a raw `Date` into a cell and never hand-roll a money
 * number format. Use {@link setDateTimeCell} / {@link setDateCell} /
 * {@link setMoneyCell}, or {@link toExcelDate} + a `*_FMT` constant when the
 * cell is being built through `sheet.addRow(...)`.
 */

/**
 * Symbol-free money format — the default money numFmt for every workbook.
 * Negatives render in red with a leading minus so a credit is never mistaken
 * for a debit at a glance. For a currency-bearing format, use
 * {@link makeMoneyFmt}.
 * @type {string}
 */
const MONEY_FMT = "#,##0.00;[Red]-#,##0.00";

/**
 * Builds a money numFmt that prefixes `symbol` (e.g. `"$"`, `"€"`, `"£"`).
 * Negatives render in red with a leading minus. Pass no symbol to get the
 * symbol-free {@link MONEY_FMT}.
 * @param {string} [symbol=""] Currency symbol to prefix (already a valid
 *   character in the target Excel locale).
 * @returns {string}
 * @example
 * makeMoneyFmt("$"); // '"$"#,##0.00;[Red]-"$"#,##0.00'
 */
function makeMoneyFmt(symbol = "") {
    const s = symbol ? `"${symbol}"` : "";
    return `${s}#,##0.00;[Red]-${s}#,##0.00`;
}

/**
 * Full date + 12-hour time, matching how Oracle SQL Developer renders a
 * `DATE`/`TIMESTAMP` column (`08/17/2026 06:01:11 AM`) so an exported row can
 * be diffed against the database by eye.
 * @type {string}
 */
const DATETIME_FMT = "mm/dd/yyyy hh:mm:ss AM/PM";

/** Calendar-date-only format, for columns the business treats as a pure date. */
const DATE_FMT = "mm/dd/yyyy";

/** Column width that fits `08/17/2026 06:01:11 AM` without `#####`. */
const DATETIME_COL_WIDTH = 24;

/**
 * Re-bases a date so ExcelJS's UTC-based serial conversion reproduces the
 * value's LOCAL wall clock — the thing the database actually stores and the
 * thing every other consumer (the UI, SQL Developer) displays.
 *
 * Returns `null` for null/empty/unparseable input so a missing timestamp
 * leaves a genuinely empty cell rather than `12/30/1899`.
 *
 * ⚠ The returned Date is a PRESENTATION artefact: its epoch value is
 * deliberately wrong by the UTC offset. Never feed it back into business
 * logic, a hash payload, or a DB write — only into a workbook cell.
 *
 * @param {Date|string|number|null|undefined} value
 * @returns {Date|null}
 * @example
 * // stored 2026-08-17 06:01:11 (local zone)
 * toExcelDate(row.TRANS_DATETIME); // renders as 08/17/2026 06:01:11 AM
 */
function toExcelDate(value) {
    if (value === null || value === undefined || value === "") return null;
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
}

/**
 * Writes one date+time cell (value + {@link DATETIME_FMT}).
 * @param {import('exceljs').Cell} cell
 * @param {Date|string|number|null|undefined} value
 * @returns {void}
 */
function setDateTimeCell(cell, value) {
    const d = toExcelDate(value);
    cell.value = d;
    if (d) cell.numFmt = DATETIME_FMT;
}

/**
 * Writes one calendar-date cell (value + {@link DATE_FMT}).
 * @param {import('exceljs').Cell} cell
 * @param {Date|string|number|null|undefined} value
 * @returns {void}
 */
function setDateCell(cell, value) {
    const d = toExcelDate(value);
    cell.value = d;
    if (d) cell.numFmt = DATE_FMT;
}

/**
 * Writes one money cell (numeric value + a money numFmt). The value stays a
 * real number — never a pre-formatted string — so Excel can still sum it.
 * @param {import('exceljs').Cell} cell
 * @param {number|string|null|undefined} value
 * @param {string} [numFmt=MONEY_FMT] Number format; pass
 *   `makeMoneyFmt("$")` for a currency-bearing cell.
 * @returns {void}
 */
function setMoneyCell(cell, value, numFmt = MONEY_FMT) {
    const n = Number(value ?? 0);
    cell.value = Number.isFinite(n) ? n : 0;
    cell.numFmt = numFmt;
}

/**
 * Money TEXT, for the places a figure is embedded in a sentence (a sheet's
 * "Grand Total: …" footer) rather than occupying its own numeric cell.
 * @param {number|string|null|undefined} value
 * @param {string} [symbol=""] Optional currency symbol to prefix.
 * @returns {string} e.g. `"1,234.50"` or `"$1,234.50"`
 */
function formatMoneyText(value, symbol = "") {
    const n = Number(value ?? 0);
    return `${symbol}${(Number.isFinite(n) ? n : 0).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    })}`;
}

/**
 * Date+time TEXT in the same shape as {@link DATETIME_FMT}, for header/banner
 * lines that are prose rather than data cells. Built from LOCAL getters — a raw
 * `new Date().toISOString()` is UTC and would be hours behind what the
 * operator's clock said when they clicked Export.
 * @param {Date|string|number|null|undefined} value
 * @returns {string} e.g. `"08/17/2026 06:01:11 AM"`, or `"-"` when absent
 */
function formatDateTimeText(value) {
    if (value === null || value === undefined || value === "") return "-";
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return "-";
    const pad = (n) => String(n).padStart(2, "0");
    const hr24 = d.getHours();
    return (
        `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} ` +
        `${pad(hr24 % 12 || 12)}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ` +
        `${hr24 < 12 ? "AM" : "PM"}`
    );
}

/**
 * Generic-dump helper for workbooks that mirror arbitrary table rows and
 * therefore cannot name their date columns up front (the "readable" backup
 * copies). Returns a shallow copy with every `Date` value re-based via
 * {@link toExcelDate}, plus the keys that were re-based so the caller can stamp
 * {@link DATETIME_FMT} on exactly those columns.
 *
 * @param {Record<string, *>} row
 * @returns {{ row: Record<string, *>, dateKeys: string[] }}
 */
function normalizeRowDates(row) {
    const out = {};
    const dateKeys = [];
    for (const [key, value] of Object.entries(row ?? {})) {
        if (value instanceof Date) {
            out[key] = toExcelDate(value);
            dateKeys.push(key);
        } else {
            out[key] = value;
        }
    }
    return { row: out, dateKeys };
}

/**
 * `sheet.addRow(row)` for a generic table dump: re-bases every `Date` value
 * with {@link toExcelDate}, stamps {@link DATETIME_FMT} on the cells that
 * received one, and widens those columns so the timestamp is not clipped to
 * `#####`. Column keys are never looked up by name (a dump's columns come from
 * the FIRST row, and a later row may carry a key that sheet never declared) —
 * the pass is by cell position.
 *
 * @param {import('exceljs').Worksheet} sheet
 * @param {Record<string, *>} rowData
 * @returns {import('exceljs').Row}
 */
function addNormalizedRow(sheet, rowData) {
    const added = sheet.addRow(normalizeRowDates(rowData).row);
    added.eachCell((cell, colNumber) => {
        if (!(cell.value instanceof Date)) return;
        cell.numFmt = DATETIME_FMT;
        const col = sheet.getColumn(colNumber);
        if (!col.width || col.width < DATETIME_COL_WIDTH) {
            col.width = DATETIME_COL_WIDTH;
        }
    });
    return added;
}

/**
 * Registry-driven Excel number format for a currency (plan §3.3). Pulls the
 * display scale and symbol from `constants/currencies.js` so no export ever
 * hardcodes a peso/dollar format string. The symbol is presentation only — the
 * persisted value is a scale-4 number; this only decides how the cell RENDERS.
 *
 * @param {string} currencyCode - ISO 4217 code.
 * @returns {string} an ExcelJS numFmt, e.g. `'"$"#,##0.00;[Red]-"$"#,##0.00'`
 *   for USD, `'"¥"#,##0;[Red]-"¥"#,##0'` for JPY (display scale 0).
 */
function moneyFmtFor(currencyCode) {
    // Lazy require to avoid a constants<->utils load cycle.
    const { getCurrency } = require("../constants/currencies");
    const { symbol, displayScale } = getCurrency(currencyCode);
    const decimals = displayScale > 0 ? `.${"0".repeat(displayScale)}` : "";
    const body = `#,##0${decimals}`;
    const sym = symbol ? `"${symbol}"` : "";
    return `${sym}${body};[Red]-${sym}${body}`;
}

/**
 * The one-line basis stamp every money workbook carries in its header (plan
 * §3.3): which currency the figures are in, and — when values were converted —
 * the basis of that conversion. Converted values are NEVER persisted (§3.0
 * rule 4); an export that shows converted figures must therefore say so, and
 * name the as-of date the rates were taken from, so the numbers are
 * reproducible and auditable.
 *
 * @param {Object} opts
 * @param {string} opts.currencyCode - ISO 4217 code the figures are presented in.
 * @param {string} [opts.baseCurrency] - The base currency amounts are stored in,
 *   when different from the presentation currency (i.e. values were converted).
 * @param {Date|string} [opts.asOf] - The as-of date the conversion rates apply
 *   to (each row's own CREATED_AT is the true basis — this is the report-level
 *   summary). Required when a conversion took place.
 * @returns {string}
 */
function exportCurrencyBasis({ currencyCode, baseCurrency, asOf } = {}) {
    if (!currencyCode) return "Currency: (unspecified)";
    if (!baseCurrency || baseCurrency === currencyCode) {
        return `Currency: ${currencyCode} (stored, no conversion applied)`;
    }
    const when = asOf ? formatDateTimeText(asOf) : "(as-of date not supplied)";
    return `Currency: ${currencyCode} — converted from ${baseCurrency} at rates as of ${when}`;
}

module.exports = {
    MONEY_FMT,
    makeMoneyFmt,
    moneyFmtFor,
    exportCurrencyBasis,
    DATETIME_FMT,
    DATE_FMT,
    DATETIME_COL_WIDTH,
    toExcelDate,
    setDateTimeCell,
    setDateCell,
    setMoneyCell,
    formatMoneyText,
    formatDateTimeText,
    normalizeRowDates,
    addNormalizedRow,
};
