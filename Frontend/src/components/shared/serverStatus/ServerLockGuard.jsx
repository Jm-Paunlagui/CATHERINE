/**
 * ServerLockGuard — Renders nothing; applies the server lock and the outage redirect.
 *
 * Mounted once in App.jsx beside `ServerStatusWatch`, inside the Router. While the server store shows a
 * visible restarting/unavailable episode every control is made inert (see `serverLockDom`), except on the
 * outage route itself. When the store escalates to danger it navigates to that route (`useOutageRedirect`).
 * The lock is a layout effect so nothing paints unlocked.
 *
 * WCAG 2.2.1: the forced redirect is an essential time limit (the server is unreachable).
 */

import { useLayoutEffect } from "react";
import { useLocation } from "react-router-dom";
import { isOutageRoute } from "./outageRoute";
import { applyServerLock } from "./serverLockDom";
import { useOutageRedirect } from "./useOutageRedirect";
import { useServerLock } from "./useServerLock";

/** @returns {null} */
export function ServerLockGuard() {
    const { locked, shouldRedirect } = useServerLock({ tick: false }); // never renders the countdown: no per-second re-render
    const { pathname, search } = useLocation();
    const onOutage = isOutageRoute(pathname);
    useOutageRedirect({ shouldRedirect, onOutageRoute: onOutage, pathname, search });
    useLayoutEffect(() => (locked && !onOutage ? applyServerLock(document) : undefined), [locked, onOutage]);
    return null;
}

export default ServerLockGuard;
