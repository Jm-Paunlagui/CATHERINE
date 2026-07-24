"use strict";

/**
 * @fileoverview Server Email Notifications — the sender.
 *
 * WHAT THIS FILE DOES
 * -------------------
 * Builds and sends ONE HTML digest email per notification channel, reusing
 * the process-wide `SharedTransporter` (never opens its own transporter).
 * There are exactly four channels, one HTML template each, documented in
 * `src/utils/email-templates/server-notification/`:
 *
 *   - server-critical-notification    (in-process crit/alert/emerg log storms)
 *   - server-dependencies-notification (Oracle pool saturation, SMTP delivery health)
 *   - server-red-metrics-notification  (error rate / latency)
 *   - server-system-notification       (heap / event-loop / GC / memory leak)
 *
 * This class is deliberately "dumb" — it owns template rendering, recipient
 * resolution, HTML-escaping, and the SMTP send call. ALL dedup/throttle/state
 * logic (transitions, cooldowns, recovery hysteresis, storm ceilings) lives
 * one layer up in `AlertNotifierService`, which is the only caller.
 *
 * HOW IT WORKS
 * ------------
 * `sendChannelDigest(channel, payload)` loads the channel's template
 * (`readFileSync`, cached per process by the OS page cache — mirrors the
 * `ResetRequestEmailService` pattern), fills the flat `{{key}}` placeholder
 * contract with HTML-escaped values, injects a pre-built `{{alertRows}}`
 * block (each row's dynamic fields are escaped individually before
 * concatenation — see `_buildRow`), attaches the AUMOVIO logo as cid
 * attachments, and sends via `SharedTransporter.getTransporter()`.
 *
 * NEVER THROWS. Every send attempt (success or failure) is recorded via
 * `metricsStore.recordNotificationDelivery()` so the alert tab always
 * reflects delivery health (R7 — SMTP is itself a monitored dependency).
 * Failures log at `warning` (never above) with meta `{ _noNotify: true }` —
 * the mandatory loop guard (R1a/R1b, server-email-notifications-plan.md):
 * an email-path failure must never be able to trigger another email.
 *
 * EXAMPLE
 * -------
 *   const ServerNotificationService = require("./ServerNotificationService");
 *
 *   await ServerNotificationService.sendChannelDigest("server-system-notification", {
 *       severity: "CRITICAL",
 *       headline: "Heap usage at 92% of the V8 limit",
 *       summary: "1 alert is currently firing against the metrics snapshot.",
 *       rows: [{ rule: "HIGH_HEAP", scope: "global", description: "...", severity: "critical" }],
 *       throttleNote: "",
 *       kv: { heapUsedMb: 1900, heapLimitMb: 2048, heapPct: "92.8%", eventLoopLagMs: 12, gcOverheadPct: "3.1%" },
 *   });
 *
 * SUPPORTED CHANNELS
 * -------------------
 * See `CHANNELS` below — the channel key doubles as the template filename
 * (`<channel>.html`), so adding a fifth channel is a one-line change here
 * plus a new template file.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const { logger } = require("../../utils/logger");
const { notificationMessages } = require("../../constants/messages");
const { snowflake } = require("../../utils/snowflake");
const { metricsStore } = require("../../middleware/metrics");
const SharedTransporter = require("./SharedTransporter");
const RecipientResolver = require("./RecipientResolver");

/**
 * The four supported notification channels. Each key is also the template
 * filename stem: `<channel>.html` inside `email-templates/server-notification/`.
 * @type {readonly string[]}
 */
const CHANNELS = Object.freeze([
    "server-critical-notification",
    "server-dependencies-notification",
    "server-red-metrics-notification",
    "server-system-notification",
]);

/** Max in-memory "recent sends" ring buffer entries exposed via the status endpoint. */
const RECENT_SENDS_MAX = 100;

/**
 * HTML-escapes a string to prevent HTML/email injection (CWE-79). Mirrors
 * `ResetRequestEmailService#_escapeHtml` — every dynamic value substituted
 * into a server-notification template MUST pass through this first.
 *
 * @param {string|number|null|undefined} value
 * @returns {string}
 */
function escapeHtml(value) {
    if (value == null) return "";
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#x27;");
}

/**
 * Masks an email address for safe display (CWE-200 / CWE-312) — keeps the
 * first character of the local part and the full domain, replaces the rest
 * of the local part with asterisks. Pure function (no state), so it lives
 * at module scope rather than as a class method.
 *
 * @param {string} email
 * @returns {string} e.g. "j***@gmail.com"
 *
 * @example
 * maskEmail("johnmoisespaunlagui113@gmail.com"); // "j**********************@gmail.com"
 */
function maskEmail(email) {
    const str = String(email ?? "");
    const at = str.indexOf("@");
    if (at <= 0) return "***";
    const local = str.slice(0, at);
    const domain = str.slice(at);
    return `${local[0]}${"*".repeat(Math.max(1, local.length - 1))}${domain}`;
}

class ServerNotificationService {
    constructor() {
        // CWE-400: SharedTransporter carries explicit connect/greeting/socket
        // timeouts — never a new transporter per service (established rule).
        this._transporter = SharedTransporter.getTransporter();

        /** Absolute path to the server-notification email-templates directory. */
        this._templateDir = path.join(
            __dirname,
            "..",
            "..",
            "utils",
            "email-templates",
            "server-notification",
        );

        /** Absolute path to the shared assets directory (logos). */
        this._assetsDir = path.join(
            __dirname,
            "..",
            "..",
            "utils",
            "email-templates",
            "assets",
        );

        /**
         * In-memory ring buffer of the last RECENT_SENDS_MAX send attempts
         * (v1 has no DB persistence for sent notifications — see plan "What
         * this deliberately does NOT do"). Exposed via
         * `GET /api/v1/metrics/notifications/status`.
         * @type {Array<{ channel: string, notificationId: string, sent: boolean, headline: string, reason: string|null, at: string }>}
         */
        this._recentSends = [];
    }

    /**
     * Whether the master switch for server email notifications is on.
     * Defaults to `false` — disabled unless `ENABLE_SERVER_NOTIFICATIONS=true`.
     *
     * @returns {boolean}
     */
    isEnabled() {
        return String(process.env.ENABLE_SERVER_NOTIFICATIONS).toLowerCase() === "true";
    }

    /**
     * Resolves the recipient list for a given notification channel:
     * `env floor ∪ DB opt-ins`, deduplicated (Phase 2 — Access Control
     * recipients, server-email-notifications-plan.md).
     *
     * - Env floor: the parsed, deduplicated `SERVER_NOTIFY_TO` list — the
     *   ops floor/fallback, always included regardless of Access Control state.
     * - DB opt-ins: admins with `IS_ACTIVE='Y'` and the channel's
     *   `CAN_RECEIVE_SRV_*` flag `='Y'` (`AdminModel.findServerNotifyRecipients`,
     *   which already resolves and de-duplicates addresses, dropping admins
     *   with no address on file) — served from `RecipientResolver`'s short-TTL
     *   last-known-good cache so a DB outage never mutes a channel. Cold
     *   boot with the DB down contributes `[]` from this half — the env
     *   floor alone still gets through.
     *
     * Never throws — `RecipientResolver.getDbRecipients` swallows its own
     * failures internally; this method also does not let ANY DB error stop
     * the env floor from being returned.
     *
     * @param {string} channel - One of `CHANNELS`
     * @returns {Promise<string[]>} Deduplicated, trimmed recipient email addresses
     */
    async resolveRecipients(channel) {
        const raw = process.env.SERVER_NOTIFY_TO || "";
        const envFloor = raw
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean);

        let dbOptIns = [];
        try {
            dbOptIns = await RecipientResolver.getDbRecipients(channel);
        } catch (err) {
            // Defense-in-depth — RecipientResolver already swallows its own
            // refresh failures, but resolveRecipients must never propagate
            // ANY error here; the env floor below still gets returned.
            logger.warning(
                notificationMessages.EMAIL_FAILED(channel, `recipient resolution: ${err?.message ?? String(err)}`),
                { _noNotify: true }, // R1b loop guard
            );
        }

        const seen = new Set();
        const out = [];
        for (const email of [...envFloor, ...dbOptIns]) {
            if (!email || seen.has(email)) continue;
            seen.add(email);
            out.push(email);
        }
        return out;
    }

    /**
     * Forces the DB opt-in half of {@link resolveRecipients} to refresh on
     * its next read. Call after any `CAN_RECEIVE_SRV_*` Access Control flag
     * write so a toggle takes effect on the next notification instead of
     * waiting out `RECIPIENT_REFRESH_MIN`.
     */
    invalidateRecipientCache() {
        RecipientResolver.invalidate();
    }

    /**
     * Builds and sends one HTML digest email for `channel`. Never throws —
     * every outcome (including "disabled", "unknown channel", "no
     * recipients", and SMTP failure) is recorded via
     * `metricsStore.recordNotificationDelivery()` where applicable and
     * returned as a result object for the caller to inspect.
     *
     * @param {string} channel - One of `CHANNELS`
     * @param {object} payload
     * @param {string} payload.severity        - "WARNING" | "CRITICAL" | "RESOLVED"
     * @param {string} payload.headline         - Short human-readable headline
     * @param {string} payload.summary          - 1-2 sentence summary (also used as the preheader)
     * @param {Array<object>} [payload.rows]     - Row data; shape depends on channel —
     *   critical: `{ level, module, message, requestId, time }`;
     *   dependencies/red/system: `{ rule, scope, description, severity }`
     * @param {string}  [payload.throttleNote]   - Cooldown/suppression sentence, or ""
     * @param {object}  [payload.kv]             - Channel-specific KV placeholder values
     * @param {string}  [payload.notificationId] - Pre-built digest id; generated when omitted
     * @param {string}  [payload.firedAt]        - Pre-formatted local timestamp; computed when omitted
     * @returns {Promise<{ sent: boolean, notificationId?: string, reason?: string, cause?: string, recipientCount?: number }>}
     */
    async sendChannelDigest(channel, payload = {}) {
        const {
            severity,
            headline,
            summary,
            rows = [],
            throttleNote = "",
            kv = {},
            notificationId,
            firedAt,
        } = payload;

        if (!CHANNELS.includes(channel)) {
            logger.warning(
                notificationMessages.EMAIL_FAILED(channel, "unknown channel"),
                { _noNotify: true }, // R1b loop guard
            );
            return { sent: false, reason: "unknown-channel" };
        }

        if (!this.isEnabled()) {
            return { sent: false, reason: "disabled" };
        }

        const toEmails = await this.resolveRecipients(channel);
        if (!toEmails.length) {
            logger.warning(
                notificationMessages.EMAIL_FAILED(channel, "no resolvable recipients"),
                { _noNotify: true }, // R1b loop guard
            );
            this._recordSend(channel, null, false, headline, "no-recipients");
            return { sent: false, reason: "no-recipients" };
        }

        const id = notificationId || `NTF-${snowflake.nextId()}`;
        const fired = firedAt || this._formatLocalTime();
        const rowsHtml = rows
            .map((row, i) => this._buildRow(channel, row, i === rows.length - 1))
            .join("\n");

        const subject = `[${process.env.APP_NAME || "CATHERINE"}][${severity}] ${channel}: ${headline}`;

        const vars = {
            subject,
            preheader: summary,
            severity,
            headline,
            summary,
            notificationId: id,
            firedAt: fired,
            env: process.env.NODE_ENV || "development",
            hostname: os.hostname(),
            pid: String(process.pid),
            throttleNote,
            ...kv,
        };

        let html = this._fill(this._loadTemplate(channel), vars);
        html = this._fillRaw(html, { alertRows: rowsHtml });

        const mailOptions = {
            from: SharedTransporter.getDefaultFrom(),
            to: toEmails.join(", "),
            subject,
            text: this._buildPlainText({ headline, summary, rows, throttleNote }),
            html,
            attachments: this._logoAttachments(),
        };

        try {
            await this._transporter.sendMail(mailOptions);
            metricsStore.recordNotificationDelivery(channel, true);
            logger.info(notificationMessages.EMAIL_SENT(channel, id), {
                _noNotify: true, // R1b loop guard
            });
            this._recordSend(channel, id, true, headline, null);
            return { sent: true, notificationId: id, recipientCount: toEmails.length };
        } catch (err) {
            const cause = err?.message ?? String(err);
            metricsStore.recordNotificationDelivery(channel, false, cause);
            // R1a: fire-and-forget email failure NEVER logs above warning.
            logger.warning(notificationMessages.EMAIL_FAILED(channel, cause), {
                _noNotify: true, // R1b loop guard
            });
            this._recordSend(channel, id, false, headline, cause);
            return { sent: false, reason: "send-error", cause, recipientCount: toEmails.length };
        }
    }

    /**
     * Returns a shallow copy of the last `RECENT_SENDS_MAX` send attempts
     * (newest last), for the notification status endpoint.
     *
     * @returns {Array<{ channel: string, notificationId: string|null, sent: boolean, headline: string, reason: string|null, at: string }>}
     */
    getRecentSends() {
        return [...this._recentSends];
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    /**
     * Appends one entry to the in-memory recent-sends ring buffer, evicting
     * the oldest entry once `RECENT_SENDS_MAX` is exceeded.
     *
     * @param {string} channel
     * @param {string|null} notificationId
     * @param {boolean} sent
     * @param {string} headline
     * @param {string|null} reason
     */
    _recordSend(channel, notificationId, sent, headline, reason) {
        if (this._recentSends.length >= RECENT_SENDS_MAX) this._recentSends.shift();
        this._recentSends.push({
            channel,
            notificationId,
            sent,
            headline: headline ?? "",
            reason,
            at: new Date().toISOString(),
        });
    }

    /**
     * Formats the current local time using DB_TIMEZONE_OFFSET_MINUTES.
     * Default: 480 (UTC+8, Philippines). Mirrors `ResetRequestEmailService`.
     *
     * @returns {string} e.g. "Jul 20, 2026, 10:30 AM UTC+08:00"
     */
    _formatLocalTime() {
        const offsetMin = Number(process.env.DB_TIMEZONE_OFFSET_MINUTES ?? 480);
        const localMs = Date.now() + offsetMin * 60_000;
        const shifted = new Date(localMs);
        const sign = offsetMin >= 0 ? "+" : "-";
        const absMin = Math.abs(offsetMin);
        const hh = String(Math.floor(absMin / 60)).padStart(2, "0");
        const mm = String(absMin % 60).padStart(2, "0");
        const label = `UTC${sign}${hh}:${mm}`;
        return (
            shifted.toLocaleString("en-US", {
                timeZone: "UTC",
                dateStyle: "medium",
                timeStyle: "short",
            }) + ` ${label}`
        );
    }

    /**
     * Returns Nodemailer attachment descriptors for the AUMOVIO logo cid
     * embeddings (dark/light CSS swap). Returns `[]` when a logo file is
     * absent so emails still send. Mirrors `ResetRequestEmailService`.
     *
     * @returns {Array<{ filename: string, path: string, cid: string }>}
     */
    _logoAttachments() {
        const logoPathDark = path.join(this._assetsDir, "AUMOVIO_Logo_orange_white_RGB.png");
        const logoPathLight = path.join(this._assetsDir, "AUMOVIO_Logo_orange_black_RGB.png");

        if (!fs.existsSync(logoPathDark) || !fs.existsSync(logoPathLight)) {
            logger.warning(
                notificationMessages.EMAIL_FAILED("*", "AUMOVIO logo asset(s) not found — sending without logo"),
                { _noNotify: true }, // R1b loop guard
            );
            return [];
        }

        return [
            { filename: "AUMOVIO_Logo_orange_black_RGB.png", path: logoPathLight, cid: "meal-logo-light" },
            { filename: "AUMOVIO_Logo_orange_white_RGB.png", path: logoPathDark, cid: "meal-logo-dark" },
        ];
    }

    /**
     * Reads an HTML template file synchronously for the given channel.
     *
     * @param {string} channel - Channel key; doubles as the template filename stem
     * @returns {string} Raw HTML string
     */
    _loadTemplate(channel) {
        return fs.readFileSync(path.join(this._templateDir, `${channel}.html`), "utf8");
    }

    /**
     * Replaces every `{{key}}` placeholder present in `vars` with its
     * HTML-escaped value. Placeholders with no matching key are left
     * untouched (e.g. `{{alertRows}}`, filled separately via `_fillRaw`).
     *
     * Uses a single regex pass with a function replacer (not
     * `String#replace(str, str)`) so values containing `$`-sequences (e.g.
     * a DB error message like "cost $1,000") can never be misinterpreted as
     * replacement patterns — a deliberate divergence from the per-key
     * `new RegExp` loop used in `ResetRequestEmailService#_fill`, with
     * identical externally-observable behavior for well-formed input.
     *
     * SECURITY (CWE-79): every value is HTML-escaped before substitution.
     *
     * @param {string} html
     * @param {Record<string, string|number>} vars
     * @returns {string} Rendered HTML
     */
    _fill(html, vars) {
        return html.replace(/\{\{(\w+)\}\}/g, (match, key) => {
            if (!Object.prototype.hasOwnProperty.call(vars, key)) return match;
            return escapeHtml(vars[key]);
        });
    }

    /**
     * Replaces `{{key}}` placeholders WITHOUT escaping — use ONLY for values
     * that are already safe, fully server-built HTML (e.g. `alertRows`,
     * where every dynamic field was individually escaped by `_buildRow`
     * before concatenation).
     *
     * @param {string} html
     * @param {Record<string, string>} vars
     * @returns {string} Rendered HTML
     */
    _fillRaw(html, vars) {
        return html.replace(/\{\{(\w+)\}\}/g, (match, key) => {
            if (!Object.prototype.hasOwnProperty.call(vars, key)) return match;
            return vars[key] ?? "";
        });
    }

    /**
     * Builds one `<tr>` row of HTML for `{{alertRows}}`, dispatching to the
     * channel-appropriate markup. Every dynamic field is HTML-escaped
     * individually before being embedded — see the row-markup contract
     * documented as an HTML comment inside each template file.
     *
     * @param {string} channel
     * @param {object} row
     * @param {boolean} isLast - Whether this is the last row (adds a bottom divider)
     * @returns {string}
     */
    _buildRow(channel, row, isLast) {
        return channel === "server-critical-notification"
            ? this._buildCriticalRow(row, isLast)
            : this._buildMetricRow(row, isLast);
    }

    /**
     * Row markup for the critical channel — one row per buffered log event.
     * @param {{ level: string, module?: string, message: string, requestId?: string|null, time: string }} row
     * @param {boolean} isLast
     * @returns {string}
     */
    _buildCriticalRow({ level, module, message, requestId, time }, isLast) {
        const borderBottom = isLast ? "border-bottom:1px solid #f0f0f0;" : "";
        const sub = requestId
            ? `${escapeHtml(message)} &middot; ${escapeHtml(requestId)}`
            : escapeHtml(message);
        return `<tr>
  <td class="kv-key dm-divider" style="padding:12px 0;border-top:1px solid #f0f0f0;${borderBottom}vertical-align:top;" width="55%">
    <div class="dm-h" style="font-family:'Aumovio',Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#1a1a1a;">${escapeHtml(level)} &middot; ${escapeHtml(module || "unknown")}</div>
    <div class="dm-muted" style="font-family:'Aumovio',Arial,Helvetica,sans-serif;font-size:12px;color:#787878;margin-top:2px;">${sub}</div>
  </td>
  <td class="kv-val dm-divider" align="right" style="padding:12px 0;border-top:1px solid #f0f0f0;${borderBottom}vertical-align:top;">
    <div class="dm-mono" style="font-family:'Courier New',Courier,monospace;font-size:12px;color:#787878;">${escapeHtml(time)}</div>
  </td>
</tr>`;
    }

    /**
     * Row markup shared by the dependencies / red-metrics / system channels
     * — one row per active alert.
     * @param {{ rule: string, scope?: string, description: string, severity: string }} row
     * @param {boolean} isLast
     * @returns {string}
     */
    _buildMetricRow({ rule, scope, description, severity }, isLast) {
        const borderBottom = isLast ? "border-bottom:1px solid #f0f0f0;" : "";
        const label =
            scope && scope !== "global"
                ? `${escapeHtml(rule)} &middot; ${escapeHtml(scope)}`
                : escapeHtml(rule);
        return `<tr>
  <td class="kv-key dm-divider" style="padding:12px 0;border-top:1px solid #f0f0f0;${borderBottom}vertical-align:top;" width="55%">
    <div class="dm-h" style="font-family:'Aumovio',Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#1a1a1a;">${label}</div>
    <div class="dm-muted" style="font-family:'Aumovio',Arial,Helvetica,sans-serif;font-size:12px;color:#787878;margin-top:2px;">${escapeHtml(description)}</div>
  </td>
  <td class="kv-val dm-divider" align="right" style="padding:12px 0;border-top:1px solid #f0f0f0;${borderBottom}vertical-align:top;">
    <div class="dm-h" style="font-family:'Aumovio',Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;">${escapeHtml((severity || "").toUpperCase())}</div>
  </td>
</tr>`;
    }

    /**
     * Builds the plain-text alternative body for a digest email (non-HTML
     * mail clients, accessibility).
     *
     * @param {{ headline: string, summary: string, rows: Array<object>, throttleNote: string }} opts
     * @returns {string}
     */
    _buildPlainText({ headline, summary, rows, throttleNote }) {
        const lines = [`[${process.env.APP_NAME || "CATHERINE"}] ${headline}`, "", summary || "", ""];
        for (const row of rows) {
            if (row.level) {
                lines.push(
                    `- [${row.level}] ${row.module || "unknown"}: ${row.message}` +
                        (row.requestId ? ` (reqId: ${row.requestId})` : "") +
                        ` @ ${row.time}`,
                );
            } else {
                const scopePart = row.scope && row.scope !== "global" ? ` (${row.scope})` : "";
                lines.push(
                    `- ${row.rule}${scopePart}: ${row.description} [${(row.severity || "").toUpperCase()}]`,
                );
            }
        }
        if (throttleNote) lines.push("", throttleNote);
        return lines.join("\n");
    }
}

const instance = new ServerNotificationService();
module.exports = instance;
module.exports.ServerNotificationService = ServerNotificationService;
module.exports.CHANNELS = CHANNELS;
module.exports.maskEmail = maskEmail;
