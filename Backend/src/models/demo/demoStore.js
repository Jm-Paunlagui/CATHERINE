"use strict";

/**
 * @fileoverview In-memory data source backing DEMO_MODE.
 *
 * When DEMO_MODE=true the models read from here instead of Oracle, so the whole
 * template runs with no database. Everything goes through the SAME service/auth
 * code path as the real DB — the only difference is where the rows come from.
 *
 *   • Accounts (T_USERS_DEV / T_ADMINS_DEV) are hashed with the real CryptoVault at first
 *     access, so login exercises the genuine Argon2id verify + signature path.
 *     Demo credentials:  admin / Demo@123 (SUPER_ADMIN), manager / Demo@123 (ADMIN),
 *                        user / Demo@123 (USER, T_USERS_DEV).
 *   • Audit logs are pre-populated with a realistic 2xx/3xx/4xx/5xx spread so the
 *     Logging & Observability dashboard renders immediately.
 *
 * Nothing here connects to Oracle; importing this module is side-effect free
 * except for building the in-memory audit array.
 */

const { CryptoVault } = require("../../utils/encryption/CryptoVault");

const DEMO_PASSWORD = "Demo@123";

// ── Accounts (lazy, memoised — Argon2 hashing is async) ───────────────────────

let _accountsPromise = null;

async function _buildAccounts() {
    const pw = await CryptoVault.hashPassword(DEMO_PASSWORD);
    const now = new Date();

    const admins = [
        {
            ID: 1,
            USERNAME: "admin",
            PASSWORD: pw,
            ROLE: "SUPER_ADMIN",
            IS_ACTIVE: "Y",
            CREATED_AT: now,
            UPDATED_AT: now,
        },
        {
            ID: 2,
            USERNAME: "manager",
            PASSWORD: pw,
            ROLE: "ADMIN",
            IS_ACTIVE: "Y",
            CREATED_AT: now,
            UPDATED_AT: now,
        },
    ];
    for (const a of admins) {
        a.SYSSIGNATURE = await CryptoVault.signRecord("T_ADMINS_DEV", {
            USERNAME: a.USERNAME,
            PASSWORD: a.PASSWORD,
            ROLE: a.ROLE,
            IS_ACTIVE: a.IS_ACTIVE,
        });
    }

    const users = [
        {
            ID: 1,
            USERNAME: "user",
            PASSWORD: pw,
            FIRST_NAME: "Demo",
            LAST_NAME: "User",
            EMAIL: "user@demo.local",
            IS_ACTIVE: "Y",
            CREATED_AT: now,
            UPDATED_AT: now,
        },
    ];

    return { admins, users };
}

/**
 * Returns the memoised demo accounts ({ admins, users }), hashing on first call.
 * @returns {Promise<{admins: object[], users: object[]}>}
 */
function accounts() {
    if (!_accountsPromise) _accountsPromise = _buildAccounts();
    return _accountsPromise;
}

// ── Audit logs (synchronous — no hashing needed) ──────────────────────────────

const METHODS = ["GET", "POST", "PUT", "DELETE"];
const ENDPOINTS = [
    "/api/v1/auth/login",
    "/api/v1/health",
    "/api/v1/metrics",
    "/api/v1/admin-management/admins",
    "/api/v1/changelog",
    "/api/v1/audit-logs",
];

function _statusFor(i) {
    const m = i % 100;
    if (m < 80) return i % 2 === 0 ? 200 : 201;
    if (m < 88) return i % 2 === 0 ? 302 : 304;
    if (m < 97) return [400, 401, 403, 404][i % 4];
    return i % 2 === 0 ? 500 : 503;
}

function _buildAuditLogs(count = 200) {
    const rows = [];
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    // Demo Snowflake IDs: segmented format {timestamp13}-{machine4}-{seq4}.
    // Machine ID 0, sequence = row index. Timestamp derived from CREATED_AT.
    const demoEpoch = new Date("2024-01-01T00:00:00.000Z").getTime();
    for (let i = 1; i <= count; i++) {
        const uid = i % 6 === 0 ? 0 : i % 6; // ~1/6 anonymous
        const sc = _statusFor(i);
        const createdAt = new Date(Date.now() - Math.random() * sevenDaysMs);
        const ts = String(createdAt.getTime() - demoEpoch).padStart(13, "0");
        const seq = String(i % 4096).padStart(4, "0");
        rows.push({
            ID: i,
            REQUEST_ID: `${ts}-0000-${seq}`,
            USER_ID: uid,
            USERNAME: uid === 0 ? null : `demo_user${uid}`,
            METHOD: METHODS[i % METHODS.length],
            ENDPOINT: ENDPOINTS[i % ENDPOINTS.length],
            PARAMS: null,
            STATUS_CODE: sc,
            STATUS_CATEGORY: `${Math.floor(sc / 100)}xx`,
            RESPONSE_TIME_MS:
                Math.round(8 + Math.random() * 342) + (sc >= 500 ? 280 : 0),
            CLIENT_IP: `192.168.1.${(i % 254) + 1}`,
            SERVER_IP: "10.0.0.10",
            CREATED_AT: createdAt,
        });
    }
    return rows;
}

// Mutable so demo-mode inserts (live traffic while browsing) appear in the list.
const _auditLogs = _buildAuditLogs();
let _auditSeq = _auditLogs.length;

function auditLogs() {
    return _auditLogs;
}

function auditInsert(record) {
    _auditLogs.push({ ID: ++_auditSeq, ...record });
    return { rowsAffected: 1 };
}

// ── FX rates (append-only, effective-dated) ───────────────────────────────────
// Mirrors the T_FX_RATE_DEV reference shape (plan §3.7.9). Rates are stored as
// fixed-scale STRINGS (never JS numbers) — a rate is NUMBER(19,8), higher scale
// than a posted amount, and must never round-trip through a double. Rows are
// append-only: a correction closes the current window and opens a new one, so
// converting a historical figure reproduces the same rate forever.
//
// CURRENCY_CODE is the non-base side; the base currency is a system fact
// (MONEY_BASE_CURRENCY), never a column. All rates here are quoted against a
// PHP base for the demo (1 CODE = RATE PHP).
const _fxRates = [
    { ID: 1, CURRENCY_CODE: "USD", RATE: "56.25000000", EFFECTIVE_FROM: new Date("2026-01-01T00:00:00Z"), EFFECTIVE_TO: new Date("2026-06-30T23:59:59Z"), SOURCE: "MANUAL", RETRIEVED_AT: new Date("2026-01-01T08:00:00Z"), SET_BY: "demo-admin" },
    { ID: 2, CURRENCY_CODE: "USD", RATE: "58.10000000", EFFECTIVE_FROM: new Date("2026-07-01T00:00:00Z"), EFFECTIVE_TO: null, SOURCE: "MANUAL", RETRIEVED_AT: new Date("2026-07-01T08:00:00Z"), SET_BY: "demo-admin" },
    { ID: 3, CURRENCY_CODE: "EUR", RATE: "61.40000000", EFFECTIVE_FROM: new Date("2026-01-01T00:00:00Z"), EFFECTIVE_TO: null, SOURCE: "MANUAL", RETRIEVED_AT: new Date("2026-01-01T08:00:00Z"), SET_BY: "demo-admin" },
    { ID: 4, CURRENCY_CODE: "JPY", RATE: "0.38500000", EFFECTIVE_FROM: new Date("2026-01-01T00:00:00Z"), EFFECTIVE_TO: null, SOURCE: "MANUAL", RETRIEVED_AT: new Date("2026-01-01T08:00:00Z"), SET_BY: "demo-admin" },
];
let _fxSeq = _fxRates.length;

/** All demo FX rate rows (append-only). @returns {object[]} */
function fxRates() {
    return _fxRates;
}

/**
 * Append a new rate row (never mutate an existing one — §3.7.9).
 * @param {object} record
 * @returns {{rowsAffected: number, insertedId: number}}
 */
function fxRateInsert(record) {
    const id = ++_fxSeq;
    _fxRates.push({ ID: id, ...record });
    return { rowsAffected: 1, insertedId: id };
}

// ── Money ledger (single-entry demo — DIRECTION + AMOUNT) ─────────────────────
// A single-entry ledger (§3.7.5): it yields a correct running balance but cannot
// produce a trial balance or detect a missing counter-posting. That limitation is
// documented, not hidden. AMOUNT is a fixed-scale STRING (Money.toStorage(), scale
// 4). Rows are APPEND-ONLY (§3.7.4): a mistake is corrected with a reversing entry
// (equal-and-opposite), never an UPDATE — see reverseEntry below.
const _ledger = [
    { ID: 1, DIRECTION: "CREDIT", AMOUNT: "10000.0000", MEMO: "Opening balance", REVERSES_ID: null, CREATED_AT: new Date("2026-07-01T09:00:00Z") },
    { ID: 2, DIRECTION: "DEBIT", AMOUNT: "2500.0000", MEMO: "Supplier payment", REVERSES_ID: null, CREATED_AT: new Date("2026-07-02T10:30:00Z") },
    { ID: 3, DIRECTION: "CREDIT", AMOUNT: "750.5000", MEMO: "Refund received", REVERSES_ID: null, CREATED_AT: new Date("2026-07-03T14:15:00Z") },
];
let _ledgerSeq = _ledger.length;

/** All demo ledger rows (append-only). @returns {object[]} */
function ledger() {
    return _ledger;
}

/**
 * Append a ledger posting. Never updates an existing row (§3.7.4).
 * @param {{DIRECTION: string, AMOUNT: string, MEMO?: string, REVERSES_ID?: number}} record
 * @returns {{rowsAffected: number, insertedId: number}}
 */
function ledgerInsert(record) {
    const id = ++_ledgerSeq;
    _ledger.push({
        ID: id,
        DIRECTION: record.DIRECTION,
        AMOUNT: record.AMOUNT,
        MEMO: record.MEMO ?? null,
        REVERSES_ID: record.REVERSES_ID ?? null,
        CREATED_AT: new Date(),
    });
    return { rowsAffected: 1, insertedId: id };
}

/**
 * Post the equal-and-opposite of an existing row (the reversing-entry pattern,
 * §3.7.4) — the only correct way to "undo" a posting in an append-only ledger.
 * Both the original and the reversal stay visible.
 * @param {number} originalId
 * @param {string} [memo]
 * @returns {{rowsAffected: number, insertedId: number}}
 */
function reverseEntry(originalId, memo) {
    const original = _ledger.find((r) => r.ID === originalId);
    if (!original) {
        throw new Error(`Cannot reverse ledger row ${originalId}: not found.`);
    }
    const flipped = original.DIRECTION === "CREDIT" ? "DEBIT" : "CREDIT";
    return ledgerInsert({
        DIRECTION: flipped,
        AMOUNT: original.AMOUNT,
        MEMO: memo ?? `Reversal of #${originalId}`,
        REVERSES_ID: originalId,
    });
}

// ── Minimal oracle-mongo-wrapper-style filter matcher ─────────────────────────
// Supports the operators the audit/admin queries actually use so the same filter
// objects work against the in-memory arrays.

function _toComparable(v) {
    if (v instanceof Date) return v.getTime();
    if (typeof v === "string") {
        const t = Date.parse(v);
        if (!Number.isNaN(t) && /\d{4}-\d{2}-\d{2}/.test(v)) return t;
    }
    return v;
}

function _matchOp(value, op, expected) {
    switch (op) {
        case "$eq":
            return value === expected;
        case "$ne":
            return value !== expected;
        case "$gt":
            return _toComparable(value) > _toComparable(expected);
        case "$gte":
            return _toComparable(value) >= _toComparable(expected);
        case "$lt":
            return _toComparable(value) < _toComparable(expected);
        case "$lte":
            return _toComparable(value) <= _toComparable(expected);
        case "$in":
            return Array.isArray(expected) && expected.includes(value);
        case "$nin":
            return Array.isArray(expected) && !expected.includes(value);
        case "$exists":
            return expected ? value != null : value == null;
        default:
            return false;
    }
}

/**
 * Tests one row against an oracle-mongo-wrapper-style filter object.
 * @param {object} row
 * @param {object} filter
 * @returns {boolean}
 */
function match(row, filter) {
    if (!filter || typeof filter !== "object") return true;

    for (const [key, cond] of Object.entries(filter)) {
        if (key === "$or") {
            if (!cond.some((sub) => match(row, sub))) return false;
            continue;
        }
        if (key === "$and") {
            if (!cond.every((sub) => match(row, sub))) return false;
            continue;
        }

        const value = row[key];

        if (
            cond &&
            typeof cond === "object" &&
            !Array.isArray(cond) &&
            !(cond instanceof Date)
        ) {
            for (const [op, expected] of Object.entries(cond)) {
                if (op === "$regex") {
                    const flags = cond.$options?.includes("i") ? "i" : "";
                    if (op === "$options") continue;
                    if (!new RegExp(expected, flags).test(String(value ?? "")))
                        return false;
                } else if (op === "$options") {
                    // handled with $regex
                } else if (!_matchOp(value, op, expected)) {
                    return false;
                }
            }
        } else if (value !== cond) {
            return false;
        }
    }
    return true;
}

module.exports = {
    DEMO_PASSWORD,
    accounts,
    auditLogs,
    auditInsert,
    fxRates,
    fxRateInsert,
    ledger,
    ledgerInsert,
    reverseEntry,
    match,
};
