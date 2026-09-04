/**
 * useExportAccess.js — resolves whether the signed-in user may bulk-export.
 *
 * Bulk export is an ADMIN / SUPER_ADMIN capability across every view that
 * offers it. A feature that is stricter still (SUPER_ADMIN-only) passes
 * `requireSuperAdmin` rather than relaxing its own boundary.
 *
 * This is a UX gate, NOT the security boundary: every export endpoint re-checks
 * the caller's role server-side. Hiding a button the server would refuse anyway
 * just avoids showing an action that always 403s.
 *
 * `AuthMiddleware.isAuth()` caches for 5 minutes and deduplicates concurrent
 * calls internally, so no `initFiredRef` guard is needed here.
 */

import { useEffect, useState } from "react";
import AuthMiddleware from "../middleware/authentication/AuthMiddleware";

/**
 * @param {{ requireSuperAdmin?: boolean }} [options]
 * @returns {{ canExport: boolean, role: string|null, resolved: boolean }}
 *   `resolved` flips true once the role lookup settles — use it to avoid
 *   flashing an export button before the role is known.
 */
export function useExportAccess({ requireSuperAdmin = false } = {}) {
    const [role, setRole] = useState(null);
    const [resolved, setResolved] = useState(false);

    useEffect(() => {
        let cancelled = false;
        AuthMiddleware.isAuth()
            .then((u) => {
                if (cancelled) return;
                setRole(u?.role ?? null);
            })
            .catch(() => {
                if (!cancelled) setRole(null);
            })
            .finally(() => {
                if (!cancelled) setResolved(true);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const canExport = requireSuperAdmin ? role === "SUPER_ADMIN" : role === "ADMIN" || role === "SUPER_ADMIN";

    return { canExport, role, resolved };
}

export default useExportAccess;
