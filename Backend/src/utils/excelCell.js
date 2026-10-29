"use strict";

/**
 * @fileoverview Normalises an ExcelJS `cell.value` to a plain primitive.
 *
 * ExcelJS returns OBJECTS for every non-plain cell:
 *   formula        { formula, result }
 *   shared formula { sharedFormula, result }
 *   rich text      { richText: [{ text }, ...] }
 *   hyperlink      { text, hyperlink }
 *   error          { error: "#N/A" }
 *   date           Date
 * Passing those straight to `String(v)` yields the literal "[object Object]"
 * (CWE-20 / CWE-704: improper input validation / incorrect type conversion),
 * which would otherwise be persisted as data. Every ExcelJS upload parser
 * funnels cell values through this one pure function instead.
 *
 * Pure function (no state, no side effects) — hence a function, not a class.
 */

const MAX_DEPTH = 8; // guards pathological nested `result` chains

/**
 * @param {*} v - raw ExcelJS cell value
 * @param {number} [depth]
 * @returns {string|number|boolean|Date|null} plain primitive; never an object
 *          other than a valid Date. Unknown object shapes collapse to null.
 */
function normalizeCellValue(v, depth = 0) {
    if (v === undefined || v === null) return null;
    if (v instanceof Date) return v;
    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean") return v;
    if (t !== "object" || depth >= MAX_DEPTH) return null;

    if (Array.isArray(v.richText)) {
        return v.richText
            .map((seg) => (seg && seg.text != null ? String(seg.text) : ""))
            .join("");
    }
    if ("error" in v) return null;
    if ("formula" in v || "sharedFormula" in v) {
        return normalizeCellValue(v.result, depth + 1);
    }
    if ("hyperlink" in v || "text" in v) {
        return normalizeCellValue(v.text, depth + 1);
    }
    if ("result" in v) return normalizeCellValue(v.result, depth + 1);
    return null;
}

module.exports = { normalizeCellValue };
