/**
 * contract.js — builders for the backend's two response envelopes.
 *
 * Shapes mirror `Backend/src/constants/responses/index.js` exactly:
 *
 *   sendSuccess → { status: "success", code, message, requestId, data }
 *   sendError   → { status: "error",   code, title, message, requestId,
 *                   error: { type, details?, hint? } }
 *
 * FIVE keys on success, six on error. `requestId` is present on BOTH — the
 * backend's `TraceabilityMiddleware` stamps it on every body — even though the
 * `@returns` JSDoc on `sendSuccess` omits it. Fixtures always carry one so a
 * test that asserts on `error.requestId` or `<RequestIdTag>` is exercising the
 * real path rather than a fixture-shaped one.
 *
 * Never hand-write an envelope inside a feature handler. A hand-rolled body
 * that drifts from the server produces a suite that agrees with itself and
 * with nothing else.
 */

// `title` is READ from the app's own map rather than duplicated here. A
// hand-copied title table is exactly the artefact `httpStatus.test.js` exists
// to catch — duplicating it in the fixtures would let both copies drift
// together and make the contract test vacuous.
import { getStatusTitle } from "../../../src/constants/httpStatus.js";

let _reqSeq = 0;

/**
 * Deterministic-but-unique request id, standing in for the backend's nanoid.
 * @returns {string} e.g. `"test-req-000001"`
 */
export function nextRequestId() {
    _reqSeq += 1;
    return `test-req-${String(_reqSeq).padStart(6, "0")}`;
}

/**
 * Build a success body identical to the backend's `sendSuccess()`.
 *
 * @param {string} message
 * @param {*} [data=null]
 * @param {number} [code=200]
 * @returns {{ status: "success", code: number, message: string, requestId: string, data: * }}
 * @example HttpResponse.json(ok("Data fetched successfully.", []))
 */
export function ok(message, data = null, code = 200) {
    return { status: "success", code, message, requestId: nextRequestId(), data };
}

/**
 * Build an error body identical to the backend's `sendError()`.
 *
 * `title` is derived from `code`, never passed in — the server derives it the
 * same way, so a fixture cannot claim a title the server would not have sent.
 *
 * @param {string} message
 * @param {number} [code=500]
 * @param {{ type?: string, details?: Array<{field: string, issue: string}>, hint?: string }} [opts]
 * @returns {{ status: "error", code: number, title: string, message: string, requestId: string, error: object }}
 * @example HttpResponse.json(fail("Invalid input.", 400, { type: "ValidationError" }), { status: 400 })
 */
export function fail(message, code = 500, opts = {}) {
    return {
        status: "error",
        code,
        title: getStatusTitle(code),
        message,
        requestId: nextRequestId(),
        error: {
            type: opts.type ?? "AppError",
            ...(opts.details ? { details: opts.details } : {}),
            ...(opts.hint ? { hint: opts.hint } : {}),
        },
    };
}
