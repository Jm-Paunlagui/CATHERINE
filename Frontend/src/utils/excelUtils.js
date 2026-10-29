/**
 * excelUtils.js — Shared ExcelJS helpers for browser-side workbook generation.
 *
 * WHAT THIS FILE DOES
 * -------------------
 * Provides lightweight wrappers around ExcelJS that replace the removed
 * SheetJS (xlsx) dependency. All helpers return Promises and write/download
 * files via ArrayBuffer → Blob → <a> click — the same pattern used by the
 * pre-delete export in feature hooks that already used ExcelJS.
 *
 * HOW IT WORKS
 * ------------
 * 1. `parseExcelBuffer(buffer)`     — reads an ArrayBuffer from FileReader and
 *    returns the first sheet's rows as an array of plain objects keyed by the
 *    header row.  Replaces:
 *      XLSX.read(new Uint8Array(buf), { type: "array" })
 *      XLSX.utils.sheet_to_json(ws, { defval: "" })
 *
 * 2. `parseExcelBufferRaw(buffer)`  — same but returns [ headers[], ...rows[] ]
 *    (array-of-arrays), equivalent to sheet_to_json with { header: 1 }).
 *    Replaces:
 *      XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })
 *
 * 3. `buildSimpleSheet(wb, sheetName, rows, colWidths)` — adds one sheet of
 *    plain row-objects to an ExcelJS Workbook. Column widths are expressed as
 *    an array of numbers (character widths), matching the SheetJS !cols format.
 *    Replaces:
 *      XLSX.utils.json_to_sheet(rows) + ws["!cols"] = [...]
 *
 * 4. `buildSimpleSheetWithHeader(wb, sheetName, header, rows, colWidths)` —
 *    like buildSimpleSheet but writes rows in an explicit column order, matching
 *    SheetJS json_to_sheet(rows, { header }).
 *
 * 5. `downloadWorkbook(wb, filename)` — writes the workbook to an ArrayBuffer,
 *    creates a Blob, and triggers a browser download via a temporary <a> element.
 *    Replaces:
 *      XLSX.writeFile(wb, filename)
 *
 * 6. `parseExcelBufferSafe(buffer, { textColumns })` — like parseExcelBuffer,
 *    but designated `textColumns` (e.g. credential columns such as ACCOUNT_NO,
 *    USERNAME) are NEVER coerced to a JS number. A number cell
 *    beyond Number.MAX_SAFE_INTEGER, or a string cell already collapsed into
 *    scientific notation by a prior Excel round-trip, is kept verbatim as a
 *    string AND recorded as a precision warning so the caller can surface it
 *    to the user without blocking the upload (any server-side guard is
 *    authoritative).
 *
 * 7. `buildTextSafeSheet(wb, sheetName, header, rows, { textColumns, colWidths })` —
 *    like buildSimpleSheetWithHeader, but `textColumns` cells get `numFmt: "@"`
 *    and their values are String()-coerced, so Excel stores and displays them
 *    as text instead of rounding/reformatting long digit strings.
 *
 * 8. `buildCsvContent(header, rows, { textColumns })` — builds a UTF-8-BOM,
 *    CRLF, RFC-4180-quoted CSV string. `textColumns` values are written
 *    verbatim (CSV has no per-cell number format, so nothing is rounded at
 *    the file-content level — only Excel's own "open as CSV" import step can
 *    re-mangle long digits, which is a documented Excel limitation, not a
 *    defect in this file). Includes a CWE-1236 formula-injection guard.
 *
 * SECURITY NOTE
 * -------------
 * ExcelJS does not carry the prototype-pollution vulnerabilities present in
 * xlsx@0.18.5 (CVE-2023-30533, CVE-2024-22363).  The backend already validates
 * magic bytes (CWE-434) before any server-side parsing occurs.  Client-side
 * parsing here is for UX preview only; the server re-validates on submit.
 */

import ExcelJS from "exceljs";

// ── Parsing helpers ────────────────────────────────────────────────────────────

/**
 * Reads an ArrayBuffer (from FileReader) and returns the first worksheet's
 * rows as plain objects keyed by the header row.
 *
 * Empty cells are coerced to "".
 *
 * @param {ArrayBuffer} buffer - Raw file bytes from FileReader.onload
 * @returns {Promise<Array<object>>} Parsed rows (first row used as headers)
 */
export async function parseExcelBuffer(buffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);

    const ws = wb.worksheets[0];
    if (!ws) return [];

    const rows = [];
    let headers = [];

    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) {
            // A header cell that was never written round-trips through the
            // xlsx format as a true gap (not an explicit null) — row.values
            // comes back as a SPARSE array at that index. Array.prototype.map()
            // skips holes by index rather than compacting them, which used to
            // silently drop that column's name (and therefore its entire data
            // column too, since the old code iterated the resulting sparse
            // `headers` array). Iterating by explicit numeric index instead —
            // a plain for-loop always visits every index, hole or not — fixes
            // this. A blank header cell now gets a synthesized
            // `Column_N` (1-based) key instead of silently disappearing.
            const raw = row.values;
            headers = [];
            for (let i = 1; i < raw.length; i++) {
                headers[i - 1] = raw[i] != null ? String(raw[i]).trim() : `Column_${i}`;
            }
        } else {
            const obj = {};
            for (let i = 0; i < headers.length; i++) {
                const h = headers[i];
                const cell = row.getCell(i + 1);
                // Prefer the formatted text for dates; fall back to raw value
                const raw = cell.value;
                if (raw == null) {
                    obj[h] = "";
                } else if (raw instanceof Date) {
                    obj[h] = raw;
                } else if (typeof raw === "object" && raw.richText) {
                    // Rich-text cell
                    obj[h] = raw.richText.map((r) => r.text).join("");
                } else {
                    obj[h] = raw;
                }
            }
            rows.push(obj);
        }
    });

    return rows;
}

/**
 * Reads an ArrayBuffer and returns an array-of-arrays where the first element
 * is the header row.  Equivalent to XLSX.utils.sheet_to_json(ws, { header: 1 }).
 *
 * @param {ArrayBuffer} buffer
 * @returns {Promise<Array<Array<any>>>}
 */
export async function parseExcelBufferRaw(buffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);

    const ws = wb.worksheets[0];
    if (!ws) return [];

    const result = [];
    ws.eachRow({ includeEmpty: true }, (row) => {
        result.push(row.values.slice(1)); // strip index-0 placeholder
    });
    return result;
}

/** Matches a plain (non-negative) scientific-notation number string, e.g. "1.1234E+16". */
const SCIENTIFIC_NOTATION_RE = /^\d+(\.\d+)?[eE][+-]?\d+$/;

/** Shared precision-warning issue text — kept identical across every trigger site. */
const PRECISION_WARNING_ISSUE = "stored as a number in Excel and may have been rounded — format the column as Text and re-enter the value";

/**
 * Reads an ArrayBuffer and returns the first worksheet's rows as plain objects
 * keyed by the header row — identical to {@link parseExcelBuffer} — EXCEPT
 * that any column named in `textColumns` is treated as precision-sensitive
 * text rather than a number:
 *
 *   - A string cell is kept verbatim (trimmed).
 *   - A number cell is converted with `String()`; if it is not a
 *     `Number.isSafeInteger` value (i.e. it may already have lost precision
 *     in Excel, beyond ±2^53-1) a warning is recorded.
 *   - A string cell that already looks like scientific notation (a sign that
 *     Excel round-tripped it through a number format previously) is kept
 *     verbatim AND recorded as a warning.
 *   - A rich-text cell's runs are joined into plain text, then the same
 *     scientific-notation check applies.
 *
 * Columns NOT in `textColumns` behave exactly like {@link parseExcelBuffer}.
 *
 * Time/space: O(rows × columns) — a single pass over every cell, same as
 * parseExcelBuffer; no additional passes.
 *
 * @param {ArrayBuffer} buffer - Raw file bytes from FileReader.onload
 * @param {object}      [options]
 * @param {string[]}    [options.textColumns=[]] - Header names to preserve as
 *   exact text (e.g. ["USERNAME", "ACCOUNT_NO"]).
 * @returns {Promise<{
 *   rows: Array<object>,
 *   warnings: Array<{ rowNumber: number, column: string, issue: string }>,
 * }>}
 *
 * @example
 * const { rows, warnings } = await parseExcelBufferSafe(buffer, {
 *   textColumns: ["USERNAME", "ACCOUNT_NO"],
 * });
 * if (warnings.length) showPrecisionBanner(warnings);
 */
export async function parseExcelBufferSafe(buffer, { textColumns = [] } = {}) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);

    const ws = wb.worksheets[0];
    if (!ws) return { rows: [], warnings: [] };

    const textColumnSet = new Set(textColumns);
    const rows = [];
    const warnings = [];
    let headers = [];

    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) {
            // Same blank-header synthesis as parseExcelBuffer.
            const raw = row.values;
            headers = [];
            for (let i = 1; i < raw.length; i++) {
                headers[i - 1] = raw[i] != null ? String(raw[i]).trim() : `Column_${i}`;
            }
        } else {
            const obj = {};
            for (let i = 0; i < headers.length; i++) {
                const h = headers[i];
                const cell = row.getCell(i + 1);
                const raw = cell.value;
                const isTextColumn = textColumnSet.has(h);

                if (raw == null) {
                    obj[h] = "";
                    continue;
                }

                if (raw instanceof Date) {
                    obj[h] = raw;
                    continue;
                }

                if (typeof raw === "object" && raw.richText) {
                    const joined = raw.richText.map((r) => r.text).join("");
                    if (isTextColumn) {
                        const trimmed = joined.trim();
                        if (SCIENTIFIC_NOTATION_RE.test(trimmed)) {
                            warnings.push({ rowNumber, column: h, issue: PRECISION_WARNING_ISSUE });
                        }
                        obj[h] = trimmed;
                    } else {
                        obj[h] = joined;
                    }
                    continue;
                }

                if (!isTextColumn) {
                    obj[h] = raw;
                    continue;
                }

                // ── textColumns: never hand back a JS number for these ─────────
                if (typeof raw === "number") {
                    obj[h] = String(raw);
                    if (!Number.isSafeInteger(raw)) {
                        warnings.push({ rowNumber, column: h, issue: PRECISION_WARNING_ISSUE });
                    }
                    continue;
                }

                const strVal = String(raw).trim();
                obj[h] = strVal;
                if (SCIENTIFIC_NOTATION_RE.test(strVal)) {
                    warnings.push({ rowNumber, column: h, issue: PRECISION_WARNING_ISSUE });
                }
            }
            rows.push(obj);
        }
    });

    return { rows, warnings };
}

// ── Generation helpers ─────────────────────────────────────────────────────────

/**
 * Adds a worksheet to an ExcelJS Workbook from an array of plain objects.
 * Column keys are inferred from the first row's own enumerable keys.
 *
 * @param {ExcelJS.Workbook} wb
 * @param {string} sheetName
 * @param {Array<object>} rows
 * @param {number[]} [colWidths=[]] - Column character-widths (same order as keys)
 * @returns {ExcelJS.Worksheet}
 */
export function buildSimpleSheet(wb, sheetName, rows, colWidths = []) {
    const ws = wb.addWorksheet(sheetName);

    if (!rows || rows.length === 0) {
        ws.addRow(["No data available"]);
        return ws;
    }

    const keys = Object.keys(rows[0]);
    ws.columns = keys.map((key, i) => ({
        header: key,
        key,
        width: colWidths[i] ?? 16,
    }));

    for (const row of rows) {
        ws.addRow(keys.map((k) => row[k] ?? ""));
    }

    return ws;
}

/**
 * Adds a worksheet with an explicit column order.
 * Equivalent to XLSX.utils.json_to_sheet(rows, { header }).
 *
 * @param {ExcelJS.Workbook} wb
 * @param {string} sheetName
 * @param {string[]} header       - Ordered column keys (also used as header labels)
 * @param {Array<object>} rows
 * @param {number[]} [colWidths=[]]
 * @returns {ExcelJS.Worksheet}
 */
/** Symbol-free money format. Kept byte-identical to the backend's
 *  excelFormat.js MONEY_FMT so a figure looks the same whichever side wrote
 *  the workbook; the column header carries the currency. */
export const MONEY_FMT = "#,##0.00;[Red]-#,##0.00";

export function buildSimpleSheetWithHeader(
    wb,
    sheetName,
    header,
    rows,
    colWidths = [],
    opts = {},
) {
    const ws = wb.addWorksheet(sheetName);

    if (!rows || rows.length === 0) {
        ws.addRow(["No data available"]);
        return ws;
    }

    // `labels` lets a caller print human headers ("Created At") instead of the
    // raw field key ("CREATED_AT"). Defaults to the keys, so every
    // existing caller is unchanged.
    const labels = opts.labels ?? header;
    // Money columns get a money format and stay real NUMBERS, so Excel can still
    // sum them. Without this a currency column exports as a bare figure with no
    // unit — the same defect excelFormat.js fixed on the backend.
    const moneyKeys = new Set(opts.moneyKeys ?? []);

    ws.columns = header.map((key, i) => ({
        header: labels[i] ?? key,
        key,
        width: colWidths[i] ?? 16,
    }));

    for (const row of rows) {
        const added = ws.addRow(header.map((k) => row[k] ?? ""));
        for (const k of moneyKeys) {
            if (!header.includes(k)) continue;
            const cell = added.getCell(k);
            if (typeof cell.value === "number") cell.numFmt = MONEY_FMT;
        }
    }

    return ws;
}

/**
 * Adds a worksheet with an explicit column order, like
 * {@link buildSimpleSheetWithHeader}, but every column named in
 * `textColumns` is written as Excel Text (`numFmt: "@"`) with its value
 * String()-coerced.
 * Prevents Excel from displaying a long credential (ACCOUNT_NO, a long numeric USERNAME)
 * in scientific notation or rounding it beyond 15 significant digits.
 *
 * @param {ExcelJS.Workbook} wb
 * @param {string}           sheetName
 * @param {string[]}         header                  - Ordered column keys (also header labels)
 * @param {Array<object>}    rows
 * @param {object}           [options]
 * @param {string[]}         [options.textColumns=[]] - Header names to force to Text format
 * @param {number[]}         [options.colWidths=[]]
 * @returns {ExcelJS.Worksheet}
 *
 * @example
 * buildTextSafeSheet(wb, "Accounts", header, rows, {
 *   textColumns: ["ACCOUNT_NO", "USERNAME"],
 * });
 */
export function buildTextSafeSheet(wb, sheetName, header, rows, { textColumns = [], colWidths = [] } = {}) {
    const ws = wb.addWorksheet(sheetName);

    if (!rows || rows.length === 0) {
        ws.addRow(["No data available"]);
        return ws;
    }

    const textColumnSet = new Set(textColumns);

    ws.columns = header.map((key, i) => ({
        header: key,
        key,
        width: colWidths[i] ?? 16,
        // numFmt '@' forces the entire column to Text — the lossless boundary.
        style: textColumnSet.has(key) ? { numFmt: "@" } : {},
    }));

    for (const row of rows) {
        ws.addRow(
            header.map((k) => {
                const val = row[k] ?? "";
                return textColumnSet.has(k) ? String(val) : val;
            }),
        );
    }

    return ws;
}

// ── CSV helper ─────────────────────────────────────────────────────────────────

/** Matches a field that would be interpreted as a formula by a spreadsheet importer (CWE-1236). */
const FORMULA_INJECTION_RE = /^[=+\-@]/;

/** A field consisting solely of digits (e.g. a credential value) is never formula-dangerous. */
const PURE_DIGITS_RE = /^[0-9]+$/;

/**
 * Escapes one CSV field per RFC 4180 and guards against CSV/formula injection.
 *
 * @param {*} value
 * @returns {string}
 * @private
 */
function _escapeCsvField(value) {
    let str = String(value ?? "");

    // CWE-1236: a field that opens with =, +, -, or @ can execute as a formula
    // when the file is opened in Excel/Sheets/LibreOffice. Prefix with a
    // literal apostrophe to force text interpretation — UNLESS the field is
    // purely digits (a credential value can never be a formula trigger).
    if (FORMULA_INJECTION_RE.test(str) && !PURE_DIGITS_RE.test(str)) {
        str = `'${str}`;
    }

    // RFC 4180: quote the field when it contains a comma, double quote, or
    // line break; double any embedded double quotes.
    if (/["\r\n,]/.test(str)) {
        str = `"${str.replace(/"/g, '""')}"`;
    }

    return str;
}

/**
 * Builds a UTF-8 (with BOM), CRLF-terminated, RFC-4180-quoted CSV string from
 * a header array and row objects. Every value is written EXACTLY as given —
 * no reformatting, no locale-aware number formatting — because a plain CSV
 * cell has no per-column format metadata to lose precision through in the
 * first place (unlike an .xlsx cell, which can silently become a `Number`).
 *
 * `textColumns` is accepted for signature symmetry with
 * {@link buildTextSafeSheet} but is a no-op here: since CSV values are
 * always written as plain text, there is nothing extra to force for those
 * columns. NOTE: Excel's own "open a .csv" import step MAY still re-display
 * a long digit string in scientific notation — that happens at import time,
 * on Excel's side, and does not change the file's actual byte content. Users
 * who need to open the export directly in Excel without that cosmetic effect
 * should use the Excel (.xlsx) export instead.
 *
 * Time/space: O(rows × columns) — one pass building an array of strings,
 * joined once at the end.
 *
 * @param {string[]}      header
 * @param {Array<object>} rows
 * @param {object}        [options]
 * @param {string[]}      [options.textColumns=[]] - Unused (see note above); kept for API symmetry.
 * @returns {string}
 *
 * @example
 * const csv = buildCsvContent(["ACCOUNT_NO", "USERNAME"], rows, { textColumns: ["ACCOUNT_NO"] });
 * const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
 */
export function buildCsvContent(header, rows, { textColumns = [] } = {}) {
    void textColumns; // intentionally unused — see JSDoc note above

    const lines = [header.map((h) => _escapeCsvField(h)).join(",")];
    for (const row of rows ?? []) {
        lines.push(header.map((k) => _escapeCsvField(row[k] ?? "")).join(","));
    }

    const BOM = String.fromCharCode(0xfeff);
    return BOM + lines.join("\r\n");
}

// ── Download helper ────────────────────────────────────────────────────────────

/**
 * Serialises an ExcelJS Workbook to an ArrayBuffer and triggers a browser
 * download via a temporary <a> element.
 *
 * @param {ExcelJS.Workbook} wb
 * @param {string} filename - Target file name (e.g. "report_2025-06-10.xlsx")
 * @returns {Promise<void>}
 */
export async function downloadWorkbook(wb, filename) {
    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}

/**
 * Triggers a browser download for an already-built Blob via a temporary
 * <a> element. The non-workbook counterpart of {@link downloadWorkbook} —
 * used for CSV and for pre-serialised .xlsx blobs.
 *
 * @param {Blob}   blob
 * @param {string} filename - Target file name (e.g. "pay_periods_2026-07-25.csv")
 * @returns {void}
 */
export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}

/**
 * One-call "Export to Excel / Export to CSV" for a table view.
 *
 * Every export surface in the app (RED metrics, Data Integrity, and a
 * project's own table views) funnels through this so the two formats can never
 * drift apart per feature: same column order, same text-safe credential
 * columns, same date-stamped filename.
 *
 * `.xlsx` goes through {@link buildTextSafeSheet} so credential-like columns
 * keep every digit (Excel would otherwise render a 16-digit account number in
 * scientific notation); `.csv` goes through {@link buildCsvContent}, which is
 * already lossless and formula-injection safe (CWE-1236).
 *
 * @param {object}          params
 * @param {'xlsx'|'csv'}    params.format          - Which file to produce
 * @param {string[]}        params.header          - Ordered column keys (also the header labels)
 * @param {Array<object>}   params.rows            - Row objects keyed by `header` entries
 * @param {string}          params.filenameBase    - Filename without date or extension (e.g. "audit_logs")
 * @param {string}          [params.sheetName]     - Worksheet name for .xlsx (defaults to filenameBase)
 * @param {string[]}        [params.textColumns=[]] - Columns to force to Excel Text format
 * @param {number[]}        [params.colWidths=[]]
 * @returns {Promise<void>}
 *
 * @example
 * await exportRowsToFile({
 *   format: "xlsx",
 *   header: ["USERNAME", "FULL_NAME"],
 *   rows,
 *   filenameBase: "accounts",
 *   sheetName: "Accounts",
 *   textColumns: ["USERNAME"],
 * });
 */
export async function exportRowsToFile({ format, header, rows, filenameBase, sheetName, textColumns = [], colWidths = [] }) {
    const today = new Date().toISOString().slice(0, 10);

    if (format === "csv") {
        const csv = buildCsvContent(header, rows, { textColumns });
        downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${filenameBase}_${today}.csv`);
        return;
    }

    const wb = new ExcelJS.Workbook();
    buildTextSafeSheet(wb, sheetName ?? filenameBase, header, rows, { textColumns, colWidths });
    await downloadWorkbook(wb, `${filenameBase}_${today}.xlsx`);
}
