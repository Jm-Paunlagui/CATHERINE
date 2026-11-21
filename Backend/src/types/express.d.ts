/**
 * Express request extensions this backend adds at runtime.
 *
 * Declaration merging into the global `Express.Request` that @types/express
 * reads, so every `Request` in src/ carries these fields.
 */
import type { JwtPayload } from "jsonwebtoken";

/**
 * Verified access-token claims, attached by AuthMiddleware after jwt.verify.
 * Claims beyond the named ones stay reachable through JwtPayload's index signature.
 */
export interface AuthUser extends JwtPayload {
    userId?: string | number;
    id?: string | number;
    username?: string;
    role?: string;
    firstName?: string;
    fid?: string | number;
    GID?: string | number;
}

declare global {
    namespace Express {
        interface Request {
            /** Request id stamped by TraceabilityMiddleware. */
            id?: string;
            /** Set by AuthMiddleware.authenticate; absent on public routes. */
            user?: AuthUser;
            /** TraceabilityMiddleware: the incoming line was already logged. */
            _incomingLogged?: boolean;
        }
    }
}
