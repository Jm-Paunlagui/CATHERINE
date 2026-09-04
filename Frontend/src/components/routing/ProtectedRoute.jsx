/**
 * ProtectedRoute — Dynamic access control component.
 *
 * Ships a MECHANISM, not a hardcoded permission set.
 * Your application defines permission logic inline at the route level.
 *
 * Props:
 *   role        — array of allowed role STRINGS, e.g. ["ADMIN", "SUPER_ADMIN"].
 *                 The check below is `role.includes(user.role)` and `user.role`
 *                 is the T_ADMINS_DEV.ROLE string. A NUMERIC array (`[2, 3]`)
 *                 matches nothing and silently denies everyone — including a
 *                 super admin. Use the ROLES map in App.jsx, never raw numbers.
 *   check       — predicate: (user) => boolean  ← define permissions here
 *   redirectTo  — redirect path if unauthorized (default: '/unauthorized')
 *
 * Examples:
 *
 *   // Role-only
 *   <ProtectedRoute role={[ROLES.ADMIN, ROLES.SADMIN]} />
 *
 *   // Permission-based (your app defines the permission vocabulary)
 *   <ProtectedRoute check={(user) => user.permissions?.includes('FINANCE')} />
 *
 *   // Combined — role gate plus a predicate
 *   <ProtectedRoute
 *       role={[ROLES.ADMIN, ROLES.SADMIN]}
 *       check={(user) => user.permissions?.includes('HR_MANAGER')}
 *   />
 */

import { useEffect, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import LoadingScreen from "../layout/LoadingScreen";
import AuthMiddleware from "../../middleware/authentication/AuthMiddleware";

export default function ProtectedRoute({ role = null, check = null, redirectTo = "/unauthorized" }) {
    const [status, setStatus] = useState("checking"); // 'checking' | 'allowed' | 'denied'
    const [serverError, setServerError] = useState(null);

    useEffect(() => {
        let cancelled = false;

        const verify = async () => {
            const user = await AuthMiddleware.isAuth();

            if (cancelled) return;

            if (!user) {
                setServerError(AuthMiddleware.consumeLastError());
                setStatus("denied");
                return;
            }

            // Role check — user.role is a string: "SUPER_ADMIN" | "ADMIN" | "USER"
            if (role && !role.includes(user.role)) {
                setStatus("denied");
                return;
            }

            // Predicate check (dynamic permissions)
            if (check && !check(user)) {
                setStatus("denied");
                return;
            }

            setStatus("allowed");
        };

        verify();
        return () => {
            cancelled = true;
        };
    }, [role, check]);

    if (status === "checking") {
        return <LoadingScreen />;
    }

    if (status === "denied") {
        return <Navigate to={redirectTo} replace state={serverError ? { _serverError: serverError } : undefined} />;
    }

    return <Outlet />;
}
