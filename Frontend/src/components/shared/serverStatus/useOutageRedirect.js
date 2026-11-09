/**
 * useOutageRedirect.js — Sends the user to the 523 page, in-app, once per outage episode.
 *
 * WHAT THIS FILE DOES
 *   When the server-status store's own danger timer fires (`shouldRedirect`), stashes the
 *   `{code:523, returnTo}` hand-off (same shape HttpClient writes, so the 523 page's "Continue"
 *   returns the user to where they were) and calls `navigate(OUTAGE_ROUTE, { replace: true })`.
 *
 *   Once per episode: `handledEpisodeId` is module-level (survives StrictMode replays and remounts).
 *   The episode is marked handled even when the user is already on the outage route, so leaving it
 *   by SPA navigation in the same episode does not bounce them back.
 *
 * WCAG 2.2.1: this forced redirect is an ESSENTIAL time limit (the server is unreachable).
 *
 * SECURITY: CWE-601 — the hint is only a path; consumers re-validate with `sanitizeReturnTo`.
 * Big-O: O(1).
 */

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { getServerEpisode } from "../../../utils/serverStatus";
import { returnToFor } from "../../../utils/returnTo";
import { handOffErrorPagePayload } from "../../../utils/storage";
import { OUTAGE_ROUTE } from "./outageRoute";

let handledEpisodeId = 0;

/**
 * @param {{ shouldRedirect: boolean, onOutageRoute: boolean, pathname: string, search: string }} args
 * @returns {void}
 */
export function useOutageRedirect({ shouldRedirect, onOutageRoute, pathname, search }) {
    const navigate = useNavigate();
    useEffect(() => {
        if (!shouldRedirect) return;
        const episode = getServerEpisode();
        if (episode.id === 0 || episode.id === handledEpisodeId) return;
        handledEpisodeId = episode.id;
        if (onOutageRoute) return;
        handOffErrorPagePayload({ code: 523, title: null, message: null, requestId: null, retryAfter: null, returnTo: returnToFor(pathname, search) });
        navigate(OUTAGE_ROUTE, { replace: true });
    }, [shouldRedirect, onOutageRoute, pathname, search, navigate]);
}

/** Test-only: forgets which episode was handled. */
export function _resetOutageRedirectForTests() {
    handledEpisodeId = 0;
}
