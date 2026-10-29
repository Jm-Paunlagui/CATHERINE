"use strict";

/**
 * @fileoverview ArchitectureService — serves the Support system maps
 * (SUPER_ADMIN only):
 *   - "architecture" — the whole system (Support → Architecture)
 *   - "runtime"      — how the server runs: scheduling, backup, resilience,
 *                      shutdown (Support → Runtime)
 *
 * WHERE THE MAPS COME FROM
 * ────────────────────────
 * Each is a hand-authored model under `src/constants/` validated and
 * assembled by `src/utils/systemMap.js`, built once per process and held in
 * memory. Everything is under `src/`, so PKG bundles it and the .exe needs no
 * generated artefact.
 *
 * WHY THE API SERVES THEM AND THE FRONTEND DOES NOT BUNDLE THEM
 * ─────────────────────────────────────────────────────────────
 * Same reasoning as DevDocsService: the maps name every route, table, signing
 * step, permission predicate and failure threshold. A copy in the frontend
 * bundle or `public/` would be a static asset with no gate. The route's
 * SUPER_ADMIN predicate is the only control, and it only holds if this is the
 * only copy served.
 */

const { AppError, ARCHITECTURE_ERRORS } = require("../constants/errors");
const { HTTP_STATUS } = require("../constants");
const { logger } = require("../utils/logger");
const architectureMessages = require("../constants/messages/architecture.messages");
// Module object, not a destructured function, so tests can spy on the build.
const systemMap = require("../utils/systemMap");

/** Map name → model. The names are hardcoded here and at the route; never caller input. */
const MODELS = Object.freeze({
    architecture: require("../constants/architectureModel"),
    runtime: require("../constants/runtimeModel"),
});

class ArchitectureService {
    /** @type {Map<string, object>} */
    static #maps = new Map();

    /**
     * One map: meta, layers, edgeKinds, nodes, edges, flows, layout.
     *
     * @param {"architecture"|"runtime"} [name="architecture"]
     * @returns {object}
     * @throws {AppError} 500 when the model fails validation
     */
    static getMap(name = "architecture") {
        const cached = ArchitectureService.#maps.get(name);
        if (cached) return cached;
        try {
            const model = MODELS[name];
            if (!model) throw new Error(`unknown system map "${name}"`);
            const map = systemMap.buildSystemMap(model);
            ArchitectureService.#maps.set(name, map);
            return map;
        } catch (err) {
            // Not cached: a fixed model is picked up on the next request. The
            // validator's message goes to the log only — it names nodes and
            // edges, which is exactly what a failed caller must not receive.
            logger.error(architectureMessages.MAP_BUILD_FAILED(name, err.message));
            throw new AppError(ARCHITECTURE_ERRORS.MAP_UNAVAILABLE, HTTP_STATUS.INTERNAL_SERVER_ERROR, {
                type: "InternalError",
            });
        }
    }

    /** Drops every cached map. Tests only. */
    static invalidate() {
        ArchitectureService.#maps.clear();
    }
}

module.exports = ArchitectureService;
module.exports.MAP_NAMES = Object.keys(MODELS);
