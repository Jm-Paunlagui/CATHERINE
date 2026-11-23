"use strict";

/**
 * @fileoverview Load a FRESH copy of the Oracle adapter for one test.
 *
 * src/config/adapters/oracle.ts keeps module-level state — the pool registry
 * (`name → Promise<Pool>`), the PoolHealthMonitor and its 30 s interval
 * (started at module load), and the `isShuttingDown` flag. Tests that prove
 * behaviour of that state (a cached rejected pool promise, a leaked health-check
 * connection, a pool the monitor never sees) need a copy nobody else has
 * touched, so this helper imports a SEPARATE instance of the adapter module
 * (a unique `?fresh=N` query makes Vite evaluate the file again) while every
 * dependency it imports (database, metrics store, logger) stays the shared
 * instance the rest of the test and src see.
 *
 * Usage (order matters):
 *
 *   vi.useFakeTimers();            // BEFORE load → the monitor interval is faked
 *   Math.random = () => 0;         // retry jitter → 0 ms (restore it yourself)
 *   const { adapter, restore } = await loadFreshAdapter({ createPool });
 *   ...
 *   restore();                     // BEFORE vi.useRealTimers()
 *   vi.useRealTimers();
 *
 * What it patches, and how each is put back by `restore()`:
 *   - `require("oracledb").createPool` → the caller's stub. Restored to whatever
 *     was there before.
 *   - The shared adapter instance (the one src/config/index.ts holds) is never
 *     touched; the fresh copy lives only under its own query-string module id.
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

import oracledb from "oracledb";
import database from "../../../src/config/database";

const ADAPTER_SPEC = "../../../src/config/adapters/oracle";
let freshSeq = 0;

/**
 * @param {object} opts
 * @param {(cfg: object) => Promise<object>} opts.createPool - Stub installed as
 *   `oracledb.createPool` for the lifetime of the fresh adapter.
 * @returns {Promise<{ adapter: object, restore: () => void }>}
 */
async function loadFreshAdapter({ createPool }: Record<string, any> = {}) {
    if (typeof createPool !== "function") {
        throw new TypeError("loadFreshAdapter: createPool stub is required.");
    }

    // Load the shared copy first so it is evaluated against the real config,
    // never against the placeholder patch below.
    await import(ADAPTER_SPEC);

    const ora: any = oracledb;
    const db: any = database;
    const prevCreatePool = ora.createPool;
    const realGetConnectionConfig = db.getConnectionConfig;

    ora.createPool = createPool;
    db.getConnectionConfig = function freshAdapterConnectionConfig(name: string) {
        const cfg = realGetConnectionConfig(name); // still throws on unknown names
        return {
            ...cfg,
            user: `fresh_adapter_${name}`,
            password: "fresh-adapter-placeholder",
            connectString: "127.0.0.1:1/FRESH_ADAPTER_PLACEHOLDER",
        };
    };
    let adapter: any;
    try {
        freshSeq += 1;
        adapter = await import(/* @vite-ignore */ `${ADAPTER_SPEC}?fresh=${freshSeq}`);
    } finally {
        db.getConnectionConfig = realGetConnectionConfig;
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
        ora.createPool = prevCreatePool;
    }

    return { adapter, restore };
}

export { loadFreshAdapter };
