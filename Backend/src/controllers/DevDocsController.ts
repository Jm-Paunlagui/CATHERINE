"use strict";

/**
 * DevDocsController
 *
 * Thin HTTP layer for the dev-docs viewer. No business logic — DevDocsService
 * owns the manifest, the freshness comparison and the search.
 *
 * TWO RULES THIS LAYER ENFORCES, both about what leaves the process:
 *
 * 1. Every response is projected FIELD BY FIELD, never spread from a service
 *    object. Manifest entries carry an `absolutePath` that must not reach a
 *    client: it is a filesystem layout detail, and this corpus is exactly the
 *    map an attacker would want (CWE-209). A future field added to the
 *    manifest is then opt-in to the response rather than leaked by default.
 *
 * 2. Every response is `private, no-store`. These bodies are ADMIN-only; a
 *    shared or intermediary cache holding one is the same disclosure by a
 *    different route.
 *
 * The access control itself is the route's `requireAdminAccess`. Nothing here
 * re-checks a role — one gate, in one place, that a reader can find.
 */

const { sendSuccess, RESPONSE_MESSAGES } = require("../constants/responses");
const { catchAsync } = require("../utils/catchAsync");
const DevDocsService = require("../services/DevDocsService");
const devDocsMessages = require("../constants/messages/devdocs.messages");
const { logger } = require("../utils/logger");

/**
 * @private
 * Marks a response as admin-only and uncacheable by anything in the path.
 *
 * @param {import("express").Response} res
 */
function _noStore(res) {
    res.set("Cache-Control", "private, no-store, max-age=0");
    res.set("Pragma", "no-cache");
}

class DevDocsController {
    /**
     * GET /api/v1/dev-docs/tree
     * Section tree with per-document metadata. No document bodies.
     *
     * @type {import("express").RequestHandler}
     */
    static getTree = catchAsync(async (req, res) => {
        const { sections, generatedAt } = await DevDocsService.getTree();

        // Projected explicitly — see rule 1 in the class header.
        const payload = {
            sections: sections.map((section) => ({
                name: section.name,
                docs: section.docs.map((doc) => ({
                    id: doc.id,
                    title: doc.title,
                    sizeBytes: doc.sizeBytes,
                    docCommittedAt: doc.docCommittedAt,
                    sourceCommittedAt: doc.sourceCommittedAt,
                    freshness: doc.freshness,
                })),
            })),
            generatedAt,
        };

        logger.info(
            devDocsMessages.TREE_SERVED(
                req.user?.userId,
                payload.sections.length,
                payload.sections.reduce((n, s) => n + s.docs.length, 0),
            ),
        );

        _noStore(res);
        res.json(sendSuccess(RESPONSE_MESSAGES.DEV_DOCS_TREE_FETCHED, payload));
    });

    /**
     * GET /api/v1/dev-docs/doc/:id
     * One document's raw markdown plus its metadata. The UI renders it; the
     * server never produces HTML from it, so there is no markup-injection
     * surface on this path.
     *
     * @type {import("express").RequestHandler}
     */
    static getDoc = catchAsync(async (req, res) => {
        // Rejoined from the two route segments. Both arrive URL-decoded, and
        // neither is ever used as a path — the result is looked up in the
        // manifest Map, so a decoded "../" is simply a key that does not exist.
        const id = `${req.params.section}/${req.params.name}`;
        const doc = await DevDocsService.getDoc(id);

        // The audit trail. These are internal architecture documents, so who
        // opened which one is worth an audit record. The
        // document's CONTENT is deliberately not logged.
        logger.info(devDocsMessages.DOC_READ(req.user?.userId, doc.id));

        _noStore(res);
        res.json(
            sendSuccess(RESPONSE_MESSAGES.DEV_DOCS_DOC_FETCHED, {
                id: doc.id,
                title: doc.title,
                markdown: doc.markdown,
                sizeBytes: doc.sizeBytes,
                docCommittedAt: doc.docCommittedAt,
                sourceCommittedAt: doc.sourceCommittedAt,
                freshness: doc.freshness,
            }),
        );
    });

    /**
     * GET /api/v1/dev-docs/search?q=<term>
     * Literal, case-insensitive substring search across the corpus.
     *
     * @type {import("express").RequestHandler}
     */
    static search = catchAsync(async (req, res) => {
        const { results, total, truncated } = await DevDocsService.search(req.query.q);

        // Counts, not the query: `q` is caller-supplied text and would land
        // unescaped in a log file. The counts answer the operational question.
        logger.info(
            devDocsMessages.SEARCH_COMPLETED(req.user?.userId, total, results.length),
        );

        _noStore(res);
        res.json(
            sendSuccess(RESPONSE_MESSAGES.DEV_DOCS_SEARCH_COMPLETED, {
                results: results.map((r) => ({
                    id: r.id,
                    title: r.title,
                    heading: r.heading,
                    snippet: r.snippet,
                    line: r.line,
                })),
                total,
                truncated,
            }),
        );
    });
}

module.exports = DevDocsController;
