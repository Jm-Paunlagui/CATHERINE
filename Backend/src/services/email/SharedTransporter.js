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
 * Nodemailer's default (non-pooled — `pool` is not set here) transporter is
 * stateless per `sendMail()` call: it opens a fresh SMTP connection for
 * every send and holds no per-call state on the transporter object itself.
 * Sharing one instance across services is therefore behaviorally IDENTICAL
 * to each service holding its own separately-constructed copy with the same
 * config — this file is a pure de-duplication, not a behavior change.
 *
 * `getDefaultFrom()` centralizes the `SMTP_FROM` fallback
 * (`noreply@app.internal`) so no `sendMail()` call site repeats it inline.
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
 * | SMTP_CA_FILE | (none)                 | CA .pem filename inside certs/ (e.g.             |
 * |              |                        | automotive-root.pem). Resolves "unable to get    |
 * |              |                        | local issuer certificate" for internal CAs       |
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
     * Lazily builds (once per process) and returns the shared nodemailer
     * transporter. Safe to call from every email service constructor.
     *
     * @returns {import("nodemailer").Transporter}
     */
    getTransporter() {
        if (!this._transporter) {
            this._transporter = nodemailer.createTransport({
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
            });
        }
        return this._transporter;
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
