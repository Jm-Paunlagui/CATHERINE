"use strict";

/**
 * @fileoverview Log message templates for `InFlightTaskRegistry`
 * (`src/utils/InFlightTaskRegistry.js`) — the process-level registry of
 * detached ("fire-and-forget") promises that `gracefulShutdown` drains
 * before the Oracle pools and SMTP transporter are torn down (D4).
 * Used ONLY in logger calls — never thrown or sent to clients.
 *
 * ⚠ `messages/index.js` spreads every namespace into ONE flat object — every
 * key here MUST carry the `TASK_DRAIN_` prefix, or it silently overwrites a
 * same-named key from one of the other namespaces with no error.
 */

const inFlightMessages = {
    /**
     * Emitted by `drain()` only when there is at least one tracked task —
     * silent on the common empty-registry path, so a clean restart that has
     * nothing detached in flight gains no new log line.
     * @param {number} count - Tasks tracked at the moment the drain began.
     * @param {number} budgetMs - The bounded wait, in ms.
     * @returns {string}
     */
    TASK_DRAIN_START: (count, budgetMs) =>
        `TASK_DRAIN_START — ${count} in-flight task(s) tracked; waiting up to ${budgetMs}ms for them to settle before closing DB pools and the SMTP transporter.`,

    /**
     * The clean path: every tracked task settled inside the budget.
     * @param {number} drained - Tasks that settled within the budget.
     * @param {number} elapsedMs - Wall-clock time actually spent waiting.
     * @returns {string}
     */
    TASK_DRAIN_COMPLETE: (drained, elapsedMs) =>
        `TASK_DRAIN_COMPLETE — ${drained} in-flight task(s) settled in ${elapsedMs}ms.`,

    /**
     * The drain budget expired with tasks still tracked — they are
     * abandoned, not cancelled, and shutdown continues tearing down the DB
     * pools and SMTP transporter regardless. `labels` is the only forensic
     * link from an abandoned task back to what it was (e.g. a
     * task label), so it is always logged in full.
     * @param {number} abandoned - Tasks still tracked when the budget expired.
     * @param {number} budgetMs - The bounded wait that expired, in ms.
     * @param {string[]} labels - Labels of the abandoned tasks.
     * @returns {string}
     */
    TASK_DRAIN_ABANDONED: (abandoned, budgetMs, labels) =>
        `TASK_DRAIN_ABANDONED — ${abandoned} in-flight task(s) still running after the ${budgetMs}ms drain budget: ${labels.join(", ")}.`,
};

module.exports = { inFlightMessages };
