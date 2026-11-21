"use strict";

/**
 * ArchitectureController
 *
 * Thin HTTP layer for the Support system maps — Architecture and Runtime.
 * ArchitectureService owns building them; this file only shapes responses.
 *
 * Same two rules as DevDocsController:
 *   1. The payload is projected key by key, so anything later added to a map
 *      is opt-in to the response, not leaked by default.
 *   2. Every response is `private, no-store` — a SUPER_ADMIN-only body in a
 *      shared cache is the same disclosure by another route.
 *
 * The access control is the route's `requireSuperAdmin`; nothing here
 * re-checks the role.
 */

const { sendSuccess, RESPONSE_MESSAGES } = require("../constants/responses");
const { catchAsync } = require("../utils/catchAsync");
const ArchitectureService = require("../services/ArchitectureService");
const architectureMessages = require("../constants/messages/architecture.messages");
const { logger } = require("../utils/logger");

/**
 * @private
 * Builds a handler for one named map. The name is fixed per route — never
 * read from the request.
 *
 * @param {"architecture"|"runtime"} name
 * @param {string} message - success message from RESPONSE_MESSAGES
 * @returns {import("express").RequestHandler}
 */
function _serve(name, message) {
    return catchAsync(async (req, res) => {
        const { meta, layers, edgeKinds, nodes, edges, flows, layout } = ArchitectureService.getMap(name);

        logger.info(architectureMessages.MAP_SERVED(name, req.user?.userId, nodes.length, flows.length));

        res.set("Cache-Control", "private, no-store, max-age=0");
        res.set("Pragma", "no-cache");
        res.json(sendSuccess(message, { meta, layers, edgeKinds, nodes, edges, flows, layout }));
    });
}

class ArchitectureController {
    /**
     * GET /api/v1/architecture
     * The whole-system map in one response — the page needs every node and
     * edge to draw anything, so there is nothing useful to paginate.
     */
    static getMap = _serve("architecture", RESPONSE_MESSAGES.ARCHITECTURE_MAP_FETCHED);

    /**
     * GET /api/v1/architecture/runtime
     * The server-runtime map: scheduling, backup, resilience, shutdown.
     */
    static getRuntimeMap = _serve("runtime", RESPONSE_MESSAGES.RUNTIME_MAP_FETCHED);
}

module.exports = ArchitectureController;
