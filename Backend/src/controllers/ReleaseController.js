"use strict";

/**
 * ReleaseController
 *
 * Thin HTTP layer for the release-train state. Read-only: it exposes the derived
 * state + draft entries the UI seeds the create form with. Entries themselves are
 * written through the normal POST /api/v1/changelog path (single write path), so
 * there are no mutating release endpoints.
 */

const { sendSuccess, RESPONSE_MESSAGES } = require("../constants/responses");
const { catchAsync } = require("../utils/catchAsync");
const ReleaseService = require("../services/ReleaseService");

class ReleaseController {
    /**
     * GET /api/v1/changelog/release/current
     * Returns the derived release state, allowed actions, and the draft entry
     * each action would pre-fill in the create form.
     * @type {import("express").RequestHandler}
     */
    static current = catchAsync(async (req, res) => {
        res.json(
            sendSuccess(
                RESPONSE_MESSAGES.RELEASE_STATE_FETCHED,
                ReleaseService.getState(),
            ),
        );
    });
}

module.exports = ReleaseController;
