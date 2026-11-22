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
    /** The account's username (AuthService signs String(userId)). */
    userId: string;
    /** Same as userId. */
    username: string;
    /** Numeric admin id; null for user accounts. */
    id: number | null;
    role: string;
    firstName?: string | null;
    /** Refresh-token family id. */
    fid?: string;
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
            /** routeLabel.captureRouteLabel: the matched route template, captured before the router unwinds. */
            _routeLabel?: string;
        }
    }
}
