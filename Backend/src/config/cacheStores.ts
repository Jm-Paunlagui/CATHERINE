/**
 * Cache store registration (side-effect module).
 *
 * Imported by src/app.ts above the routes import. Routes and controllers
 * resolve their stores at module-evaluation time, and ESM runs every import
 * before the importing module's body, so registration cannot live in app.ts's
 * own body: it would run after the routes had already failed to resolve.
 */
import { registry, ClusterCacheSync } from "../middleware/cache";
registry.registerAll({
    // ── Admin roster ──────────────────────────────────────────────────────────────
    // Small dataset (<100 admins). Queried by admin list. Mutates only on admin
    // CRUD. maxKeys=50 is a hard ceiling.
    adminList: { ttl: 600, checkPeriod: 120, maxKeys: 50 },

    // ── Audit log ─────────────────────────────────────────────────────────────────
    // Logs grow continuously; 120s TTL prevents serving stale security telemetry
    // while reducing Oracle pressure for admin polling. maxKeys=200 covers
    // concurrent admin sessions browsing the list, stats, and per-requestId views.
    auditLog: { ttl: 120, checkPeriod: 30, maxKeys: 200 },

    // ── Auth profile (/auth/me) ───────────────────────────────────────────────────
    // Per-user profile cache. /me fires on every page focus; 30s staleness is
    // harmless since role/active changes take effect on next refresh.
    authProfile: { ttl: 30, checkPeriod: 15, maxKeys: 10000 },

    // ── Integrity Center (SUPER_ADMIN only) ───────────────────────────────────
    // Caches per-(table, scope) tamper-sweep results; the Re-scan button
    // invalidates the exact key on demand.
    integrity: { ttl: 180, checkPeriod: 60, maxKeys: 500 },

    // ── Add project-specific cache stores below ───────────────────────────────────
    // Example:
    // myFeature: { ttl: 300, checkPeriod: 60, maxKeys: 200 },
});

// Cross-worker cache invalidation (ENABLE_CLUSTERING=true): apply sibling
// workers' invalidations to this worker's stores so no worker serves stale
// data after a write. No-op in single-process mode. Must run AFTER
// registerAll so every relayed store name resolves.
ClusterCacheSync.initWorker(registry);
