"use strict";

/**
 * @fileoverview Load a FRESH copy of the Oracle adapter for one test.
 *
 * src/config/adapters/oracle.js keeps module-level state — the pool registry
 * (`name → Promise<Pool>`), the PoolHealthMonitor and its 30 s interval
 * (started at module load), and the `isShuttingDown` flag. Tests that prove
 * behaviour of that state (a cached rejected pool promise, a leaked health-check
 * connection, a pool the monitor never sees) need a copy nobody else has
 * touched, so this helper evicts the adapter from `require.cache` and
 * re-requires it.
 *
 * Usage (order matters):
 *
 *   vi.useFakeTimers();            // BEFORE load → the monitor interval is faked
 *   Math.random = () => 0;         // retry jitter → 0 ms (restore it yourself)
 *   const { adapter, restore } = loadFreshAdapter({ createPool });
 *   ...
 *   restore();                     // BEFORE vi.useRealTimers()
 *   vi.useRealTimers();
 *
 * What it patches, and how each is put back by `restore()`:
 *   - `require("oracledb").createPool` → the caller's stub. Restored to whatever
 *     was there before.
 *   - `require.cache[<adapter>]` → the fresh copy. The previous cache entry
 *     (the copy src/config/index.js already holds) is put back, so a later
 *     require of the adapter in the same file sees the original singleton.
 *   - `database.getConnectionConfig` → patched ONLY for the duration of the
 *     re-require (the adapter destructures it at load). The fresh copy's
 *     captured reference returns the real pool config with the credentials and
 *     connect string replaced by inert placeholders, so `_validateConfig` passes
 *     on any machine (with or without `.env.test`) and no real credential is
 *     ever handed to a stub.
 *
 * `restore()` also calls the fresh adapter's `closeAll()` (not awaited): its
 * synchronous prefix stops the fresh health-monitor interval. Call it while fake
 * timers are still installed so closeAll's 30 s shutdown-race timers are fake
 * too and are discarded by `vi.useRealTimers()`.
 */

const path = require("path");

const ADAPTER_PATH = require.resolve(
    path.join(__dirname, "../../../src/config/adapters/oracle"),
);
const DATABASE_PATH = require.resolve(
    path.join(__dirname, "../../../src/config/database"),
);

/**
 * @param {object} opts
 * @param {(cfg: object) => Promise<object>} opts.createPool - Stub installed as
 *   `oracledb.createPool` for the lifetime of the fresh adapter.
 * @returns {{ adapter: object, restore: () => void }}
 */
function loadFreshAdapter({ createPool } = {}) {
    if (typeof createPool !== "function") {
        throw new TypeError("loadFreshAdapter: createPool stub is required.");
    }

    // Ensure the shared copy (and database.js) are loaded first, so the entry we
    // stash below is the singleton everyone else holds.
    require(ADAPTER_PATH);
    const database = require(DATABASE_PATH);
    const oracledb = require("oracledb");

    const prevCreatePool = oracledb.createPool;
    const prevCacheEntry = require.cache[ADAPTER_PATH];
    const realGetConnectionConfig = database.getConnectionConfig;

    oracledb.createPool = createPool;

    delete require.cache[ADAPTER_PATH];
    database.getConnectionConfig = function freshAdapterConnectionConfig(name) {
        const cfg = realGetConnectionConfig(name); // still throws on unknown names
        return {
            ...cfg,
            user: `fresh_adapter_${name}`,
            password: "fresh-adapter-placeholder",
            connectString: "127.0.0.1:1/FRESH_ADAPTER_PLACEHOLDER",
        };
    };
    let adapter;
    try {
        adapter = require(ADAPTER_PATH);
    } finally {
        database.getConnectionConfig = realGetConnectionConfig;
    }

    let restored = false;
    function restore() {
        if (restored) return;
        restored = true;
        try {
            adapter.closeAll().catch(() => {});
        } catch {
            // closeAll's sync prefix never throws today; never fail a teardown on it.
        }
        oracledb.createPool = prevCreatePool;
        if (prevCacheEntry) require.cache[ADAPTER_PATH] = prevCacheEntry;
        else delete require.cache[ADAPTER_PATH];
    }

    return { adapter, restore };
}

module.exports = { loadFreshAdapter };
