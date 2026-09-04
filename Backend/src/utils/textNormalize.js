"use strict";

/**
 * ============================================================================
 * WHAT THIS FILE DOES
 * ============================================================================
 * Folds typographic characters that a SINGLE-BYTE Oracle character set cannot
 * store down to their exact ASCII equivalents, before the value is hashed or
 * persisted — and reports anything that still cannot be encoded so it is never
 * silently corrupted.
 *
 * ============================================================================
 * ⚠ READ THIS BEFORE USING — DO YOU EVEN NEED IT?
 * ============================================================================
 * This template ships its sample schema (`sql/01_schema.sql`) with NO explicit
 * CHARACTERSET clause, so it inherits the database default. On any modern Oracle
 * install that default is:
 *
 *     NLS_CHARACTERSET = AL32UTF8    (full Unicode, multi-byte)
 *
 * If your database is AL32UTF8 you almost certainly DO NOT NEED THIS FILE. UTF-8
 * stores em-dashes, curly quotes, ellipses, currency signs, and every non-Latin
 * script natively; folding them would DESTROY information for no benefit. Confirm
 * with:
 *
 *     SELECT value FROM nls_database_parameters
 *      WHERE parameter = 'NLS_CHARACTERSET';
 *
 * This utility exists for the OPPOSITE case — a legacy or regionally-mandated
 * single-byte character set such as `WE8ISO8859P15` (Latin-9). Latin-9 carries
 * `ñ`, `é`, `ü`, `€` natively but has NO code point for the em-dash, en-dash,
 * curly quotes, ellipsis, or many currency symbols. Oracle does not raise
 * ORA-12899 for those; it SILENTLY substitutes an inverted question mark, which
 * is strictly worse than an error because nothing anywhere reports it. Source
 * code written with em-dashes and curly quotes in its own message templates is
 * the usual culprit — the corruption comes from the app, not the user.
 *
 * ============================================================================
 * WHY FOLDING IS HONEST HERE (and why it would NOT generalise)
 * ============================================================================
 * Every character in the map below has an EXACT ASCII equivalent: `—` and `-`
 * mean the same thing; `’` and `'` mean the same thing. Folding loses
 * typography, not information.
 *
 * ⚠ That reasoning does NOT generalise. If your system needs to store genuinely
 * non-Latin-9 text — Chinese, Japanese, Korean, Arabic, Cyrillic names — folding
 * becomes DATA DESTRUCTION and the correct fix is migrating the database to
 * AL32UTF8 (or moving those columns to NVARCHAR2, which `AL16UTF16` already
 * backs). Re-read this block before extending the map to cover a new script;
 * extending it is almost certainly the wrong answer.
 *
 * ============================================================================
 * WHERE TO CALL IT
 * ============================================================================
 * At the point prose is authored or validated — before the value is hashed, and
 * before it is bound. Concretely: inside a service's free-text validator, or at
 * a model insert for a column that receives internal prose.
 *
 * ⚠ NOT as blanket request-body middleware. Applying it to whole request bodies
 * silently alters values callers did not ask to change, and it would have to
 * special-case passwords and tokens (folding a credential changes it — CWE-287).
 * Fold where prose enters, not everywhere.
 *
 * ⚠ NEVER normalise at the bind layer if a row's integrity signature is computed
 * in JS from the field values BEFORE the insert. Fold at bind time and the stored
 * value would differ from the value that was hashed, so the row would verify as
 * TAMPERED — indistinguishable from a real attack. Fold before you sign, not
 * after.
 *
 * ============================================================================
 * EXAMPLE
 * ============================================================================
 *   normalizeText("Building — 2nd Floor")  // -> "Building - 2nd Floor"
 *   normalizeText("one’s locker")          // -> "one's locker"
 *   normalizeText("Peña Hall")             // -> "Peña Hall"   (ñ is Latin-9)
 *   findUnencodable("Grüße 日本")           // -> ["日", "本"]
 */

/**
 * Typographic characters with an exact ASCII equivalent, none of which exist in
 * WE8ISO8859P15. Ordered by how often they tend to appear in message templates
 * and in Word-pasted operator input.
 *
 * @type {ReadonlyMap<string, string>}
 */
const FOLD_MAP = new Map([
    ["—", "-"],     // — em dash        (common in hand-authored templates)
    ["–", "-"],     // – en dash        (Word auto-substitutes for "-")
    ["‒", "-"],     // ‒ figure dash
    ["―", "-"],     // ― horizontal bar
    ["−", "-"],     // − minus sign
    ["‘", "'"],     // ‘ left single quote
    ["’", "'"],     // ’ right single quote  (Word's apostrophe)
    ["‚", "'"],     // ‚ single low quote
    ["‛", "'"],     // ‛ single high-reversed
    ["′", "'"],     // ′ prime
    ["“", '"'],     // “ left double quote
    ["”", '"'],     // ” right double quote
    ["„", '"'],     // „ double low quote
    ["″", '"'],     // ″ double prime
    ["…", "..."],   // … ellipsis
    ["•", "*"],     // • bullet
    ["·", "*"],     // · middle dot (IS Latin-9, folded for consistency)
    ["→", "->"],    // → rightwards arrow (appears in log prose)
    ["←", "<-"],    // ← leftwards arrow
    [" ", " "],     // NBSP -> plain space (Latin-9 has it, but it breaks
    //                       string equality and trim() in subtle ways)
]);

/**
 * Code points present in ISO-8859-1 but REPLACED in ISO-8859-15.
 * Latin-9 reassigns eight positions; these eight Latin-1 characters are
 * therefore NOT encodable there.
 * @type {ReadonlySet<string>}
 */
const NOT_IN_LATIN9 = new Set([
    "¤", // ¤ currency sign  -> replaced by €
    "¦", // ¦ broken bar     -> replaced by Š
    "¨", // ¨ diaeresis      -> replaced by š
    "´", // ´ acute accent   -> replaced by Ž
    "¸", // ¸ cedilla        -> replaced by ž
    "¼", // ¼                -> replaced by Œ
    "½", // ½                -> replaced by œ
    "¾", // ¾                -> replaced by Ÿ
]);

/** The eight characters Latin-9 adds on top of Latin-1. */
const LATIN9_ADDITIONS = new Set(["€", "Š", "š", "Ž", "ž", "Œ", "œ", "Ÿ"]);

/**
 * True when `ch` can be stored in a WE8ISO8859P15 column.
 *
 * @param {string} ch - A single character.
 * @returns {boolean}
 */
function isLatin9Encodable(ch) {
    if (LATIN9_ADDITIONS.has(ch)) return true;
    if (NOT_IN_LATIN9.has(ch)) return false;
    return ch.codePointAt(0) <= 0xff;
}

/**
 * Folds unstorable typographic characters to their ASCII equivalents.
 *
 * Non-string input is returned untouched, so this is safe to map over mixed
 * payloads without type-guarding at every call site.
 *
 * Time O(n), space O(n) — n = string length. Runs once per string field per
 * request; not a hot path.
 *
 * @param {*} value - Any value; only strings are transformed.
 * @returns {*} The folded string, or `value` unchanged.
 *
 * @example
 * normalizeText("Building — 2nd Floor"); // "Building - 2nd Floor"
 */
function normalizeText(value) {
    if (typeof value !== "string" || value.length === 0) return value;

    let out = "";
    // for..of iterates by CODE POINT, so astral characters (emoji) are handled
    // as single units rather than split into surrogate halves.
    for (const ch of value) {
        const folded = FOLD_MAP.get(ch);
        out += folded !== undefined ? folded : ch;
    }
    return out;
}

/**
 * Returns the distinct characters in `value` that still cannot be stored after
 * folding. An empty array means the string is safe to persist as-is.
 *
 * This is the visibility half of the fix: folding handles the characters we know
 * how to fold, and this reports anything left over instead of letting Oracle
 * silently turn it into `¿`.
 *
 * @param {*} value - Any value; non-strings yield [].
 * @returns {string[]} Distinct unencodable characters, in first-seen order.
 *
 * @example
 * findUnencodable(normalizeText("Grüße 日本")); // ["日", "本"]
 */
function findUnencodable(value) {
    if (typeof value !== "string" || value.length === 0) return [];
    const bad = [];
    const seen = new Set();
    for (const ch of value) {
        if (!isLatin9Encodable(ch) && !seen.has(ch)) {
            seen.add(ch);
            bad.push(ch);
        }
    }
    return bad;
}

module.exports = {
    normalizeText,
    findUnencodable,
    isLatin9Encodable,
    FOLD_MAP,
};
