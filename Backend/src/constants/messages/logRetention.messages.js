"use strict";

/**
 * @fileoverview Log file retention sweep messages (`LogRetentionService`).
 * Used ONLY in logger calls — never thrown or sent to clients.
 *
 * ⚠ `messages/index.js` spreads every namespace into ONE flat object — every
 * key here MUST carry the `LOG_RETENTION_` prefix, or it silently overwrites
 * a same-named key from one of the other 32 namespaces with no error.
 */

const logRetentionMessages = {
  LOG_RETENTION_DISABLED: () =>
    `Log retention sweep disabled — LOG_RETENTION_DAYS=0.`,
  LOG_RETENTION_INVALID_DAYS: (raw, fallback) =>
    `Log retention: LOG_RETENTION_DAYS="${raw}" is not a valid positive number — falling back to ${fallback} day(s).`,
  LOG_RETENTION_STARTED: (days, checkMs) =>
    `Log retention sweep started — retaining ${days} day(s), checked every ${checkMs}ms.`,
  LOG_RETENTION_SWEEP_DONE: (removedDays, freedHuman, days) =>
    `Log retention sweep complete — removed ${removedDays} day dir(s), freed ${freedHuman}, retention ${days} day(s).`,
  LOG_RETENTION_DAY_FAILED: (dayLabel, errMsg) =>
    `Log retention: day dir ${dayLabel} removal failed: ${errMsg}.`,
  LOG_RETENTION_BUDGET_ABORT: (failed, budget) =>
    `Log retention sweep aborted — ${failed} failed day dir(s) reached the budget of ${budget}. Remaining days retried next sweep.`,
  LOG_RETENTION_SWEEP_FAILED: (errMsg) =>
    `Log retention sweep failed unexpectedly: ${errMsg}.`,
};

module.exports = { logRetentionMessages };
