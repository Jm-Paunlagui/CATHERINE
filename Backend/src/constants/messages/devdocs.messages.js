"use strict";

/**
 * @fileoverview Server-side log templates for the dev-docs viewer.
 *
 * Log lines only — never client-facing text. Client-facing strings live in
 * `constants/errors` (thrown) and `constants/responses` (returned), per the
 * three-bucket rule.
 *
 * ONE STANDING RULE FOR THIS FILE: log WHICH document, never WHAT IT SAID.
 * The corpus is the thing being protected; a log line quoting its contents
 * moves that content somewhere with a different audience and a longer
 * retention. Ids and counts are fine. Bodies, snippets and matched lines are
 * not.
 */

const devDocsMessages = {
    /**
     * A document was read by an admin. This is the audit trail: these are
     * internal architecture documents, so who opened which one is worth the
     * same record any export gets.
     *
     * @param {number|string} adminId - Requesting admin numeric id
     * @param {string} docId        - Opaque manifest id
     * @returns {string}
     */
    DOC_READ: (adminId, docId) =>
        `Dev-docs document read — ADMIN_ID: ${adminId}, DOC_ID: ${docId}.`,

    /**
     * The document index was served.
     *
     * @param {number|string} adminId
     * @param {number} sectionCount
     * @param {number} docCount
     * @returns {string}
     */
    TREE_SERVED: (adminId, sectionCount, docCount) =>
        `Dev-docs index served — ADMIN_ID: ${adminId}, sections: ${sectionCount}, documents: ${docCount}.`,

    /**
     * A search ran. The QUERY IS NOT LOGGED — it is caller-supplied text that
     * would land unescaped in a log file, and the result count answers the
     * operational question ("is search working, is it being hammered") without
     * it.
     *
     * @param {number|string} adminId
     * @param {number} total     - Total matches found
     * @param {number} returned  - Matches actually returned after the cap
     * @returns {string}
     */
    SEARCH_COMPLETED: (adminId, total, returned) =>
        `Dev-docs search completed — ADMIN_ID: ${adminId}, matches: ${total}, returned: ${returned}.`,

    /**
     * A manifest entry resolved outside the corpus root. This should be
     * unreachable: ids are manifest keys and never path fragments. It firing
     * means the manifest builder is wrong, not that a caller got through —
     * hence error level, not warning.
     *
     * @param {string} resolvedPath
     * @returns {string}
     */
    CORPUS_ESCAPE_BLOCKED: (resolvedPath) =>
        `Dev-docs path escaped the corpus root and was refused — resolved: ${resolvedPath}. This indicates a manifest defect, not a client attack.`,

    /**
     * The dev-docs directory itself could not be read.
     *
     * @param {string} corpusRoot
     * @param {string} reason
     * @returns {string}
     */
    CORPUS_UNREADABLE: (corpusRoot, reason) =>
        `Dev-docs corpus unreadable at ${corpusRoot} — ${reason}.`,

    /**
     * A document listed in the manifest could not be read from disk.
     *
     * @param {string} docId
     * @param {string} reason
     * @returns {string}
     */
    DOC_READ_FAILED: (docId, reason) =>
        `Dev-docs document read failed — DOC_ID: ${docId}, reason: ${reason}.`,

    /**
     * Live `git log` returned no dates and the build-time snapshot is missing
     * or unreadable, so every document reads "Age unknown". In a compiled exe
     * this means it was built without `npm run build` (which writes the
     * snapshot first).
     *
     * @param {string} snapshotPath
     * @returns {string}
     */
    FRESHNESS_SNAPSHOT_UNAVAILABLE: (snapshotPath) =>
        `Dev-docs freshness unavailable — no git history and no build snapshot at ${snapshotPath}. Documents will show "Age unknown".`,
};

module.exports = devDocsMessages;
