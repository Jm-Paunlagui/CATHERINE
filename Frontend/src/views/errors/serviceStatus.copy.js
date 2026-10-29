/**
 * serviceStatus.copy.js — Fixed copy and test ids for the 523 "Service Unavailable" status panel.
 *
 * Every string the status panel and its live region can show lives HERE, frozen, and is
 * NEVER taken from the server (CWE-79 / CWE-209): the server's own title/message/Request ID are shown
 * only in the page's headline, lead and Request ID tag, outside the panel.
 *
 * Statuses: checking | unavailable | database | restarting | danger | offline | available
 * (`danger` has a `databaseDanger` copy variant when the cause is the database)
 * (see components/shared/serverStatus/useServiceRecovery.js).
 */

/** Stable automation / test targets. `check` marks the "last checked / attempt / next check" cadence block. */
export const SERVICE_STATUS_TEST_IDS = Object.freeze({
    panel: "service-status-panel",
    cta: "service-status-cta",
    check: "service-status-check",
});

export const SERVICE_STATUS_COPY = Object.freeze({
    checking: Object.freeze({
        cardTitle: "Checking the server…",
        cardBody: "Asking the server if it's awake. You don't need to refresh.",
        live: "Checking whether the service is back.",
    }),
    unavailable: Object.freeze({
        cardTitle: "Retrying automatically",
        cardBody: "We'll keep checking every few seconds.",
        live: "Service unavailable. Retrying automatically.",
    }),
    database: Object.freeze({
        cardTitle: "The database isn't responding",
        cardBody: "The server is up, but it can't reach its database. We'll keep checking.",
        live: "Database unavailable. Retrying automatically.",
    }),
    /** `danger` (60 s+) when the cause is the database. */
    databaseDanger: Object.freeze({
        cardTitle: "The database still isn't responding",
        cardBody: "Still retrying. If this lasts more than a few minutes, contact your system administrator and quote the Request ID below.",
        live: "Database still unavailable. Retrying. Contact your system administrator if this continues.",
    }),
    restarting: Object.freeze({
        cardTitle: "The server is restarting",
        cardBody: "This usually takes under a minute. We'll reconnect on our own.",
        live: "The server is restarting. Retrying automatically.",
    }),
    danger: Object.freeze({
        cardTitle: "Still unavailable",
        cardBody: "Still retrying. If this lasts more than a few minutes, contact your system administrator and quote the Request ID below.",
        live: "Service still unavailable. Retrying. Contact your system administrator if this continues.",
    }),
    offline: Object.freeze({
        cardTitle: "You're offline",
        cardBody: "We'll retry as soon as your connection is back.",
        live: "You are offline. Retrying when your connection returns.",
    }),
    available: Object.freeze({
        /** @param {string} time hh:mm:ss */
        cardTitle: (time) => `Back online at ${time}`,
        /** @param {string} downFor e.g. "3 min" */
        cardBody: (downFor) => `Down for ${downFor}. Pick up where you left off.`,
        live: "Service available. You can continue.",
    }),
});

/** Page-level copy that is not part of the panel. */
export const SERVICE_PAGE_COPY = Object.freeze({
    defaultTitle: "Service Unavailable",
    defaultSubtitle: "This is usually caused by a temporary network issue, server restart, or the application service being unavailable.",
    kicker: "The server is napping.",
    availableTitle: "Service Available",
    availableLead: "The server is back. Nothing else to do.",
    downLabel: "Error",
    availableLabel: "Status",
    availableCode: "200",
    defaultCode: "523",
    /** Shown when nothing was stashed but the probe says the API is up and its database is down. */
    databaseCode: "503",
    checkAgain: "Check again",
    continueLabel: "Continue where you left off",
    tryAnyway: "Try anyway",
    goHome: "Go to home",
    returnsTo: (path) => `Returns you to ${path}`,
});

/** Cadence line + duration copy used by `ServiceStatusPanel` (no inline strings in the component). */
export const SERVICE_CADENCE_COPY = Object.freeze({
    waiting: "Waiting for the first check…",
    // No "~" before the seconds: the Aumovio face draws it like a minus sign ("in −10 s").
    /** @param {{ time: string, attempt: number, seconds: number }} v */
    line: ({ time, attempt, seconds }) => `Last checked ${time} · Attempt ${attempt} · Next check in ${seconds} s`,
    /** The due time has passed: the probe is in flight. */
    checkingNow: "Checking now…",
    /** @param {{ time: string, attempt: number }} v */
    lineChecking: ({ time, attempt }) => `Last checked ${time} · Attempt ${attempt} · Checking now…`,
    lessThanAMinute: "less than a minute",
    /** @param {number} n whole minutes */
    minutes: (n) => `${n} min`,
});

const pad = (n) => String(n).padStart(2, "0");

/** @param {number} ms Epoch ms. @returns {string} Local hh:mm:ss (24 h). */
export function formatClock(ms) {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** @param {number} ms Duration. @returns {string} "less than a minute" | "n min". */
export function formatDownFor(ms) {
    const mins = Math.round(Math.max(0, ms) / 60000);
    return mins < 1 ? SERVICE_CADENCE_COPY.lessThanAMinute : SERVICE_CADENCE_COPY.minutes(mins);
}

export const DOWN_STATUSES = Object.freeze(["checking", "unavailable", "database", "restarting", "danger", "offline"]);
