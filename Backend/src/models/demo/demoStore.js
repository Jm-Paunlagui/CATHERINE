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
    match,
};
