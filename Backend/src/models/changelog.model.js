"use strict";

/**
 * ChangelogModel
 *
 * Persists changelog entries in an AES-256-GCM encrypted JSON file.
 *
 * File location : <projectRoot>/data/changelog.enc
 * File format   : JSON { iv, authTag, ciphertext } — all hex-encoded
 * Key source    : process.env.CHANGELOG_ENCRYPTION_KEY (64-char hex → 32 bytes)
 *                 Falls back to first 32 bytes of DATA_SIGNING_SECRET when key absent.
 *
 * Entry shape:
 *   id          string   crypto.randomUUID()
 *   displayDate string   YYYY-MM-DD (adjusted: Sat→Fri, Sun→Mon)
 *   version     string   semver, optional release-stage tag
 *                        (e.g. "1.15.0" stable, or "1.19.0-beta.1" pre-release).
 *                        Stage (dev|alpha|beta|rc|stable) is DERIVED from this
 *                        tag — there is no separate stage field.
 *   title       string
 *   message     string   short headline summary (1–2 sentences, user-friendly)
 *   whatChanged object[] structured bullet list: { text: string, items?: string[] }
 *   type        string   breaking|feat|fix|patch|perf|refactor|security|docs|chore
 *   authors     string[]
 *   coAuthors   string[]
 *   createdAt   string   ISO 8601
 *   updatedAt   string   ISO 8601
 *
 * To populate or reset the store run:
 *   node scripts/seed-changelog.js
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { logger } = require("../utils/logger");
const {
    changelogMessages,
} = require("../constants/messages/changelog.messages");
const { AppError, CHANGELOG_ERRORS } = require("../constants/errors");

// In compiled (pkg) builds, __dirname points to the read-only snapshot.
// Resolve data/ relative to the executable so the encrypted store lives
// next to the .exe at runtime.
/* c8 ignore next 3 -- the process.pkg arm runs ONLY inside the PKG-compiled
   binary (process.pkg is undefined under Node/vitest), so the true branch is
   structurally unreachable in the test runtime — same rationale as the
   vitest.config PKG-runtime excludes (encodingPolyfill.js, consoleManager.js). */
const PROJECT_ROOT = process.pkg
    ? path.dirname(process.execPath)
    : path.resolve(__dirname, "../..");
const DATA_DIR = path.join(PROJECT_ROOT, "data");
const STORE_PATH = path.join(DATA_DIR, "changelog.enc");
const ALG = "aes-256-gcm";
const IV_BYTES = 12;

// ── Key resolution ────────────────────────────────────────────────────────────

function resolveKey() {
    const raw = process.env.CHANGELOG_ENCRYPTION_KEY;
    if (raw && raw.length === 64) return Buffer.from(raw, "hex");

    const fallback = process.env.DATA_SIGNING_SECRET;
    if (fallback && fallback.length >= 32) {
        return crypto.createHash("sha256").update(fallback).digest();
    }
    throw new Error(
        "[ChangelogModel] Set CHANGELOG_ENCRYPTION_KEY (64-char hex) or DATA_SIGNING_SECRET (≥32 chars).",
    );
}

// ── Encrypt / Decrypt ─────────────────────────────────────────────────────────

function encrypt(plaintext) {
    const key = resolveKey();
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALG, key, iv);
    const enc = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
    ]);
    return JSON.stringify({
        iv: iv.toString("hex"),
        authTag: cipher.getAuthTag().toString("hex"),
        ciphertext: enc.toString("hex"),
    });
}

function decrypt(raw) {
    const key = resolveKey();
    const { iv, authTag, ciphertext } = JSON.parse(raw);
    const decipher = crypto.createDecipheriv(ALG, key, Buffer.from(iv, "hex"));
    decipher.setAuthTag(Buffer.from(authTag, "hex"));
    return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "hex")),
        decipher.final(),
    ]).toString("utf8");
}

// ── Cross-process file lock ─────────────────────────────────────────────────
//
// The store is a single encrypted JSON file mutated via a read-modify-write
// cycle (readStore → mutate the entries array → writeStore). Within ONE Node
// process that cycle is already safe — create()/update()/delete() have zero
// `await` points, so they run to completion on a single turn of the event loop
// and cannot interleave. ACROSS processes (two ENABLE_CLUSTERING workers, or
// two instances behind a load balancer) nothing serialised them: two writers
// could each readStore() before either writeStore(), and the second write
// would clobber the first — a lost update whose HTTP response still reported
// success. This dependency-free advisory lockfile closes that gap.
//
// Mechanism: an exclusive-create lockfile (fs.openSync 'wx' — atomic, fails
// EEXIST when another holder exists). A holder that crashes without releasing
// leaves a stale lockfile; any waiter older than LOCK_STALE_MS steals it so a
// dead worker can never wedge the store permanently. Waiting is a real
// blocking sleep (Atomics.wait on a throwaway SharedArrayBuffer) — it parks
// only this worker thread, never busy-spins the CPU. The single-process fast
// path is unaffected: an uncontended 'wx' open succeeds on the first try.

const LOCK_PATH = STORE_PATH + ".lock";
/** A held lock older than this is treated as abandoned and stolen. */
const LOCK_STALE_MS = 10_000;
/** Sleep between acquisition attempts while another holder is alive. */
const LOCK_RETRY_MS = 25;
/** Give up acquiring after this and surface a 503 rather than hang forever. */
const LOCK_TIMEOUT_MS = 5_000;

/**
 * Blocking synchronous sleep — parks the current worker thread for `ms`
 * without busy-spinning. Dependency-free (Atomics.wait on a private buffer).
 * @param {number} ms
 */
function _sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}

/**
 * Acquires the exclusive store lock, stealing a stale one and retrying a live
 * one until LOCK_TIMEOUT_MS elapses.
 * @returns {number} the open lockfile descriptor (pass to _releaseLock)
 * @throws {AppError} 503 when the lock cannot be acquired within the timeout.
 */
function _acquireLock() {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
        try {
            const fd = fs.openSync(LOCK_PATH, "wx");
            try {
                fs.writeSync(fd, `${process.pid}:${Date.now()}`);
            } catch {
                /* best-effort holder metadata — never fail the acquire on this */
            }
            return fd;
        } catch (err) {
            if (err.code !== "EEXIST") throw err;

            // Lock is held. Steal it if the holder is stale, else wait & retry.
            let stale = false;
            try {
                const st = fs.statSync(LOCK_PATH);
                stale = Date.now() - st.mtimeMs > LOCK_STALE_MS;
            } catch {
                // Lock vanished between open and stat — retry immediately.
                continue;
            }
            if (stale) {
                try {
                    fs.unlinkSync(LOCK_PATH);
                } catch {
                    /* another waiter stole it first — retry */
                }
                continue;
            }
            if (Date.now() >= deadline) {
                logger.error(
                    changelogMessages.STORE_ENCRYPT_FAILED(
                        `changelog store lock busy for >${LOCK_TIMEOUT_MS}ms`,
                    ),
                );
                throw new AppError(CHANGELOG_ERRORS.STORE_UNAVAILABLE, 503);
            }
            _sleepSync(LOCK_RETRY_MS);
        }
    }
}

/**
 * Releases the store lock. Best-effort — never throws.
 * @param {number} fd
 */
function _releaseLock(fd) {
    try {
        fs.closeSync(fd);
    } catch {
        /* already closed */
    }
    try {
        fs.unlinkSync(LOCK_PATH);
    } catch {
        /* already removed */
    }
}

/**
 * Runs `fn` while holding the exclusive store lock — serialises the whole
 * read-modify-write cycle across processes so no writer ever reads a snapshot
 * that predates another writer's committed write.
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function withLock(fn) {
    ensureDataDir();
    const fd = _acquireLock();
    try {
        return fn();
    } finally {
        _releaseLock(fd);
    }
}

// ── File I/O ──────────────────────────────────────────────────────────────────

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Migrates a single entry from the old schema (summary string) to the new schema
 * (message string + whatChanged array). Safe to run repeatedly — idempotent.
 * @param {object} entry
 * @returns {object}
 */
function migrateEntry(entry) {
    // Old entries had `summary` instead of `message` + `whatChanged`
    if (!entry.message && entry.summary) {
        const { summary, ...rest } = entry;
        return { ...rest, message: summary, whatChanged: [] };
    }
    if (!entry.whatChanged) {
        return { ...entry, whatChanged: [] };
    }
    return entry;
}

/**
 * Reads all entries from the encrypted store.
 * Initialises the file with an empty store on first run.
 * Run `node scripts/seed-changelog.js` to populate with entries.
 * Migrates legacy entries (summary → message) on read.
 * @returns {{ entries: object[] }}
 */
function readStore() {
    ensureDataDir();

    if (!fs.existsSync(STORE_PATH)) {
        const initial = { entries: [] };
        writeStore(initial);
        logger.notice(changelogMessages.STORE_INITIALIZED());
        return initial;
    }

    try {
        const raw = fs.readFileSync(STORE_PATH, "utf8");
        const plaintext = decrypt(raw);
        const store = JSON.parse(plaintext);

        let needsWrite = false;
        store.entries = store.entries.map((entry) => {
            const migrated = migrateEntry(entry);
            if (migrated !== entry) needsWrite = true;
            return migrated;
        });

        if (needsWrite) writeStore(store);

        logger.debug(changelogMessages.STORE_READ(store.entries?.length ?? 0));
        return store;
    } catch (err) {
        logger.error(changelogMessages.STORE_DECRYPT_FAILED(err.message));
        throw new AppError(CHANGELOG_ERRORS.STORE_UNAVAILABLE, 503);
    }
}

/**
 * Encrypts and writes the store to disk.
 * @param {{ entries: object[] }} store
 */
function writeStore(store) {
    ensureDataDir();
    try {
        const ciphertext = encrypt(JSON.stringify(store));
        fs.writeFileSync(STORE_PATH, ciphertext, "utf8");
        logger.debug(
            changelogMessages.STORE_WRITTEN(store.entries?.length ?? 0),
        );
    } catch (err) {
        logger.error(changelogMessages.STORE_ENCRYPT_FAILED(err.message));
        throw new AppError(CHANGELOG_ERRORS.STORE_UNAVAILABLE, 503);
    }
}

// ── ChangelogModel ────────────────────────────────────────────────────────────

class ChangelogModel {
    /**
     * Returns all entries sorted newest displayDate first.
     * @returns {object[]}
     */
    static listAll() {
        const { entries } = readStore();
        return [...entries].sort((a, b) => {
            if (b.displayDate !== a.displayDate)
                return b.displayDate.localeCompare(a.displayDate);
            return b.createdAt.localeCompare(a.createdAt);
        });
    }

    /**
     * Finds one entry by ID.
     * @param {string} id
     * @returns {object}
     */
    static findById(id) {
        const { entries } = readStore();
        const entry = entries.find((e) => e.id === id);
        if (!entry) throw new AppError(CHANGELOG_ERRORS.ENTRY_NOT_FOUND, 404);
        return entry;
    }

    /**
     * Creates a new entry.
     * @param {object} data
     * @returns {object} created entry
     */
    static create(data) {
        // Whole read-modify-write cycle under the cross-process lock: readStore
        // runs AFTER any concurrent writer released the lock, so this create
        // always appends to the latest committed entries array — never a stale
        // snapshot (the lost-update fix).
        return withLock(() => {
            const store = readStore();
            const now = new Date().toISOString();
            const entry = {
                id: crypto.randomUUID(),
                displayDate: data.displayDate,
                version: data.version,
                title: data.title,
                message: data.message,
                whatChanged: Array.isArray(data.whatChanged)
                    ? data.whatChanged
                    : [],
                type: data.type,
                authors: Array.isArray(data.authors) ? data.authors : [],
                coAuthors: Array.isArray(data.coAuthors) ? data.coAuthors : [],
                createdAt: now,
                updatedAt: now,
            };
            store.entries.push(entry);
            writeStore(store);
            logger.info(changelogMessages.ENTRY_CREATED(entry.id));
            return entry;
        });
    }

    /**
     * Updates an existing entry (partial update — only provided fields).
     * @param {string} id
     * @param {object} data
     * @returns {object} updated entry
     */
    static update(id, data) {
        return withLock(() => {
            const store = readStore();
            const idx = store.entries.findIndex((e) => e.id === id);
            if (idx === -1)
                throw new AppError(CHANGELOG_ERRORS.ENTRY_NOT_FOUND, 404);

            const ALLOWED = [
                "displayDate",
                "version",
                "title",
                "message",
                "whatChanged",
                "type",
                "authors",
                "coAuthors",
            ];
            ALLOWED.forEach((key) => {
                if (data[key] !== undefined) store.entries[idx][key] = data[key];
            });
            store.entries[idx].updatedAt = new Date().toISOString();
            writeStore(store);
            logger.info(changelogMessages.ENTRY_UPDATED(id));
            return store.entries[idx];
        });
    }

    /**
     * Permanently removes an entry.
     * @param {string} id
     */
    static delete(id) {
        return withLock(() => {
            const store = readStore();
            const before = store.entries.length;
            store.entries = store.entries.filter((e) => e.id !== id);
            if (store.entries.length === before)
                throw new AppError(CHANGELOG_ERRORS.ENTRY_NOT_FOUND, 404);
            writeStore(store);
            logger.info(changelogMessages.ENTRY_DELETED(id));
        });
    }

    /**
     * Wipes the current store and writes the provided entries from scratch.
     * Intended for use by `scripts/seed-changelog.js` only.
     * Never call from application request handlers.
     *
     * @param {object[]} entries  Changelog entries to seed.
     * @returns {number} Count of entries written.
     */
    static resetStore(entries) {
        return withLock(() => {
            const now = new Date().toISOString();
            const normalised = entries.map((e) => ({
                id: e.id ?? crypto.randomUUID(),
                displayDate: e.displayDate,
                version: e.version,
                title: e.title,
                message: e.message,
                whatChanged: Array.isArray(e.whatChanged) ? e.whatChanged : [],
                type: e.type,
                authors: Array.isArray(e.authors) ? e.authors : [],
                coAuthors: Array.isArray(e.coAuthors) ? e.coAuthors : [],
                createdAt: e.createdAt ?? now,
                updatedAt: now,
            }));
            writeStore({ entries: normalised });
            logger.notice(changelogMessages.STORE_INITIALIZED());
            return normalised.length;
        });
    }
}

module.exports = ChangelogModel;
