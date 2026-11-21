"use strict";

/**
 * ssePreflight.js — the ONE way an SSE route refuses a request before the
 * connection is upgraded to `text/event-stream`.
 *
 * WHY THIS EXISTS. An SSE handler cannot be wrapped in `catchAsync`: once the
 * response is upgraded, the global error handler would try to write an HTTP
 * error onto a stream that is already flowing, crashing the request with a
 * write-after-end. So every SSE route hand-rolls its own pre-upgrade refusals —
 * and five controllers had each hand-rolled a DIFFERENT one. All five emitted a
 * bare `{ status, code, message, error: { type } }`, missing the `title` and
 * `requestId` that `sendError` puts on every other error in the API, and
 * carrying inline message strings that belong in `constants/errors`.
 *
 * That mattered for more than tidiness: `requestId` is how a client-reported
 * failure is traced back to a log line, and an SSE refusal was the one error
 * shape in the whole API that could not be traced.
 *
 * WHAT THIS IS NOT. It is not a replacement for `AppError` +
 * `ErrorHandlerMiddleware` — that path stays correct for every non-SSE route,
 * and this helper deliberately does NOT `throw`. It formats and sends, because
 * the whole point is to answer BEFORE the upgrade, on a response that must not
 * reach the global handler.
 *
 * Only ever call this before the first `res.writeHead`/`res.write` of the
 * stream. After the upgrade, report failures as an SSE `event: error` frame.
 */

const { sendError } = require("../../constants/responses");

/**
 * Sends a pre-upgrade SSE refusal using the SAME envelope as every other error
 * in the API.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {string} message - from `constants/errors`, never an inline literal.
 * @param {number} code    - HTTP status.
 * @param {{ type?: string, details?: object[], hint?: string }} [opts]
 * @returns {void}
 */
function sendSsePreflightError(req, res, message, code, opts = {}) {
    res.status(code).json(
        sendError(message, code, {
            ...opts,
            // `req.id` is the snowflake stamped by TraceabilityMiddleware and is
            // what ErrorHandlerMiddleware puts on every other error envelope.
            requestId: req?.id ?? null,
        }),
    );
}

/**
 * Sends the "this scope has nothing to stream" answer.
 *
 * Deliberately a 200 with a body, not an error: the request was valid and
 * correctly authorised, and the honest answer is "there is nothing live here"
 * — a closed period has no updates to push. Keeping it a success also stops a
 * client's generic error handling from firing on an expected, routine outcome.
 *
 * Wrapped so the shape is stated in one place; it was previously an anonymous
 * object literal in each controller with no envelope at all.
 *
 * @param {import('express').Response} res
 * @param {string} reason - a stable machine-readable token, e.g.
 *   "NOT_CURRENT_CUTOFF". Clients branch on this; do not localise it.
 * @returns {void}
 */
function sendSseNotStreamable(res, reason) {
    res.status(200).json({ streamable: false, reason });
}

module.exports = { sendSsePreflightError, sendSseNotStreamable };
