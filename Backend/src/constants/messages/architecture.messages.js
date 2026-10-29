"use strict";

/**
 * @fileoverview Server-side log templates for the Support system maps —
 * Architecture and Runtime (GET /api/v1/architecture[/runtime], SUPER_ADMIN only).
 *
 * Log lines only — client-facing text lives in `constants/errors` and
 * `constants/responses`. Same standing rule as devdocs.messages.js: log WHO
 * read the map and how big it was, never its contents.
 */

const architectureMessages = {
    /**
     * The map was served. Audit trail: it is an internal map of a money
     * system, so who opened it is worth recording.
     *
     * @param {string} name - "architecture" | "runtime"
     * @param {number|string} adminId
     * @param {number} nodeCount
     * @param {number} flowCount
     * @returns {string}
     */
    MAP_SERVED: (name, adminId, nodeCount, flowCount) =>
        `System map "${name}" served — ADMIN_ID: ${adminId}, nodes: ${nodeCount}, flows: ${flowCount}.`,

    /**
     * The model failed validation, so no map could be built. Server-side only:
     * the validator's message names nodes and edges.
     *
     * @param {string} name - "architecture" | "runtime"
     * @param {string} reason - the validator's error message
     * @returns {string}
     */
    MAP_BUILD_FAILED: (name, reason) =>
        `System map "${name}" could not be built (src/constants/${name}Model.js): ${reason}`,
};

module.exports = architectureMessages;
