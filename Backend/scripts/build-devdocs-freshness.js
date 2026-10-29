#!/usr/bin/env node
/**
 * build-devdocs-freshness.js
 *
 * Writes the dev-docs commit-date snapshot that `pkg` bundles into the exe.
 *
 * A deployed backend.exe has no git checkout, so DevDocsService's live
 * `git log` returns nothing and every document reads "Age unknown". This
 * captures the same two indexes at build time — corpus docs and the source
 * files SECTION_SOURCE_MAP compares against — through the SAME
 * `_commitDateIndex` the service uses live, so the two can never disagree on
 * how a date is derived.
 *
 * FAIL-LOUD CONTRACT (same as postbuild-copy-natives.js): an empty index
 * fails the build (exit 1). Shipping an exe without dates is the exact defect
 * this script exists to stop, and a shallow clone or missing git would
 * otherwise produce it silently.
 *
 * Run automatically first by `npm run build` / `npm run build:debug`.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const DevDocsService = require("../src/services/DevDocsService");
const { SECTION_SOURCE_MAP, FRESHNESS_SNAPSHOT_PATH } = DevDocsService;

/** Map -> plain object with sorted keys, so rebuilds diff cleanly. */
function toSortedObject(map) {
    return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

async function main() {
    const sourcePaths = [...new Set(Object.values(SECTION_SOURCE_MAP).flat())];
    const [docs, sources] = await Promise.all([
        DevDocsService._commitDateIndex(["dev-docs"]),
        DevDocsService._commitDateIndex(sourcePaths),
    ]);

    if (!docs.size || !sources.size) {
        console.error("\nDev-docs freshness snapshot FAILED — git returned no commit dates.");
        console.error(`  docs: ${docs.size}, sources: ${sources.size}`);
        console.error("  Build from a full (non-shallow) git checkout with git on PATH.");
        return 1;
    }

    const snapshot = {
        generatedAt: new Date().toISOString(),
        docs: toSortedObject(docs),
        sources: toSortedObject(sources),
    };

    fs.mkdirSync(path.dirname(FRESHNESS_SNAPSHOT_PATH), { recursive: true });
    fs.writeFileSync(FRESHNESS_SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    console.log(`  ✔  dev-docs freshness snapshot: ${docs.size} docs, ${sources.size} sources`);
    return 0;
}

// Explicit exit: requiring the service loads the logger, whose handles would
// otherwise keep the process alive and stall the build chain.
main().then(
    (code) => process.exit(code),
    (err) => {
        console.error(`\nDev-docs freshness snapshot FAILED — ${err.message}`);
        process.exit(1);
    },
);
