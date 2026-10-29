"use strict";

/**
 * @fileoverview Recipient-address helpers shared by every feature that emails
 * a credential (e.g. admin temporary passwords).
 *
 * Pure functions — no I/O, no state.
 */

/**
 * RFC 5321 caps a forward-path at 256 octets including the angle brackets,
 * so no deliverable address is longer than 254 characters. The cap also keeps
 * megabyte-long strings away from nodemailer's address parser.
 */
const MAX_ADDRESS_LENGTH = 254;

/**
 * Returns `raw` as ONE e-mail address, or null.
 *
 * A credential must reach exactly one mailbox. A profile EMAIL column, an
 * upload's EMAIL cell and an admin-typed override are all
 * free text, so "emp@corp, collector@evil" or "a@corp;b@corp" would reach
 * nodemailer as TWO recipients and the credential would go to both
 * (CWE-20 → CWE-201), and a placeholder like "N/A" would be treated as an
 * address. Anything that is not a single plain address — a list, a
 * display-name form, a placeholder, or a value carrying CR/LF (header
 * injection, CWE-93) — is null.
 *
 * STRINGS ONLY. `String(["a@x.org"])` is "a@x.org", so coercing would let an
 * array pass as an address (CWE-843 type confusion) — from a JSON body or a
 * driver/fixture shape alike. Objects (ExcelJS hyperlink/formula cells) and
 * numbers never looked like an address anyway; arrays are the only type the
 * old coercion silently accepted.
 *
 * @param {*} raw
 * @returns {string|null}
 */
function singleAddress(raw) {
    if (raw != null && typeof raw !== "string") return null;
    const v = raw == null ? "" : raw.trim();
    if (!v || v.length > MAX_ADDRESS_LENGTH) return null;
    return /^[^\s@,;<>"()]+@[^\s@,;<>"()]+\.[^\s@,;<>"()]+$/.test(v) ? v : null;
}

/**
 * Masks an address for display to an operator: first character of the local
 * part, then `***`, then the full domain — `juan.cruz@corp.com` → `j***@corp.com`.
 * Enough for a Super Admin to recognise the mailbox without the account list
 * becoming an address book. Returns null for anything `singleAddress` rejects.
 *
 * @param {*} raw
 * @returns {string|null}
 */
function maskAddress(raw) {
    const address = singleAddress(raw);
    if (!address) return null;
    const at = address.lastIndexOf("@");
    return `${address.slice(0, 1)}***${address.slice(at)}`;
}

/**
 * The address a CREDENTIAL (temporary admin password) may be sent to for one
 * account row, or null when there is no single safe choice.
 *
 * A resolver may attach `_CREDENTIAL_EMAIL` (non-enumerable) to a row: the
 * address when the identity has exactly ONE distinct usable address, null when
 * it has none or SEVERAL (a credential never goes to a guess — the operator
 * types it instead). A row without that marker falls back to its own EMAIL.
 *
 * @param {object|null|undefined} row - an account row
 * @returns {string|null}
 */
function credentialAddressOf(row) {
    if (!row) return null;
    if (Object.prototype.hasOwnProperty.call(row, "_CREDENTIAL_EMAIL")) {
        return row._CREDENTIAL_EMAIL;
    }
    // Lower-case key: some driver/cache paths hand back lower-cased column names.
    return singleAddress(row.EMAIL ?? row.email ?? null);
}

module.exports = { singleAddress, maskAddress, credentialAddressOf };
