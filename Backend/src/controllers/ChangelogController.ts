"use strict";

/**
 * ChangelogController
 *
 * Thin HTTP layer for the changelog feature.
 * No business logic — delegates entirely to ChangelogService.
 */

const { HTTP_STATUS }                      = require("../constants");
const { sendSuccess, RESPONSE_MESSAGES } = require("../constants/responses");
const { catchAsync }                      = require("../utils/catchAsync");
const ChangelogService                    = require("../services/ChangelogService");

class ChangelogController {
    /**
     * GET /api/v1/changelog
     * Lists all changelog entries.
     *
     * @type {import("express").RequestHandler}
     */
    static list = catchAsync(async (req, res) => {
        const entries = ChangelogService.listAll();
        res.json(sendSuccess(RESPONSE_MESSAGES.CHANGELOG_LIST_FETCHED, entries));
    });

    /**
     * GET /api/v1/changelog/public
     * Lists all changelog entries for unauthenticated callers, with the
     * author/co-author names stripped (see ChangelogService.listPublic).
     *
     * @type {import("express").RequestHandler}
     */
    static listPublic = catchAsync(async (req, res) => {
        const entries = ChangelogService.listPublic();
        res.json(sendSuccess(RESPONSE_MESSAGES.CHANGELOG_LIST_FETCHED, entries));
    });

    /**
     * GET /api/v1/changelog/public/latest
     * The newest public entry only (`data` is the entry, or null when empty) —
     * what the version badge reads, without the full list.
     *
     * @type {import("express").RequestHandler}
     */
    static latestPublic = catchAsync(async (req, res) => {
        const entry = ChangelogService.latestPublic();
        res.json(sendSuccess(RESPONSE_MESSAGES.CHANGELOG_LATEST_FETCHED, entry));
    });

    /**
     * POST /api/v1/changelog
     * Creates a new changelog entry. SADMIN only.
     *
     * @type {import("express").RequestHandler}
     */
    static create = catchAsync(async (req, res) => {
        const entry = ChangelogService.create(req.body);
        res.status(HTTP_STATUS.CREATED).json(sendSuccess(RESPONSE_MESSAGES.CHANGELOG_ENTRY_CREATED, entry, HTTP_STATUS.CREATED));
    });

    /**
     * PUT /api/v1/changelog/:id
     * Updates a changelog entry. SADMIN only.
     *
     * @type {import("express").RequestHandler}
     */
    static update = catchAsync(async (req, res) => {
        const entry = ChangelogService.update(req.params.id, req.body);
        res.json(sendSuccess(RESPONSE_MESSAGES.CHANGELOG_ENTRY_UPDATED, entry));
    });

    /**
     * DELETE /api/v1/changelog/:id
     * Removes a changelog entry. SADMIN only.
     *
     * @type {import("express").RequestHandler}
     */
    static delete = catchAsync(async (req, res) => {
        ChangelogService.delete(req.params.id);
        res.json(sendSuccess(RESPONSE_MESSAGES.CHANGELOG_ENTRY_DELETED, null));
    });
}

module.exports = ChangelogController;
