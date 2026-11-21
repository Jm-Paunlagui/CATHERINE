

/**
 * @fileoverview Log message templates for the Integrity Center feature.
 *
 * Per the three-bucket constants rule, every string passed to logger.* lives
 * here — never inline in the model/service/controller. Each entry is a pure
 * template function (no state) so call sites read declaratively.
 */

const integrityMessages = {
    // ── Tamper sweep ────────────────────────────────────────────────────────
    SWEEP_STARTED: (table: any, scopeKey: any) =>
        `Integrity tamper sweep started — table=${table}, scope=${scopeKey}`,
    SWEEP_COMPLETE: (table: any, scanned: any, tampered: any, truncated: any) =>
        `Integrity tamper sweep complete — table=${table}, scanned=${scanned}, tampered=${tampered}, truncated=${truncated}`,
    SWEEP_TRUNCATED: (table: any, cap: any) =>
        `Integrity tamper sweep hit the scan cap (${cap} rows) for table=${table} — scope the request by date for a complete result`,

    // ── Browse / page ───────────────────────────────────────────────────────
    BROWSE_PAGE: (table: any, page: any, limit: any) =>
        `Integrity browse — table=${table}, page=${page}, limit=${limit}`,

    // ── Rescan (cache invalidation) ─────────────────────────────────────────
    RESCAN_REQUESTED: (table: any, scopeKey: any, actor: any) =>
        `Integrity rescan requested — table=${table}, scope=${scopeKey}, by=${actor}`,

    // ── SSE live-tail ───────────────────────────────────────────────────────
    SSE_CONNECTED: (table: any, actor: any) =>
        `Integrity stream connected — table=${table}, by=${actor}`,
    SSE_DISCONNECTED: (table: any, actor: any) =>
        `Integrity stream disconnected — table=${table}, by=${actor}`,
    SSE_BASELINE: (table: any, maxPk: any) =>
        `Integrity stream baseline set — table=${table}, maxPk=${maxPk}`,
    SSE_UPDATE_SENT: (table: any, newCount: any, tampered: any) =>
        `Integrity stream update — table=${table}, newRows=${newCount}, tampered=${tampered}`,
    SSE_POLL_ERROR: (table: any, message: any) =>
        `Integrity stream poll error — table=${table}: ${message}`,
    SSE_BASELINE_FAILED: (table: any, message: any) =>
        `Integrity stream baseline lookup failed before upgrade — table=${table}: ${message}`,
    SSE_POLL_STARTED: () => "Integrity stream shared poller started.",
    SSE_POLL_STOPPED: () => "Integrity stream shared poller stopped.",
    SSE_MAX_ERRORS: (count: any, max: any) =>
        `Integrity stream poller exceeded ${max} consecutive errors (${count} connections notified) — stopping`,

    // ── Signed system config (SystemConfigService) ──────────────────────────
    CONFIG_MISSING: (key: any) =>
        `T_SYSTEM_CONFIG key "${key}" is missing or unreadable — using its safe default.`,
    CONFIG_UNSIGNED: (key: any) =>
        `T_SYSTEM_CONFIG key "${key}" has no ROW_HASH (seeded in SQL, never written by the app) — using its safe default until it is set once.`,
    CONFIG_TAMPERED: (key: any) =>
        `T_SYSTEM_CONFIG key "${key}" FAILED ROW_HASH verification — possible tampering; using its safe default.`,
    CONFIG_CHANGED: (key: any, previous: any, next: any, updatedBy: any) =>
        `T_SYSTEM_CONFIG key "${key}" changed from "${previous}" to "${next}" by ${updatedBy}.`,
};

export { integrityMessages };
