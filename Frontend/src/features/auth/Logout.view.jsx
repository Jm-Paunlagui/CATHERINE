/**
 * Logout.view.jsx — Logout page.
 * Delegates to useAuth().logout which calls the backend (clears HTTP-only
 * token cookies), clears local state, and navigates to /auth.
 */

import { useEffect, useRef } from "react";
import { ErrorBoundary } from "../../components/feedback/ErrorBoundary";
import { Spinner } from "../../components/ui/Spinner";
import { useAuth } from "./auth.hook";

export default function LogoutView() {
    const { logout } = useAuth();
    const hasRun = useRef(false);

    useEffect(() => {
        if (hasRun.current) return;
        hasRun.current = true;
        logout();
    }, [logout]);

    return (
        <ErrorBoundary>
            <Spinner fullPage size="lg" label="Signing out…" />
        </ErrorBoundary>
    );
}
