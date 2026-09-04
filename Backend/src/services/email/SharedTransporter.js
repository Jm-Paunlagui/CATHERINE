"use strict";

/**
 * @fileoverview Singleton SMTP transporter shared by every email service.
 *
 * WHAT THIS FILE DOES
 * -------------------
 * Wraps ONE nodemailer transporter, built once from `SMTP_*` environment
 * variables, and reused by every email-sending service in the codebase
 * (starting with `EmailProtectionService`). Without this file, each email
 * service would independently call `nodemailer.createTransport(...)` with an
 * IDENTICAL configuration object — copies of the same host / port / secure /
 * auth / timeout settings that would have to be kept in sync by hand.
 *
 * HOW IT WORKS
 * ------------
 * `getTransporter()` lazily creates the nodemailer transporter on first call
 * and returns that same instance on every subsequent call — combined with
 * Node's module cache (`require()` only ever evaluates this file once per
 * process), this makes it a true process-wide singleton with zero eager
 * work at `require()` time.
 *
 * The singleton is POOLED AND RATE-LIMITED by default (`EMAIL_POOL`,
 * `EMAIL_CONCURRENCY`, `EMAIL_MAX_MESSAGES`, `EMAIL_RATE_LIMIT`,
 * `EMAIL_RATE_DELTA_MS` — see `_poolConfig()`). Two consequences every caller
 * inherits:
 *
 *   1. A burst is PACED, not rejected. Past the configured rate, `sendMail()`
 *      resolves later rather than failing — callers with their own deadline
 *      can time out on a queued message that the relay would have accepted.
 *   2. The pool holds SMTP sockets open, which keeps the Node event loop
 *      alive. `closeTransporter()` MUST run during graceful shutdown; wire it
 *      into `server.js`'s shutdown path.
 *
 * Set `EMAIL_POOL=false` to restore the historical behavior: a fresh SMTP
 * connection per `sendMail()`, no pacing, no sockets held (nodemailer ignores
 * `rateLimit` entirely without `pool`).
 *
 * `getDefaultFrom()` centralizes the `SMTP_FROM` fallback
 * (`noreply@app.internal`) so no `sendMail()` call site repeats it inline.
 *
 * `createTransport(overrides)` returns a FRESH, independent transporter built
 * from the exact same base config as the singleton, merged with caller-
 * supplied overrides (e.g. `pool`, `maxConnections`, `maxMessages`,
 * `rateDelta`, `rateLimit`). It never touches the process-wide singleton —
 * every request-path email service keeps sharing the one lazily-built
 * transporter from `getTransporter()` untouched. This exists for one-off
 * bulk/pooled senders (e.g. a migration script's notification batch) that
 * need connection pooling and SMTP-side rate limiting for a single run,
 * without mutating (or rate-limiting) every other email path in the running
 * process. The caller OWNS the returned transporter and MUST call `.close()`
 * on it when done: a pooled transporter keeps its sockets (and therefore the
 * Node event loop) alive indefinitely otherwise.
 *
 * ⚠ AN SMTP RELAY TYPICALLY METERS PER AUTHENTICATING USER, NOT PER PROCESS.
 * A bulk run and this singleton spend ONE budget whenever both authenticate
 * as the same functional account. Two independent limiters (this singleton
 * and any bulk script) each only know about their own process, so their
 * limits OVERLAP rather than add up against the relay's per-user cap — lower
 * one side or run bulk jobs off-hours when both are active at once.
 *
 * EXAMPLE
 * -------
 *   const SharedTransporter = require("./SharedTransporter");
 *
 *   await SharedTransporter.getTransporter().sendMail({
 *       from: SharedTransporter.getDefaultFrom(),
 *       to: "user@example.com",
 *       subject: "Hello",
 *       html: "<p>Hi</p>",
 *   });
 *
 *   // One-off pooled/rate-limited transporter (e.g. bulk sends) —
 *   // independent of the shared singleton, caller must .close() it:
 *   const bulk = SharedTransporter.createTransport({
 *       pool: true,
 *       maxConnections: 4,
 *       maxMessages: 50,
 *       rateDelta: 60_000,
 *       rateLimit: 150,
 *   });
 *   try {
 *       await bulk.sendMail({ ... });
 *   } finally {
 *       bulk.close();
 *   }
 *
 * CONFIGURATION SOURCE
 * ---------------------
 * | Env var      | Default                | Notes                                          |
 * |--------------|------------------------|-------------------------------------------------|
 * | SMTP_HOST    | "localhost"            |                                                  |
 * | SMTP_PORT    | 587                    |                                                  |
 * | SMTP_SECURE  | false                  | Only the literal string "true" enables TLS      |
 * | SMTP_USER    | (none)                 | Omitting both USER/PASS disables auth           |
 * | SMTP_PASS    | (none)                 |                                                  |
 * | SMTP_FROM    | noreply@app.internal   | Default `From:` address (getDefaultFrom())      |
 * | SMTP_CA_FILE | (none)                 | CA .pem filename inside certs/. Resolves         |
 * |              |                        | "unable to get local issuer certificate" for     |
 * |              |                        | internal CAs                                     |
 *
 * | Env var             | Default | Maps to (nodemailer)                    |
 * |---------------------|---------|------------------------------------------|
 * | EMAIL_POOL          | true    | `pool` — "false" restores per-send conns |
 * | EMAIL_CONCURRENCY   | 4       | `maxConnections`                         |
 * | EMAIL_MAX_MESSAGES  | 100     | `maxMessages` (per connection)           |
 * | EMAIL_RATE_LIMIT    | 150     | `rateLimit`                              |
 * | EMAIL_RATE_DELTA_MS | 60000   | `rateDelta`                              |
 *
 * `connectionTimeout=10_000ms`, `greetingTimeout=5_000ms`,
 * `socketTimeout=30_000ms` — CWE-400 (Uncontrolled Resource Consumption):
 * explicit SMTP timeouts so a hung server cannot tie up a send indefinitely.
 */

const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const { logger } = require("../../utils/logger");

class SharedTransporter {
    constructor() {
        /** @type {import("nodemailer").Transporter|null} */
        this._transporter = null;
    }

    /**
     * Builds the base nodemailer transport config shared by every transporter
     * this class creates (the lazy singleton AND any one-off transporter from
     * `createTransport()`). Pure — reads `process.env` fresh on every call.
     *
     * @returns {import("nodemailer").TransportOptions}
     */
    _baseConfig() {
        return {
            host: process.env.SMTP_HOST || "localhost",
            port: Number(process.env.SMTP_PORT) || 587,
            secure: process.env.SMTP_SECURE === "true",
            auth: process.env.SMTP_USER
                ? {
                      user: process.env.SMTP_USER,
                      pass: process.env.SMTP_PASS,
                  }
                : undefined,
            tls: this._buildTlsOptions(),
            connectionTimeout: 10_000,
            greetingTimeout: 5_000,
            socketTimeout: 30_000,
        };
    }

    /**
     * Builds the pooling + rate-limiting half of the singleton's config from
     * `EMAIL_POOL` / `EMAIL_CONCURRENCY` / `EMAIL_MAX_MESSAGES` /
     * `EMAIL_RATE_LIMIT` / `EMAIL_RATE_DELTA_MS`.
     *
     * WHY THE SINGLETON IS RATE-LIMITED AT ALL: an SMTP relay typically caps
     * authenticated senders at N messages/minute, metered against the
     * AUTHENTICATING USER (`SMTP_USER`) rather than the host or the process.
     * Any app path that sends in bulk through this one transporter can breach
     * that cap on its own and get throttled (4.7.x). Capping here converts
     * "relay rejects a burst" into "nodemailer paces the burst".
     *
     * ⚠ `rateLimit` is a POOL feature — nodemailer ignores it entirely when
     * `pool` is false. Setting `EMAIL_POOL=false` therefore disables the rate
     * limiting too, restoring the historical connection-per-send behavior.
     *
     * @returns {object} Pool options, or `{}` when pooling is disabled.
     */
    _poolConfig() {
        // Opt-out, not opt-in: an unthrottled shared transporter is the
        // behavior that lets a bulk path breach the relay cap.
        if (
            String(process.env.EMAIL_POOL ?? "true").toLowerCase() === "false"
        ) {
            return {};
        }

        const positiveInt = (raw, fallback) => {
            const n = parseInt(raw, 10);
            return Number.isInteger(n) && n > 0 ? n : fallback;
        };

        return {
            pool: true,
            maxConnections: positiveInt(process.env.EMAIL_CONCURRENCY, 4),
            maxMessages: positiveInt(process.env.EMAIL_MAX_MESSAGES, 100),
            rateDelta: positiveInt(process.env.EMAIL_RATE_DELTA_MS, 60_000),
            rateLimit: positiveInt(process.env.EMAIL_RATE_LIMIT, 150),
        };
    }

    /**
     * Lazily builds (once per process) and returns the shared nodemailer
     * transporter. Safe to call from every email service constructor.
     *
     * Pooled and rate-limited by default (see `_poolConfig()`). Because the
     * pool holds SMTP sockets open, the process will not exit on its own once
     * this has been called — `closeTransporter()` must run during shutdown.
     *
     * @returns {import("nodemailer").Transporter}
     */
    getTransporter() {
        if (!this._transporter) {
            this._transporter = nodemailer.createTransport({
                ...this._baseConfig(),
                ...this._poolConfig(),
            });
        }
        return this._transporter;
    }

    /**
     * Closes the shared transporter and drops the reference, so a subsequent
     * `getTransporter()` builds a fresh one. Idempotent and safe to call when
     * no transporter was ever built, when pooling is disabled (nodemailer's
     * non-pooled transport also exposes `close()`), and during shutdown.
     *
     * ⚠ Required in the graceful-shutdown path now that the singleton pools:
     * open pool sockets keep the Node event loop alive, so without this the
     * process hangs until the forced-exit timer fires. Never throws —
     * shutdown must not fail here.
     *
     * @returns {void}
     */
    closeTransporter() {
        if (!this._transporter) return;
        try {
            if (typeof this._transporter.close === "function") {
                this._transporter.close();
            }
        } catch (err) {
            logger.warning(
                `SharedTransporter: failed to close transporter during ` +
                    `shutdown (${err.message}) — continuing`,
            );
        } finally {
            this._transporter = null;
        }
    }

    /**
     * Builds and returns a brand-new, independent nodemailer transporter —
     * never the process-wide singleton, and never stored on `this`. Intended
     * for one-off bulk/pooled senders that need `pool` / `maxConnections` /
     * `maxMessages` / `rateDelta` / `rateLimit` for the lifetime of a single
     * run, without mutating the shared transporter every request-path email
     * service depends on.
     *
     * ⚠ The caller OWNS the returned transporter and MUST call `.close()` on
     * it (in a `finally` block) once done sending — a pooled transporter
     * (`pool: true`) keeps its SMTP sockets open, which keeps the Node event
     * loop alive and the process from exiting.
     *
     * @param {import("nodemailer").TransportOptions} [overrides] Merged on
     *   top of the same base config `getTransporter()` uses.
     * @returns {import("nodemailer").Transporter} A fresh transporter — never
     *   reused, never shared.
     */
    createTransport(overrides = {}) {
        return nodemailer.createTransport({
            ...this._baseConfig(),
            ...overrides,
        });
    }

    /**
     * Builds the `tls` options object for nodemailer.
     *
     * When `SMTP_CA_FILE` is set, reads the PEM-encoded CA certificate(s)
     * from `certs/<SMTP_CA_FILE>` and passes them as `tls.ca` so Node's
     * TLS stack trusts the SMTP server's certificate chain (fixes "unable
     * to get local issuer certificate" for internal CAs like the
     * automotive-root CA).
     *
     * Resolution mirrors the PFX_FILENAME pattern in server.js:
     *   - pkg build → certs/ sits next to the compiled executable
     *   - normal Node → certs/ sits next to server.js (project root)
     *
     * When `SMTP_CA_FILE` is unset, returns `undefined` so nodemailer
     * falls back to the system default CA bundle.
     *
     * @returns {{ ca: Buffer }|undefined}
     */
    _buildTlsOptions() {
        const caFilename = process.env.SMTP_CA_FILE;
        if (!caFilename) return undefined;

        // Resolve certs/ the same way server.js resolves PFX_FILENAME:
        // compiled (pkg) → next to the exe; normal Node → project root.
        const certDir = path.resolve(
            process.pkg
                ? path.dirname(process.execPath)
                : path.join(__dirname, "..", "..", ".."),
            "certs",
        );
        const caPath = path.join(certDir, caFilename);

        if (!fs.existsSync(caPath)) {
            logger.warning(
                `SharedTransporter: SMTP_CA_FILE set to "${caFilename}" but ` +
                    `file not found at "${caPath}" — falling back to system ` +
                    `CA bundle`,
            );
            return undefined;
        }

        try {
            const ca = fs.readFileSync(caPath);
            logger.info(
                `SharedTransporter: loading custom CA certificate from "${caPath}"`,
            );
            return { ca };
        } catch (err) {
            // EACCES under a locked-down service account, unreadable share,
            // etc. — mirror the missing-file path (warn + system-CA fallback)
            // instead of throwing inside the lazy transporter getter at the
            // first email send. TLS verification itself stays ON either way.
            logger.warning(
                `SharedTransporter: failed to read SMTP_CA_FILE at "${caPath}" ` +
                    `(${err.message}) — falling back to system CA bundle`,
            );
            return undefined;
        }
    }

    /**
     * @returns {string} `SMTP_FROM` env var, or the documented fallback
     *   address when unset.
     */
    getDefaultFrom() {
        return process.env.SMTP_FROM || "noreply@app.internal";
    }
}

module.exports = new SharedTransporter();
module.exports.SharedTransporter = SharedTransporter;
