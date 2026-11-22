

/**
 * @fileoverview Log message templates for the metrics subsystem.
 * Used ONLY in logger.* calls — never thrown or sent to clients.
 *
 * Rule: all logger.info/logger.warning/logger.error strings for metrics features must
 * reference a named template from this file. Use logger.warning() — not logger.warn().
 */

const metricsMessages = {
    /**
     * Logged when the full metrics snapshot is retrieved.
     * @returns {string}
     */
    SNAPSHOT_FETCHED: (): string => "Metrics snapshot fetched",

    /**
     * Logged when the summary metrics are retrieved.
     * @returns {string}
     */
    SUMMARY_FETCHED: (): string => "Metrics summary fetched",

    /**
     * Logged when alert evaluations are retrieved.
     * @returns {string}
     */
    ALERTS_FETCHED: (): string => "Alert evaluations fetched",

    /**
     * Logged when an alert rule fires against the current snapshot.
     * @param {string} rule     - Alert rule identifier (e.g. "HIGH_ERROR_RATE")
     * @param {string} severity - Severity level ("warning" | "critical" | "emergency")
     * @returns {string}
     */
    ALERT_TRIGGERED: (rule: string, severity: string): string =>
        `Alert triggered: ${rule} [${severity}]`,

    /**
     * Logged when the frontend metrics ingestion endpoint receives a payload.
     * @param {number} count - Number of events in the payload
     * @returns {string}
     */
    FRONTEND_INGESTED: (count: number): string =>
        `Frontend metrics ingested: ${count} event(s)`,

    /**
     * Logged when the frontend metrics payload fails basic validation.
     * @param {string} reason - Human-readable rejection reason
     * @returns {string}
     */
    FRONTEND_REJECTED: (reason: string): string =>
        `Frontend metrics payload rejected: ${reason}`,
};

export { metricsMessages };
