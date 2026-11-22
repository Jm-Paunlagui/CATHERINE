

/**
 * Wraps an async controller function so rejected promises
 * are forwarded to Express's error-handling middleware.
 *
 * Usage:
 *   const { catchAsync } = require('../utils/catchAsync');
 *
 *   exports.getUser = catchAsync(async (req, res) => {
 *       const user = await userService.getById(req.params.id);
 *       res.json(sendSuccess('USER fetched', user));
 *   });
 *
 * @param {Function} fn - Async (req, res, next) => Promise
 * @returns {Function}  Express middleware
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
function catchAsync(fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        try {
            Promise.resolve(fn(req, res, next)).catch(next);
        } catch (err) {
            next(err);
        }
    };
}

export { catchAsync };
