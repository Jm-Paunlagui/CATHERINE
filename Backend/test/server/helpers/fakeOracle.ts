"use strict";

/**
 * @fileoverview FakeOracle — a deterministic in-memory Oracle connection for
 * simulation / chaos testing of the bulk-write paths WITHOUT a live database.
 *
 * It understands ONLY the exact statement shapes the oracle-mongo-wrapper
 * emits for the bulk paths under test:
 *   - SELECT … FROM "T" …                 (find().toArray() existence reads)
 *   - INSERT INTO "T" (cols) VALUES (:vN) [RETURNING "C" INTO :out_C]
 *     via executeMany — with optional { batchErrors }
 *   - UPDATE "T" SET "C"=:sN[,…] WHERE "K"=:kN[ AND …]
 *     via executeMany (bulkUpdateByKeys)
 *   - INSERT … via single execute (insertOne)
 * Anything else throws loudly, so a test can never silently pass against an
 * unrecognised statement.
 *
 * It enforces declared UNIQUE constraints (raising an ORA-00001 Error, exactly
 * like Oracle) and provides real transaction semantics: each withTransaction
 * snapshots every table, commit() keeps the changes, rollback() restores the
 * snapshot. This lets the tests prove the money invariants (exactly-once
 * wallet + reset-log, atomic chunk rollback, idempotent re-run) against the
 * REAL production code, not a re-implementation.
 *
 * Connection-acquisition / network failures are injected via
 * store.failNextTransaction() (throws before the callback runs) and
 * conn.failOn(predicate) (throws inside a specific statement) for chaos tests.
 */

/** Deep-ish clone sufficient for plain row objects (values are scalars/Dates). */
function cloneRows(rows) {
    return rows.map((r) => ({ ...r }));
}

/**
 * In-memory multi-table store with declared identity columns and unique keys.
 */
class FakeOracleStore {
    /**
     * @param {Record<string, { idColumn?: string, unique?: string[][] }>} schema
     *   Per-table config: idColumn (IDENTITY column to auto-assign) and unique
     *   key column groups (each group is an array of column names).
     */
    constructor(schema = {}) {
        /** @type {Map<string, { rows: object[], nextId: number, idColumn: string|null, unique: string[][] }>} */
        this.tables = new Map();
        for (const [name, cfg] of Object.entries(schema)) {
            this.tables.set(name, {
                rows: [],
                nextId: 1,
                idColumn: cfg.idColumn ?? null,
                unique: cfg.unique ?? [],
            });
        }
        /** Counts of statements executed (for performance assertions). */
        this.stats = { execute: 0, executeMany: 0, select: 0, insert: 0, update: 0, commit: 0, rollback: 0 };
        this._failNextTx = 0;
        /** Optional hook invoked with each freshly-created connection (chaos). */
        this._connHook = null;
    }

    /**
     * Register a hook called with every connection the transaction wrapper
     * creates internally — the only way a test can reach that connection to
     * inject a mid-statement failure via conn.failOn(...).
     * @param {(conn: FakeOracleConnection) => void} fn
     */
    onConnection(fn) {
        this._connHook = fn;
    }

    table(name) {
        if (!this.tables.has(name)) {
            throw new Error(`FakeOracle: unknown table "${name}"`);
        }
        return this.tables.get(name);
    }

    rows(name) {
        return this.table(name).rows;
    }

    /** Inject N consecutive connection-acquisition failures (chaos). */
    failNextTransaction(n = 1) {
        this._failNextTx += n;
    }

    snapshot() {
        const snap = new Map();
        for (const [name, t] of this.tables) {
            snap.set(name, { rows: cloneRows(t.rows), nextId: t.nextId });
        }
        return snap;
    }

    restore(snap) {
        for (const [name, s] of snap) {
            const t = this.tables.get(name);
            t.rows = cloneRows(s.rows);
            t.nextId = s.nextId;
        }
    }

    /** Throws ORA-00001 if `candidate` violates any unique key of `t`. */
    _assertUnique(t, candidate) {
        for (const keyCols of t.unique) {
            const clash = t.rows.some((r) =>
                keyCols.every((c) => r[c] === candidate[c]),
            );
            if (clash) {
                const err = new Error(
                    `ORA-00001: unique constraint violated (${keyCols.join(",")})`,
                );
                err.ora = 1;
                throw err;
            }
        }
    }
}

/**
 * A fake connection bound to a FakeOracleStore. One instance is handed to each
 * withTransaction callback; it mutates the store's live rows and the owning
 * transaction wrapper commits/rolls back via the store snapshot.
 */
class FakeOracleConnection {
    constructor(store) {
        this.store = store;
        /** Optional chaos predicate: (kind, sql) => boolean; throws when true. */
        this._failOn = null;
    }

    /** Inject a mid-statement failure (chaos). predicate(kind, sql) → throw. */
    failOn(predicate) {
        this._failOn = predicate;
    }

    _maybeFail(kind, sql) {
        if (this._failOn && this._failOn(kind, sql)) {
            throw new Error("ORA-03113: end-of-file on communication channel");
        }
    }

    // ── INSERT/UPDATE/SELECT parsing helpers ────────────────────────────────
    static _parseInsert(sql) {
        const m = sql.match(
            /INSERT\s+INTO\s+"(\w+)"\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)(?:\s+RETURNING\s+"(\w+)"\s+INTO)?/i,
        );
        if (!m) return null;
        return {
            table: m[1],
            cols: m[2].split(",").map((s) => s.trim().replace(/"/g, "")),
            returningCol: m[4] || null,
        };
    }

    static _parseUpdate(sql) {
        const m = sql.match(/UPDATE\s+"(\w+)"\s+SET\s+(.+?)\s+WHERE\s+(.+)/is);
        if (!m) return null;
        const parsePairs = (frag, sep) =>
            frag.split(sep).map((p) => {
                const pm = p.trim().match(/"(\w+)"\s*=\s*:(\w+)/);
                return { col: pm[1], bind: pm[2] };
            });
        return {
            table: m[1],
            sets: parsePairs(m[2], ","),
            keys: parsePairs(m[3], /\s+AND\s+/i),
        };
    }

    static _tableFromSelect(sql) {
        const m = sql.match(/FROM\s+"?(\w+)"?/i);
        return m ? m[1] : null;
    }

    // ── conn.execute (single statement) ─────────────────────────────────────
    async execute(sql, binds = {}, _opts = {}) {
        this.store.stats.execute++;
        this._maybeFail("execute", sql);

        if (/^\s*SELECT/i.test(sql)) {
            this.store.stats.select++;
            const table = FakeOracleConnection._tableFromSelect(sql);
            return { rows: cloneRows(this.store.rows(table)) };
        }

        if (/^\s*INSERT/i.test(sql)) {
            const parsed = FakeOracleConnection._parseInsert(sql);
            if (!parsed) throw new Error(`FakeOracle: unparseable INSERT: ${sql}`);
            const t = this.store.table(parsed.table);
            const row = {};
            parsed.cols.forEach((c, i) => {
                row[c] = binds[`v${i}`] ?? null;
            });
            const outBinds = {};
            if (parsed.returningCol || t.idColumn) {
                const idCol = parsed.returningCol || t.idColumn;
                row[idCol] = t.nextId++;
                outBinds[`out_${idCol}`] = [row[idCol]];
            }
            this.store._assertUnique(t, row);
            t.rows.push(row);
            this.store.stats.insert++;
            return { rowsAffected: 1, outBinds, lastRowid: `rid${t.rows.length}` };
        }

        if (/^\s*UPDATE/i.test(sql)) {
            // Single-row UPDATE (e.g. updateOne ROWID form is not emitted by the
            // bulk paths; support plain UPDATE … WHERE for completeness).
            const parsed = FakeOracleConnection._parseUpdate(sql);
            if (!parsed) throw new Error(`FakeOracle: unparseable UPDATE: ${sql}`);
            const t = this.store.table(parsed.table);
            let affected = 0;
            for (const r of t.rows) {
                if (parsed.keys.every((k) => r[k.col] === binds[k.bind])) {
                    for (const s of parsed.sets) r[s.col] = binds[s.bind] ?? null;
                    affected++;
                }
            }
            this.store.stats.update++;
            return { rowsAffected: affected };
        }

        throw new Error(`FakeOracle: unsupported execute SQL: ${sql}`);
    }

    // ── conn.executeMany (bulk) ──────────────────────────────────────────────
    async executeMany(sql, bindRows, opts = {}) {
        this.store.stats.executeMany++;
        this._maybeFail("executeMany", sql);

        // Stored-procedure / PL/SQL block (e.g. SP_ARCHIVE_EMP_MASTER) — the
        // fake treats it as a no-op success so the surrounding bulk UPDATE path
        // is still exercised. Tests that care about archive side-effects assert
        // on the subsequent UPDATE, not the SP body.
        if (/^\s*BEGIN/i.test(sql)) {
            return { rowsAffected: Array.isArray(bindRows) ? bindRows.length : 0 };
        }

        if (/^\s*INSERT/i.test(sql)) {
            const parsed = FakeOracleConnection._parseInsert(sql);
            if (!parsed) throw new Error(`FakeOracle: unparseable INSERT: ${sql}`);
            const t = this.store.table(parsed.table);
            const outBinds = [];
            const batchErrors = [];
            let affected = 0;

            bindRows.forEach((bind, offset) => {
                const row = {};
                parsed.cols.forEach((c, i) => {
                    row[c] = bind[`v${i}`] ?? null;
                });
                const idCol = parsed.returningCol || t.idColumn;
                // Try unique enforcement first WITHOUT consuming an id.
                try {
                    this.store._assertUnique(t, row);
                } catch (err) {
                    if (opts.batchErrors) {
                        batchErrors.push({ offset, message: err.message });
                        return; // skip this row, continue the batch
                    }
                    throw err; // whole statement fails (no batchErrors)
                }
                if (idCol) {
                    row[idCol] = t.nextId++;
                    outBinds.push({ [`out_${idCol}`]: [row[idCol]] });
                }
                t.rows.push(row);
                affected++;
            });

            this.store.stats.insert += affected;
            const result = { rowsAffected: affected };
            if (parsed.returningCol) result.outBinds = outBinds;
            if (opts.batchErrors) result.batchErrors = batchErrors;
            return result;
        }

        if (/^\s*UPDATE/i.test(sql)) {
            const parsed = FakeOracleConnection._parseUpdate(sql);
            if (!parsed) throw new Error(`FakeOracle: unparseable UPDATE: ${sql}`);
            const t = this.store.table(parsed.table);
            let affected = 0;
            for (const bind of bindRows) {
                for (const r of t.rows) {
                    if (parsed.keys.every((k) => r[k.col] === bind[k.bind])) {
                        for (const s of parsed.sets) r[s.col] = bind[s.bind] ?? null;
                        affected++;
                    }
                }
            }
            this.store.stats.update += affected;
            return { rowsAffected: affected };
        }

        throw new Error(`FakeOracle: unsupported executeMany SQL: ${sql}`);
    }
}

/**
 * Installs vi.spyOn mocks on the real `src/config` so the production model code
 * (which calls config.withTransaction / config.withConnection) runs against a
 * FakeOracleStore. Returns the store + a restore() to undo the spies.
 *
 * @param {object} config - require("../../../src/config")
 * @param {object} schema - table schema for FakeOracleStore
 * @returns {{ store: FakeOracleStore, restore: () => void }}
 */
function installFakeOracle(config, schema) {
    const store = new FakeOracleStore(schema);

    const runTx = async (_name, fn) => {
        if (store._failNextTx > 0) {
            store._failNextTx--;
            throw new Error(
                "ORA-24418: Cannot open further sessions (pool exhausted)",
            );
        }
        const conn = new FakeOracleConnection(store);
        if (store._connHook) store._connHook(conn);
        const snap = store.snapshot();
        try {
            const result = await fn(conn);
            store.stats.commit++;
            return result;
        } catch (err) {
            store.restore(snap);
            store.stats.rollback++;
            throw err;
        }
    };

    const runConn = async (_name, fn) => {
        if (store._failNextTx > 0) {
            store._failNextTx--;
            throw new Error("ORA-24418: Cannot open further sessions");
        }
        const conn = new FakeOracleConnection(store);
        if (store._connHook) store._connHook(conn);
        return fn(conn);
    };

    const txSpy = vi.spyOn(config, "withTransaction").mockImplementation(runTx);
    const connSpy = vi.spyOn(config, "withConnection").mockImplementation(runConn);

    return {
        store,
        restore() {
            txSpy.mockRestore();
            connSpy.mockRestore();
        },
    };
}

module.exports = {
    FakeOracleStore,
    FakeOracleConnection,
    installFakeOracle,
};
