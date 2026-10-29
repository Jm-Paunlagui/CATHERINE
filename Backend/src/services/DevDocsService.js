"use strict";

/**
 * DevDocsService — reads the `dev-docs` corpus for the in-app viewer.
 *
 * ACCESS POSTURE — read this before changing anything here.
 * ────────────────────────────────────────────────────────
 * These documents describe HMAC signing, integrity-gate failure conditions,
 * the backup/restore design and the auth predicates. They are an internal
 * architecture map of the system, and they are ADMIN / SUPER_ADMIN only.
 *
 * That is enforced at the route (`requireAdminAccess`), which is the ONLY real
 * control. Hiding the tab and guarding the client route are conveniences, not
 * controls. The corresponding rule for this file: the corpus must never be
 * reachable as a static asset from any origin, which is why it is served from
 * here rather than copied into the frontend bundle.
 *
 * PATH TRAVERSAL IS DESIGNED OUT, NOT VALIDATED AWAY
 * ──────────────────────────────────────────────────
 * A caller never supplies a path. They supply an `id`, which is a key into a
 * manifest this service builds by walking the corpus itself. An unknown id is a
 * 404 before any filesystem call happens, so there is no `..` to sanitise and
 * no encoding trick to miss.
 *
 * `_assertInsideCorpus` is belt-and-braces on top of that: even a manifest
 * entry is re-checked against the corpus root before it is read. If the two
 * defences ever disagree, that is a bug worth a loud throw rather than a quiet
 * read.
 *
 * WHY A CACHED MANIFEST
 * ─────────────────────
 * Building it costs one `stat` per document plus a `git log` spawn. Doing that per request
 * would make the tree endpoint the slowest read in the API for data that
 * changes when someone edits a file, i.e. never during a request. It is cached
 * with a TTL and rebuilt lazily.
 */

const fsp = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const { AppError, DEV_DOCS_ERRORS } = require("../constants/errors");
const { HTTP_STATUS } = require("../constants");
const { logger } = require("../utils/logger");
const devDocsMessages = require("../constants/messages/devdocs.messages");

const execFileAsync = promisify(execFile);

/**
 * Repo root — the cwd every `git log` runs in, and what its paths are relative to.
 *
 * In a pkg build `__dirname` is the read-only `C:\snapshot\...` bundle, which
 * holds no `dev-docs` (not a pkg asset — see ACCESS POSTURE), so the corpus
 * resolved there reported CORPUS_UNAVAILABLE even with `dev-docs/` deployed
 * beside `backend.exe`. Resolve next to the executable instead, the same rule
 * changelog.model.js and the logger follow. `git log` then fails outside a
 * checkout; freshness falls back to FRESHNESS_SNAPSHOT_PATH, never an error.
 */
/* c8 ignore next 3 -- the process.pkg arm runs ONLY inside the PKG-compiled
   binary (process.pkg is undefined under Node/vitest), so the true branch is
   structurally unreachable in the test runtime — same rationale as changelog.model.js. */
const REPO_ROOT = process.pkg
    ? path.dirname(process.execPath)
    : path.resolve(__dirname, "..", "..");

/** Absolute path to the corpus. Everything served is inside this directory. */
const CORPUS_ROOT = path.join(REPO_ROOT, "dev-docs");

/**
 * Build-time commit-date snapshot, written by `scripts/build-devdocs-freshness.js`
 * before `pkg` runs and bundled as an asset (`src/**\/*.json`).
 *
 * WHY IT EXISTS: a deployed exe has no git checkout, so the live `git log`
 * yields nothing and every document read UNKNOWN ("Age unknown") in
 * production. The snapshot carries the dates the build was made from. The
 * source dates are exact for this exe (those sources ARE what it runs); the
 * document dates are as of the build, so deploy `dev-docs/` from the same
 * commit as the exe. Resolved off `__dirname` on purpose: it lives inside the
 * snapshot, not beside the executable. Gitignored — a build artefact.
 */
const FRESHNESS_SNAPSHOT_PATH = path.join(__dirname, "..", "generated", "devDocsFreshness.json");

/** Record separator `git log --format=%x1e...` stamps in front of each commit line. */
const RECORD_SEPARATOR = String.fromCharCode(0x1e);

/** Line break `git log` output is split on. */
const LINE_BREAK = String.fromCharCode(0x0a);

/** Rebuild interval for the manifest. Docs change at edit time, not request time. */
const MANIFEST_TTL_MS = 5 * 60_000;

/** Upper bound on search hits returned in one response (the rest are counted, not sent). */
const SEARCH_RESULT_CAP = 50;

/** Characters of context either side of a search match. */
const SNIPPET_RADIUS = 80;

/** Minimum query length — a 1-character scan over 1.3 MB returns noise. */
const MIN_QUERY_LENGTH = 2;

/**
 * Maps a documentation section to the source paths it describes, for the
 * freshness comparison. A doc older than every path listed here is SUSPECT.
 *
 * Deliberately coarse. The question being answered is "has the code under this
 * doc moved since the doc was written", and a section-level mapping answers it
 * without pretending to a precision that would need maintaining per file.
 *
 * A section absent from this map yields freshness UNKNOWN rather than a guess —
 * an unmapped doc is not evidence of currency.
 *
 * Map EVERY section folder the corpus has: an unmapped section reports
 * UNKNOWN permanently, which is indistinguishable from "never checked" and so
 * strictly worse than a coarse SUSPECT. A project that adds a dev-docs folder
 * adds its key here.
 *
 * Paths are repo-relative to the backend root (REPO_ROOT) and must be FILES, not
 * directories — `_sectionSourceDate` looks each one up by exact key in the
 * index `_commitDateIndex` builds. Adding a key here is the whole change: the
 * git-log pathspec is derived from this object's values.
 *
 * KNOWN LIMIT of the section-level shape: `Others/personalize-documentation.md`
 * has no backend at all (it documents the frontend's personalize feature),
 * and freshness compares against this repo only. It therefore inherits the
 * `Others` date, which cannot speak to it. Coarse-but-informative beats
 * UNKNOWN; a per-document map is the fix if that ever matters.
 */
const SECTION_SOURCE_MAP = Object.freeze({
    // Paths are case-exact: git pathspecs are case-sensitive.
    "System Admin": [
        "src/services/DataPurgeService.js",
        "src/services/BackupStoreService.js",
        "src/services/AdminManagementService.js",
        "src/services/IntegrityService.js",
        "src/services/AuditLogService.js",
        "src/services/MetricsService.js",
    ],
    // The union of what the Support documents describe: the changelog, and the
    // Architecture / Runtime system maps with the dev-docs viewer that serves them.
    // Changelog-only left architecture, runtime and viewer docs unable to go SUSPECT.
    Support: [
        "src/services/ChangelogService.js",
        "src/services/ArchitectureService.js",
        "src/constants/architectureModel.js",
        "src/constants/runtimeModel.js",
        "src/utils/systemMap.js",
        "src/services/DevDocsService.js",
    ],
    // Cross-cutting. The union of what the documents under Others/ describe:
    // auth, health probes, CSRF and client error ingestion.
    Others: [
        "src/services/AuthService.js",
        "src/routes/health.route.js",
        "src/middleware/security/CsrfMiddleware.js",
        "src/services/ClientService.js",
    ],
    // The synthetic section holding root-level README.md. Its sources are what
    // actually makes it stale: README documents how the corpus is served and
    // what the freshness badge means, so this service IS its subject.
    Overview: ["src/services/DevDocsService.js"],
});

/** @type {{ builtAt: number, byId: Map<string, object>, sections: object[] }|null} */
let _manifestCache = null;

class DevDocsService {
    // ─── Manifest ────────────────────────────────────────────────────────────

    /**
     * @private
     * Rejects any resolved path that escapes the corpus.
     *
     * Reached only for paths this service produced itself, so a throw here means
     * the manifest is wrong rather than the caller — hence 500, not 404. A 404
     * would hide a real defect behind a routine-looking response.
     *
     * @param {string} absolutePath
     * @throws {AppError} 500 when the path is outside CORPUS_ROOT
     */
    static _assertInsideCorpus(absolutePath) {
        const resolved = path.resolve(absolutePath);
        const root = CORPUS_ROOT.endsWith(path.sep) ? CORPUS_ROOT : CORPUS_ROOT + path.sep;
        if (resolved !== CORPUS_ROOT && !resolved.startsWith(root)) {
            logger.error(devDocsMessages.CORPUS_ESCAPE_BLOCKED(resolved));
            throw new AppError(
                DEV_DOCS_ERRORS.DOC_READ_FAILED,
                HTTP_STATUS.INTERNAL_SERVER_ERROR,
                { type: "InternalError" },
            );
        }
        return resolved;
    }

    /**
     * @private
     * Derives the opaque id for a document from its location in the corpus.
     *
     * Lower-cased, separators normalised to "/", extension dropped. The id is
     * stable across runs so a link an admin shares keeps working, and it is
     * looked up in a Map — it is never re-joined onto a filesystem path.
     *
     * @param {string} section
     * @param {string} fileName
     * @returns {string}
     */
    static _buildId(section, fileName) {
        const slug = (v) => String(v).replace(/\.md$/i, "").replace(/[\\/]+/g, "-").trim().toLowerCase();
        return `${slug(section)}/${slug(fileName)}`;
    }

    /**
     * @private
     * Reads the first markdown H1 as the display title.
     *
     * Falls back to a humanised filename. Reads only the head of the file — the
     * largest doc is 104 KB and the title is in its first line; slurping every
     * document to build a tree would make the list endpoint pay the read cost of
     * the whole corpus.
     *
     * @param {string} absolutePath
     * @param {string} fileName
     * @returns {Promise<string>}
     */
    static async _readTitle(absolutePath, fileName) {
        let handle = null;
        try {
            handle = await fsp.open(absolutePath, "r");
            const { buffer, bytesRead } = await handle.read({ buffer: Buffer.alloc(2048), position: 0 });
            const head = buffer.subarray(0, bytesRead).toString("utf8");
            const match = head.match(/^#\s+(.+?)\s*$/m);
            if (match) return match[1].trim();
        } catch {
            // Fall through to the filename — a title is presentation, and a
            // failure to read one must not make the document unlistable.
        } finally {
            await handle?.close().catch(() => {});
        }
        return fileName.replace(/\.md$/i, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    }

    /**
     * @private
     * Newest commit date for EVERY path under `pathspecs`, from ONE `git log`.
     *
     * WHY BATCHED: the manifest needs a date for ~60 documents plus the source
     * files the freshness comparison reads. Asking `git log -1 -- <path>` per
     * path is one child process per path — about 3.6 s to build the manifest on
     * Windows, where process spawn is expensive. That cost lands on the first
     * request after every TTL expiry, and in the test suite on every test (the
     * dev-docs security suite invalidates the manifest per test to keep its
     * tests independent), where a loaded parallel run pushed whole tests past
     * the 60 s timeout.
     *
     * `--name-only` walks the history once and lists the files each commit
     * touched. `git log` is newest-first, so the FIRST appearance of a path is
     * its last commit — exactly what `-1 -- <path>` returns, for every path, in
     * one spawn.
     *
     * A failure here (no git, not a repo, a shallow clone) yields an empty
     * index, which reads through as UNKNOWN freshness — the same outcome the
     * per-path lookup gave when it failed. Freshness is advisory and must never
     * fail a documentation read.
     *
     * @param {string[]} pathspecs - repo-relative paths or directories
     * @returns {Promise<Map<string, string>>} repo-relative path -> YYYY-MM-DD
     */
    static async _commitDateIndex(pathspecs) {
        const index = new Map();
        if (!pathspecs.length) return index;
        try {
            const { stdout } = await execFileAsync(
                "git",
                ["log", "--format=%x1e%cd", "--date=short", "--name-only", "--", ...pathspecs],
                {
                    cwd: REPO_ROOT,
                    timeout: 15_000,
                    windowsHide: true,
                    // Years of corpus history: the default 1 MB buffer would
                    // truncate the walk mid-way and silently drop dates.
                    maxBuffer: 32 * 1024 * 1024,
                },
            );
            let commitDate = null;
            for (const raw of stdout.split(LINE_BREAK)) {
                const line = raw.trim();
                if (!line) continue;
                // Commit lines carry the RS prefix (%x1e); everything else is a path.
                if (line.startsWith(RECORD_SEPARATOR)) {
                    commitDate = line.slice(1);
                    continue;
                }
                // Newest-first: the first date seen for a path wins, never overwritten.
                if (commitDate && !index.has(line)) index.set(line, commitDate);
            }
        } catch {
            // Advisory data only — an empty index means UNKNOWN, not an error.
        }
        return index;
    }

    /**
     * @private
     * Reads the build-time snapshot. Null when absent or malformed — freshness
     * is advisory, so a bad snapshot degrades to UNKNOWN rather than failing
     * the tree.
     *
     * @returns {Promise<{ docs: Map<string, string>, sources: Map<string, string> }|null>}
     */
    static async _loadFreshnessSnapshot() {
        try {
            const parsed = JSON.parse(await fsp.readFile(FRESHNESS_SNAPSHOT_PATH, "utf8"));
            const toMap = (obj) => new Map(
                Object.entries(obj ?? {}).filter(([, date]) => typeof date === "string"),
            );
            return { docs: toMap(parsed.docs), sources: toMap(parsed.sources) };
        } catch {
            return null;
        }
    }

    /**
     * @private
     * Live git dates, falling back per index to the build-time snapshot when
     * git yields nothing (a deployed exe has no checkout).
     *
     * @returns {Promise<{ docIndex: Map<string, string>, sourceIndex: Map<string, string> }>}
     */
    static async _resolveDateIndexes() {
        // Two `git log` passes for the whole manifest — one over the corpus, one
        // over the source files freshness compares against — instead of one
        // child process per path. See _commitDateIndex.
        let [docIndex, sourceIndex] = await Promise.all([
            DevDocsService._commitDateIndex(["dev-docs"]),
            DevDocsService._commitDateIndex([...new Set(Object.values(SECTION_SOURCE_MAP).flat())]),
        ]);
        if (docIndex.size && sourceIndex.size) return { docIndex, sourceIndex };

        const snapshot = await DevDocsService._loadFreshnessSnapshot();
        if (!snapshot) {
            logger.warning(devDocsMessages.FRESHNESS_SNAPSHOT_UNAVAILABLE(FRESHNESS_SNAPSHOT_PATH));
            return { docIndex, sourceIndex };
        }
        if (!docIndex.size) docIndex = snapshot.docs;
        if (!sourceIndex.size) sourceIndex = snapshot.sources;
        return { docIndex, sourceIndex };
    }

    /**
     * @private
     * Newest commit date across the sources a section documents.
     *
     * @param {string} section
     * @param {Map<string, string>} sourceIndex - from _commitDateIndex
     * @returns {string|null}
     */
    static _sectionSourceDate(section, sourceIndex) {
        const sources = SECTION_SOURCE_MAP[section];
        if (!sources?.length) return null;
        const dates = sources.map((src) => sourceIndex.get(src)).filter(Boolean);
        if (!dates.length) return null;
        return dates.sort().at(-1);
    }

    /**
     * @private
     * CURRENT / SUSPECT / UNKNOWN for one document.
     *
     * SUSPECT is deliberately not "stale". Many commits to a service do not
     * touch what its documentation claims, so this flags a document as worth
     * checking — it does not assert the document is wrong. The UI wording must
     * preserve that distinction; a reader who is told "this is out of date" and
     * finds it accurate stops reading the banner.
     *
     * @param {string|null} docDate
     * @param {string|null} sourceDate
     * @returns {"CURRENT"|"SUSPECT"|"UNKNOWN"}
     */
    static _freshness(docDate, sourceDate) {
        if (!docDate || !sourceDate) return "UNKNOWN";
        return docDate >= sourceDate ? "CURRENT" : "SUSPECT";
    }

    /**
     * @private
     * Walks the corpus and builds the manifest. One directory level deep plus
     * root-level files, which is the shape the corpus actually has.
     *
     * @returns {Promise<{ builtAt: number, byId: Map<string, object>, sections: object[] }>}
     */
    static async _buildManifest() {
        const byId = new Map();
        const sections = [];

        const { docIndex, sourceIndex } = await DevDocsService._resolveDateIndexes();

        let entries;
        try {
            entries = await fsp.readdir(CORPUS_ROOT, { withFileTypes: true });
        } catch (err) {
            logger.error(devDocsMessages.CORPUS_UNREADABLE(CORPUS_ROOT, err.message));
            throw new AppError(
                DEV_DOCS_ERRORS.CORPUS_UNAVAILABLE,
                HTTP_STATUS.INTERNAL_SERVER_ERROR,
                { type: "InternalError" },
            );
        }

        const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
        const rootDocs = entries.filter((e) => e.isFile() && /\.md$/i.test(e.name)).map((e) => e.name).sort();

        const collect = async (sectionName, dirAbs, fileNames) => {
            const sourceDate = DevDocsService._sectionSourceDate(sectionName, sourceIndex);
            const docs = [];
            for (const fileName of fileNames) {
                const absolutePath = DevDocsService._assertInsideCorpus(path.join(dirAbs, fileName));
                const id = DevDocsService._buildId(sectionName, fileName);
                let sizeBytes = 0;
                try {
                    ({ size: sizeBytes } = await fsp.stat(absolutePath));
                } catch {
                    continue; // vanished between readdir and stat — skip, do not fail the tree
                }
                const relativePath = path.relative(REPO_ROOT, absolutePath).replace(/\\/g, "/");
                const title = await DevDocsService._readTitle(absolutePath, fileName);
                const docCommittedAt = docIndex.get(relativePath) ?? null;
                const entry = {
                    id,
                    title,
                    sizeBytes,
                    docCommittedAt,
                    sourceCommittedAt: sourceDate,
                    freshness: DevDocsService._freshness(docCommittedAt, sourceDate),
                };
                // absolutePath is manifest-internal and MUST NOT reach a response:
                // it is a filesystem layout detail (CWE-209). Controllers project
                // the public fields explicitly rather than spreading the entry.
                byId.set(id, { ...entry, absolutePath });
                docs.push(entry);
            }
            if (docs.length) sections.push({ name: sectionName, docs });
        };

        // Root files (README index) first: the viewer lists sections in this
        // order and opens the first document by default, so the index is the
        // landing page and sits at the top of the sidebar.
        if (rootDocs.length) await collect("Overview", CORPUS_ROOT, rootDocs);

        for (const dir of dirs) {
            const dirAbs = DevDocsService._assertInsideCorpus(path.join(CORPUS_ROOT, dir));
            let dirEntries = [];
            try {
                dirEntries = await fsp.readdir(dirAbs, { withFileTypes: true });
            } catch {
                continue;
            }
            await collect(dir, dirAbs, dirEntries.filter((e) => e.isFile() && /\.md$/i.test(e.name)).map((e) => e.name).sort());
        }

        return { builtAt: Date.now(), byId, sections };
    }

    /**
     * @private
     * Returns the cached manifest, rebuilding it when the TTL has expired.
     *
     * @returns {Promise<{ builtAt: number, byId: Map<string, object>, sections: object[] }>}
     */
    static async _manifest() {
        if (_manifestCache && Date.now() - _manifestCache.builtAt < MANIFEST_TTL_MS) {
            return _manifestCache;
        }
        _manifestCache = await DevDocsService._buildManifest();
        return _manifestCache;
    }

    /** Drops the cached manifest. Exposed for tests and for an explicit refresh. */
    static invalidateManifest() {
        _manifestCache = null;
    }

    // ─── Public reads ────────────────────────────────────────────────────────

    /**
     * Section tree with per-document metadata. No document bodies.
     *
     * @returns {Promise<{ sections: object[], generatedAt: string }>}
     */
    static async getTree() {
        const manifest = await DevDocsService._manifest();
        return {
            sections: manifest.sections,
            generatedAt: new Date(manifest.builtAt).toISOString(),
        };
    }

    /**
     * One document's raw markdown plus its metadata. The UI renders it; the
     * server never converts markdown to HTML, so there is no HTML-injection
     * surface on this path.
     *
     * @param {string} id - opaque manifest key
     * @returns {Promise<object>}
     * @throws {AppError} 404 when the id is unknown
     */
    static async getDoc(id) {
        const manifest = await DevDocsService._manifest();
        const entry = manifest.byId.get(String(id ?? "").trim().toLowerCase());
        if (!entry) {
            // The id is echoed because the caller sent it; the corpus layout is
            // not, because they did not (CWE-209).
            throw new AppError(DEV_DOCS_ERRORS.DOC_NOT_FOUND, HTTP_STATUS.NOT_FOUND, {
                type: "NotFoundError",
                details: [{ field: "id", issue: `No document with id "${String(id ?? "").slice(0, 120)}".` }],
            });
        }

        let markdown;
        try {
            markdown = await fsp.readFile(DevDocsService._assertInsideCorpus(entry.absolutePath), "utf8");
        } catch (err) {
            logger.error(devDocsMessages.DOC_READ_FAILED(entry.id, err.message));
            throw new AppError(DEV_DOCS_ERRORS.DOC_READ_FAILED, HTTP_STATUS.INTERNAL_SERVER_ERROR, {
                type: "InternalError",
            });
        }

        return {
            id: entry.id,
            title: entry.title,
            markdown,
            sizeBytes: entry.sizeBytes,
            docCommittedAt: entry.docCommittedAt,
            sourceCommittedAt: entry.sourceCommittedAt,
            freshness: entry.freshness,
        };
    }

    /**
     * Case-insensitive literal substring search across the corpus.
     *
     * Literal, not regex: the query is caller-supplied, and compiling it as a
     * pattern is a ReDoS vector (CWE-1333) on 1.3 MB of text. `indexOf` on a
     * lower-cased line cannot backtrack.
     *
     * @param {string} rawQuery
     * @returns {Promise<{ results: object[], total: number, truncated: boolean }>}
     * @throws {AppError} 400 when the query is too short
     */
    static async search(rawQuery) {
        const query = String(rawQuery ?? "").trim();
        if (query.length < MIN_QUERY_LENGTH) {
            throw new AppError(DEV_DOCS_ERRORS.INVALID_QUERY, HTTP_STATUS.BAD_REQUEST, {
                type: "ValidationError",
                details: [{ field: "q", issue: `Provide at least ${MIN_QUERY_LENGTH} characters.` }],
            });
        }

        const manifest = await DevDocsService._manifest();
        const needle = query.toLowerCase();
        const results = [];
        let total = 0;

        for (const entry of manifest.byId.values()) {
            let content;
            try {
                content = await fsp.readFile(DevDocsService._assertInsideCorpus(entry.absolutePath), "utf8");
            } catch {
                continue; // one unreadable document must not fail the whole search
            }

            const lines = content.split(/\r?\n/);
            let heading = null;
            for (let i = 0; i < lines.length; i += 1) {
                const line = lines[i];
                const headingMatch = line.match(/^#{1,6}\s+(.*)$/);
                if (headingMatch) heading = headingMatch[1].trim();

                const at = line.toLowerCase().indexOf(needle);
                if (at === -1) continue;

                total += 1;
                if (results.length >= SEARCH_RESULT_CAP) continue; // keep counting, stop collecting

                const from = Math.max(0, at - SNIPPET_RADIUS);
                const to = Math.min(line.length, at + needle.length + SNIPPET_RADIUS);
                results.push({
                    id: entry.id,
                    title: entry.title,
                    heading,
                    snippet: (from > 0 ? "…" : "") + line.slice(from, to).trim() + (to < line.length ? "…" : ""),
                    line: i + 1,
                });
            }
        }

        return { results, total, truncated: total > results.length };
    }
}

module.exports = DevDocsService;
module.exports.CORPUS_ROOT = CORPUS_ROOT;
module.exports.SEARCH_RESULT_CAP = SEARCH_RESULT_CAP;
module.exports.MIN_QUERY_LENGTH = MIN_QUERY_LENGTH;
// Exported for the freshness-coverage test, which asserts every section the
// corpus has is mapped and every mapped path still exists on disk. Both are
// silent failures otherwise: an unmapped section reads UNKNOWN forever, and a
// renamed service leaves a path whose `git log` still resolves from history
// while no longer tracking the file the doc describes.
module.exports.SECTION_SOURCE_MAP = SECTION_SOURCE_MAP;
// Exported for scripts/build-devdocs-freshness.js, the snapshot's only writer.
module.exports.FRESHNESS_SNAPSHOT_PATH = FRESHNESS_SNAPSHOT_PATH;
