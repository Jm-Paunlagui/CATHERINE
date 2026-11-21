// @ts-nocheck -- TS migration: delete this line when the file is typed (bun run typecheck).


/**
 * ReleaseController
 *
 * Thin HTTP layer for the release-train state. Read-only: it exposes the derived
 * state + draft entries the UI seeds the create form with. Entries themselves are
 * written through the normal POST /api/v1/changelog path (single write path), so
 * there are no mutating release endpoints.
 */

import type { Request, Response } from "express";
import { sendSuccess, RESPONSE_MESSAGES } from "../constants/responses";
import { catchAsync } from "../utils/catchAsync";
import ReleaseService from "../services/ReleaseService";

class ReleaseController {
    /**
     * GET /api/v1/changelog/release/current
     * Returns the derived release state, allowed actions, and the draft entry
     * each action would pre-fill in the create form.
     * @type {import("express").RequestHandler}
     */
    static current: import("express").RequestHandler = catchAsync(async (req: Request, res: Response) => {
        res.json(
            sendSuccess(
                RESPONSE_MESSAGES.RELEASE_STATE_FETCHED,
                ReleaseService.getState(),
            ),
        );
    });
}

export default ReleaseController;
