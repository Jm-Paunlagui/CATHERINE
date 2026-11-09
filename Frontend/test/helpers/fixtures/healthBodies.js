/**
 * healthBodies.js — GET health/ready bodies as the API sends them.
 *
 * DB down (a gating pool is down): 503, error.type "ServiceUnavailableError", data.ready:false with per-pool
 * checks. The pool names and details are deliberately recognisable so security tests can prove they never
 * reach the UI.
 */
import { fail } from "./contract.js";

export const POOL_SECRETS = ["appDb", "appDbBulk", "ORA-12541-SECRET-DETAIL"];

/** @returns {object} 503 envelope for "the API is up but a gating DB pool is down". */
export function dbDownBody() {
    return {
        ...fail("Service not ready", 503, { type: "ServiceUnavailableError" }),
        data: {
            ready: false,
            checks: {
                appDb: { status: "down", detail: "ORA-12541-SECRET-DETAIL" },
                appDbBulk: { status: "up" },
            },
        },
    };
}
