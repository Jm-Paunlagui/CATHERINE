

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
 * assembled by `src/utils/systemMap.ts`, built once per process and held in
 * memory. Everything is a required module, so the compiled .exe bundles it and
 * needs no generated artefact.
 *
 * WHY THE API SERVES THEM AND THE FRONTEND DOES NOT BUNDLE THEM
 * ─────────────────────────────────────────────────────────────
 * Same reasoning as DevDocsService: the maps name every route, table, signing
 * step, permission predicate and failure threshold. A copy in the frontend
 * bundle or `public/` would be a static asset with no gate. The route's
 * SUPER_ADMIN predicate is the only control, and it only holds if this is the
 * only copy served.
 */

import { AppError, ARCHITECTURE_ERRORS } from "../constants/errors";
import { HTTP_STATUS } from "../constants";
import { logger } from "../utils/logger";
import architectureMessages from "../constants/messages/architecture.messages";
// Module object, not a destructured function, so tests can spy on the build.
import * as systemMap from "../utils/systemMap";

/** Map name → model. The names are hardcoded here and at the route; never caller input. */
const MODELS = Object.freeze({
    architecture: (require("../constants/architectureModel") as typeof import("../constants/architectureModel")),
    runtime: (require("../constants/runtimeModel") as typeof import("../constants/runtimeModel")),
});

class ArchitectureService {
    /** @type {Map<string, object>} */
    static #maps: Map<string, Record<string, unknown>> = new Map();
    declare static MAP_NAMES: string[];

    /**
     * One map: meta, layers, edgeKinds, nodes, edges, flows, layout.
     *
     * @param {"architecture"|"runtime"} [name="architecture"]
     * @returns {object}
     * @throws {AppError} 500 when the model fails validation
     */
    static getMap(name: "architecture" | "runtime" = "architecture"): Record<string, any> {
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

const __default = ArchitectureService;
export default __default;
const __export_MAP_NAMES = Object.keys(MODELS);
__default.MAP_NAMES = __export_MAP_NAMES;
export { __export_MAP_NAMES as MAP_NAMES };
