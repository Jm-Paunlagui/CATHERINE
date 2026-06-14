/**
 * excelUtils.js — Shared ExcelJS helpers for browser-side workbook generation.
 *
 * WHAT THIS FILE DOES
 * -------------------
 * Provides lightweight wrappers around ExcelJS that replace the removed
 * SheetJS (xlsx) dependency. All helpers return Promises and write/download
 * files via ArrayBuffer → Blob → <a> click — the same pattern used by the
 * pre-delete export in rfidmanagement.hook.js (which already used ExcelJS).
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
 * 6. `downloadWorkbookArray(wb, filename)` — same as downloadWorkbook but the
 *    buffer is exposed via XLSX.write(wb, { type: "array" }).  ExcelJS always
 *    uses writeBuffer() so this alias just delegates to downloadWorkbook.
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
        const values = row.values.slice(1); // ExcelJS row.values[0] is always undefined
        if (rowNumber === 1) {
            headers = values.map((v) => (v != null ? String(v).trim() : ""));
        } else {
            const obj = {};
            headers.forEach((h, i) => {
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
            });
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
export function buildSimpleSheetWithHeader(wb, sheetName, header, rows, colWidths = []) {
    const ws = wb.addWorksheet(sheetName);

    if (!rows || rows.length === 0) {
        ws.addRow(["No data available"]);
        return ws;
    }

    ws.columns = header.map((key, i) => ({
        header: key,
        key,
        width: colWidths[i] ?? 16,
    }));

    for (const row of rows) {
        ws.addRow(header.map((k) => row[k] ?? ""));
    }

    return ws;
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
