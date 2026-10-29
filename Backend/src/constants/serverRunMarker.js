"use strict";

/**
 * @fileoverview Constants for the server run marker - the small JSON
 * file the cron-leader process keeps so the NEXT boot can tell a clean stop
 * from an unclean one. No imports.
 */

const SERVER_RUN_MARKER = Object.freeze({
    /** File name inside the data directory. */
    FILE_NAME: "server-run.json",
    /** Record schema version; a mismatch reads as UNREADABLE. */
    SCHEMA: 1,
    /** Heartbeat period; also the accuracy of the "last alive" time. */
    HEARTBEAT_INTERVAL_MS: 30_000,
    /** A NOTICE/WARNING "Server started" email is skipped inside this window. */
    STARTUP_NOTICE_MIN_INTERVAL_MS: 15 * 60_000,
    /** Longest the boot email waits for the database pools before it is sent anyway. */
    BOOT_ANNOUNCE_MAX_WAIT_MS: 10_000,
    /** Env var the cluster primary stamps on every fork (one id per primary run). */
    CLUSTER_RUN_ID_ENV: "APP_CLUSTER_RUN_ID",
    /** Test/sim-only absolute-path override. */
    PATH_OVERRIDE_ENV: "SERVER_RUN_MARKER_PATH",
    STATES: Object.freeze({ RUNNING: "RUNNING", STOPPING: "STOPPING", STOPPED: "STOPPED" }),
    VERDICTS: Object.freeze({
        FIRST_BOOT: "FIRST_BOOT",
        CLEAN: "CLEAN",
        UNCLEAN: "UNCLEAN",
        UNREADABLE: "UNREADABLE",
        HANDOVER: "HANDOVER",
    }),
    STOP_REASONS: Object.freeze({
        SIGNAL: "SIGNAL",
        CRASH: "CRASH",
        FORCED_EXIT: "FORCED_EXIT",
        EXIT: "EXIT",
        // A cluster worker stopped because the primary vanished
        // (no crash, and no email went out for it at the time).
        PRIMARY_DISCONNECT: "PRIMARY_DISCONNECT",
    }),
});

module.exports = { SERVER_RUN_MARKER };
