/**
 * The verified access-token claims of a request on a route behind
 * AuthMiddleware.authenticate.
 *
 * `req.user` is typed optional because public routes have none. Handlers on
 * authenticated routes call this instead of reading `req.user!`, so a route
 * wired without `authenticate` fails with a 401 rather than passing
 * `undefined` into a service.
 */
import type { Request } from "express";
import type { AuthUser } from "../../types/express";
import { AppError, AUTH_ERRORS } from "../../constants/errors";
import { HTTP_STATUS } from "../../constants";

function requireAuthUser(req: Request): AuthUser {
    if (!req.user) {
        throw new AppError(AUTH_ERRORS.AUTHENTICATION_REQUIRED, HTTP_STATUS.UNAUTHORIZED);
    }
    return req.user;
}

export { requireAuthUser };
