// ─────────────────────────────────────────────────────────────────────────────
// node-oracledb driver error code (NJS-XXX) → { httpStatus, clientMessage }
//
// Complements OraCode.js (ORA-XXXXX, raised BY the database engine). NJS-XXX
// codes are raised by the node-oracledb DRIVER itself — pool exhaustion,
// connection-request timeouts, and connections lost/closed/terminated at the
// client side before (or without) ever reaching the database engine. These
// never carry an ORA-XXXXX code, so OraCode.js's `/ORA-\d+/` test never
// matches them and they previously fell through to a generic 500.
//
// Verified against:
//   • node-oracledb documentation — Errors (oracle.github.io/node-oracledb)
//   • node-oracledb GitHub error message source (lib/errors.js)
//
// HTTP status rationale key:
//   429 Too Many Requests   – the pool DELIBERATELY shed load (bounded
//                              queueMax exceeded, NJS-076). This is a
//                              back-pressure signal, not a failure: the client
//                              should back off and retry after a delay. It is
//                              distinct from 503 because the server is healthy
//                              and is protecting itself, and it must NOT be
//                              presented as a transient auto-retryable fault.
//   503 Service Unavailable – pool/connection is down or exhausted (not a
//                              deliberate shed), but the caller may retry once
//                              capacity frees up
//   504 Gateway Timeout     – the caller gave up waiting for a connection
// ─────────────────────────────────────────────────────────────────────────────

const NJS_MAP = {
    40: {
        status: 503,
        msg: "Database connection pool is exhausted. Please retry shortly.",
        // NJS-040: connection request timeout — pool.getConnection() timed
        // out waiting for a free connection (queueTimeout exceeded).
    },

    76: {
        status: 429,
        type: "PoolOverloadedError", // = POOL_OVERLOADED_TYPE (below)
        msg: "Server is busy. Please retry shortly.",
        hint: "The server is shedding load. Back off and retry after a short delay.",
        // NJS-076: connection request rejected — the pool's bounded request
        // queue (queueMax) is full, so the driver DELIBERATELY sheds this
        // request rather than queueing it. This is intentional back-pressure,
        // not a transient fault: map to 429 (not 503) and tell the client to
        // back off. Must NOT be auto-retried by the row-level retry engine.
    },

    500: {
        status: 503,
        msg: "Database connection was closed unexpectedly.",
        // NJS-500: connection ... was closed / terminated
    },

    501: {
        status: 503,
        msg: "Database connection is invalid or already closed.",
        // NJS-501: invalid connection
    },

    503: {
        status: 503,
        msg: "Database connection pool is closed or unavailable.",
        // NJS-503: connection pool is closed / not open
    },

    510: {
        status: 503,
        msg: "Database connection was terminated. The pool may be shutting down.",
        // NJS-510: connection terminated
    },
};

// ─────────────────────────────────────────────────────────────────────────────
// String-pattern matches for adapter/driver-level failures that never carry
// an ORA-/NJS- code at all — e.g. the plain `Error("Timed out getting
// connection from \"<name>\"")` thrown by `withConnection()`
// (src/config/adapters/oracle.js:490-496) when `pool.getConnection()` itself
// races against a timeout before any driver error is raised. The adapter
// wraps this in `DB_OP_FAILED(name, err.message)`
// (src/constants/messages/oracle.messages.js:52), which embeds the original
// message — so the pattern still matches the wrapped error without needing
// to unwrap `err.originalError`.
// ─────────────────────────────────────────────────────────────────────────────
const TRANSIENT_STRING_PATTERNS = [
    {
        pattern: /timed out getting connection/i,
        status: 504,
        type: "DatabaseTimeoutError",
        msg: "Timed out waiting for a database connection. Please retry.",
    },
];

/** Error type stamped on the NJS-076 load-shed 429 (see NJS_MAP). */
const POOL_OVERLOADED_TYPE = "PoolOverloadedError";

module.exports = { NJS_MAP, TRANSIENT_STRING_PATTERNS, POOL_OVERLOADED_TYPE };
