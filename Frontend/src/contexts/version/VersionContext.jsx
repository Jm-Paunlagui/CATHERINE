/**
 * VersionContext — app-wide "current version" resolved from Version History.
 *
 * The navbar/sidebar badge should always match the newest entry on the Version
 * History page rather than a hand-maintained constant. This provider fetches the
 * latest changelog entry once on mount and exposes its version; the release
 * stage is then inferred from that version's semver pre-release tag (so the number
 * and the stage badge always agree — e.g. "1.17.12" → Stable, "1.18.0-beta.1" → Beta).
 *
 * The changelog GET /api/v1/changelog endpoint is PUBLIC (no auth required), so
 * the version resolves immediately on any page — including the home page and
 * login screen — without waiting for the user to authenticate.
 *
 * Fallback: if the request fails (network error, backend down), it falls back to
 * the build-time config values from src/config/appVersion.js (VITE_APP_VERSION /
 * package.json + VITE_APP_STAGE).
 */

/* eslint-disable react-refresh/only-export-components */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

import { APP_STAGE, APP_VERSION, parseStageFromVersion } from "../../config/appVersion";
import { changelogApi } from "../../features/support/changelog/changelog.api";

const VersionContext = createContext(null);

const FALLBACK = { version: APP_VERSION, stage: APP_STAGE, resolved: false, refresh: () => {} };

const STORAGE_KEY = "app_ver";

// Read the last-known version from sessionStorage so that a page refresh shows
// the correct version immediately instead of flashing the build-time fallback
// ("1.0.0" from package.json) until the API fetch completes.
// sessionStorage is tab-scoped — cleared when the tab closes, so the next fresh
// session always re-validates against the API.
function readStoredVersion() {
    try {
        return sessionStorage.getItem(STORAGE_KEY) || null;
    } catch {
        return null;
    }
}

function writeStoredVersion(v) {
    try {
        sessionStorage.setItem(STORAGE_KEY, v);
    } catch {
        // quota exceeded or private-browsing restriction — silent no-op
    }
}

// Module-scoped cache: initialised from sessionStorage so page refreshes see
// the real version immediately. Shared across navigations; cleared on tab close.
let cachedVersion = readStoredVersion();

export function VersionProvider({ children }) {
    const { pathname } = useLocation();
    const [version, setVersion] = useState(cachedVersion ?? APP_VERSION);
    const [resolved, setResolved] = useState(Boolean(cachedVersion));
    // initFiredRef persists across React Strict Mode's artificial unmount/remount,
    // so the double-invocation in dev never launches a second in-flight request.
    const initFiredRef = useRef(false);

    useEffect(() => {
        if (cachedVersion || initFiredRef.current) return;
        initFiredRef.current = true;

        // The changelog GET endpoint is PUBLIC — no auth required. Fetch
        // immediately so the version badge is correct on every page, including
        // the home page and login screen, without waiting for authentication.
        (async () => {
            try {
                const res = await changelogApi.list();
                const latest = res.data?.data?.[0]?.version;
                if (latest) {
                    const v = String(latest).trim();
                    cachedVersion = v;
                    writeStoredVersion(v);
                    setVersion(v);
                    setResolved(true);
                }
            } catch {
                initFiredRef.current = false; // allow retry on next navigation
            }
        })();
    }, [pathname]);

    // Force a re-resolve of the current version from the API and update the
    // module cache + sessionStorage. Call this after a release-train action
    // (promote / cut / open) so the navbar/sidebar badge flips immediately
    // instead of waiting for the tab to close.
    const refresh = useCallback(async () => {
        try {
            const res = await changelogApi.list();
            const latest = res.data?.data?.[0]?.version;
            if (latest) {
                const v = String(latest).trim();
                cachedVersion = v;
                writeStoredVersion(v);
                setVersion(v);
                setResolved(true);
            }
        } catch {
            // keep the current value on failure — non-fatal
        }
    }, []);

    // Stage source of truth = the shown version's pre-release tag. When still on
    // the config fallback, defer to the build-time stage so dev builds read
    // "Developer Preview" until the real version resolves.
    const stage = resolved ? (parseStageFromVersion(version) ?? "stable") : APP_STAGE;

    return <VersionContext.Provider value={{ version, stage, resolved, refresh }}>{children}</VersionContext.Provider>;
}

/**
 * @returns {{ version: string, stage: string, resolved: boolean, refresh: () => Promise<void> }}
 */
export function useVersion() {
    return useContext(VersionContext) ?? FALLBACK;
}
