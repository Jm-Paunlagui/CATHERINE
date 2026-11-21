

/**
 * @fileoverview Log message templates for the Integrity Center feature.
 *
 * Per the three-bucket constants rule, every string passed to logger.* lives
 * here — never inline in the model/service/controller. Each entry is a pure
 * template function (no state) so call sites read declaratively.
 */

const integrityMessages = {
    // ── Tamper sweep ────────────────────────────────────────────────────────
    SWEEP_STARTED: (table: unknown, scopeKey: unknown) =>
        `Integrity tamper sweep started — table=${table}, scope=${scopeKey}`,
    SWEEP_COMPLETE: (table: unknown, scanned: unknown, tampered: unknown, truncated: unknown) =>
        `Integrity tamper sweep complete — table=${table}, scanned=${scanned}, tampered=${tampered}, truncated=${truncated}`,
    SWEEP_TRUNCATED: (table: unknown, cap: unknown) =>
        `Integrity tamper sweep hit the scan cap (${cap} rows) for table=${table} — scope the request by date for a complete result`,

    // ── Browse / page ───────────────────────────────────────────────────────
    BROWSE_PAGE: (table: unknown, page: unknown, limit: unknown) =>
        `Integrity browse — table=${table}, page=${page}, limit=${limit}`,

    // ── Rescan (cache invalidation) ─────────────────────────────────────────
    RESCAN_REQUESTED: (table: unknown, scopeKey: unknown, actor: unknown) =>
        `Integrity rescan requested — table=${table}, scope=${scopeKey}, by=${actor}`,

    // ── SSE live-tail ───────────────────────────────────────────────────────
    SSE_CONNECTED: (table: unknown, actor: unknown) =>
        `Integrity stream connected — table=${table}, by=${actor}`,
    SSE_DISCONNECTED: (table: unknown, actor: unknown) =>
        `Integrity stream disconnected — table=${table}, by=${actor}`,
    SSE_BASELINE: (table: unknown, maxPk: unknown) =>
        `Integrity stream baseline set — table=${table}, maxPk=${maxPk}`,
    SSE_UPDATE_SENT: (table: unknown, newCount: unknown, tampered: unknown) =>
        `Integrity stream update — table=${table}, newRows=${newCount}, tampered=${tampered}`,
    SSE_POLL_ERROR: (table: unknown, message: unknown) =>
        `Integrity stream poll error — table=${table}: ${message}`,
    SSE_BASELINE_FAILED: (table: unknown, message: unknown) =>
        `Integrity stream baseline lookup failed before upgrade — table=${table}: ${message}`,
    SSE_POLL_STARTED: () => "Integrity stream shared poller started.",
    SSE_POLL_STOPPED: () => "Integrity stream shared poller stopped.",
    SSE_MAX_ERRORS: (count: unknown, max: unknown) =>
        `Integrity stream poller exceeded ${max} consecutive errors (${count} connections notified) — stopping`,

    // ── Signed system config (SystemConfigService) ──────────────────────────
    CONFIG_MISSING: (key: unknown) =>
        `T_SYSTEM_CONFIG key "${key}" is missing or unreadable — using its safe default.`,
    CONFIG_UNSIGNED: (key: unknown) =>
        `T_SYSTEM_CONFIG key "${key}" has no ROW_HASH (seeded in SQL, never written by the app) — using its safe default until it is set once.`,
    CONFIG_TAMPERED: (key: unknown) =>
        `T_SYSTEM_CONFIG key "${key}" FAILED ROW_HASH verification — possible tampering; using its safe default.`,
    CONFIG_CHANGED: (key: unknown, previous: unknown, next: unknown, updatedBy: unknown) =>
        `T_SYSTEM_CONFIG key "${key}" changed from "${previous}" to "${next}" by ${updatedBy}.`,
};

export { integrityMessages };
