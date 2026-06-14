import { useEffect, useState } from "react";
import AuthMiddleware from "../../middleware/authentication/AuthMiddleware";

/**
 * @returns {{ user: object|null, loading: boolean }}
 */
export function useDashboard() {
    const [user, setUser]       = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        AuthMiddleware.isAuth().then((u) => {
            if (!cancelled) {
                setUser(u || null);
                setLoading(false);
            }
        });
        return () => { cancelled = true; };
    }, []);

    return { user, loading };
}
