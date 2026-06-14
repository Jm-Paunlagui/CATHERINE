/**
 * useDocumentTitle.js — Set document.title dynamically.
 *
 * Usage:
 *   useDocumentTitle('Admin Management');              // "Admin Management — App"
 *   useDocumentTitle('Dashboard', 'MyApp');           // "Dashboard — MyApp"
 *   useDocumentTitle('Report', undefined, true);      // keep title on unmount
 */

import { useEffect, useRef } from "react";

/**
 * Sets the browser tab title reactively.
 * On unmount, reverts to the previous title (unless `keepOnUnmount` is true).
 * Falls back to `VITE_APP_NAME` env var or `"App"` when suffix is omitted.
 *
 * @param {string} title - The page-specific title segment (e.g. "Admin Management").
 * @param {string} [suffix] - App name suffix shown after the separator.
 *   Defaults to `import.meta.env.VITE_APP_NAME ?? "App"`.
 * @param {boolean} [keepOnUnmount=false] - When true, the title is NOT reverted on unmount.
 *   Use for root-level routes where reverting would cause a flash.
 * @returns {void}
 *
 * @example
 * // Basic usage — produces "Dashboard — MEAL"
 * useDocumentTitle("Dashboard");
 *
 * @example
 * // Custom suffix — produces "Settings — MyApp"
 * useDocumentTitle("Settings", "MyApp");
 *
 * @example
 * // Keep title on unmount (no revert)
 * useDocumentTitle("Home", undefined, true);
 */
export function useDocumentTitle(title, suffix, keepOnUnmount = false) {
    const appName = suffix ?? import.meta.env.VITE_APP_NAME ?? "App";
    const prevTitle = useRef(document.title);

    useEffect(() => {
        if (!title) return;
        document.title = appName ? `${title} — ${appName}` : title;
        return () => {
            if (!keepOnUnmount) document.title = prevTitle.current;
        };
    }, [title, appName, keepOnUnmount]);
}

export default useDocumentTitle;
