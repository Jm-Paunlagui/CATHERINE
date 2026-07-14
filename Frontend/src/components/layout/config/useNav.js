/**
 * useNav — shared navigation hook for Navbar and Sidebar.
 *
 * Single source of truth for auth state, logout, and nav data.
 * Both layout components call this hook; neither duplicates the logic.
 *
 * Returns:
 *   user          — decoded user object (null when unauthenticated or loading)
 *   isLoading     — true while the auth check is in flight
 *   navGroups     — role-based nav groups from nav.config ([] when unauthenticated)
 *   profileItems  — profile + logout items (shape usable by both renderers)
 *   authFlatLinks — top-level authenticated links (e.g. Dashboard)
 *   publicLinks   — unauthenticated links (Home, Help, Sign In)
 *   logout        — fire-and-forget logout handler
 */

import { ArrowRightStartOnRectangleIcon, UserCircleIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { AuthMiddleware } from "../../../middleware/authentication/AuthMiddleware";
import { AUTH_FLAT_LINKS, NAV_GROUPS, PUBLIC_LINKS } from "./nav.config";

export function useNav() {
    const [user, setUser] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const [profileOpen, setProfileOpen] = useState(false);
    const navigate = useNavigate();

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const u = await AuthMiddleware.isAuth();
            if (!cancelled) {
                setUser(u || null);
                setIsLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const logout = useCallback(() => {
        navigate("/user/logout");
    }, [navigate]);

    const openProfile = useCallback(() => setProfileOpen(true), []);
    const closeProfile = useCallback(() => setProfileOpen(false), []);

    // Role-based groups from config — empty array when unauthenticated or loading
    const navGroups = useMemo(() => {
        if (isLoading || !user) return [];
        return NAV_GROUPS[user.role] ?? NAV_GROUPS.USER ?? [];
    }, [isLoading, user]);

    // Profile + sign-out items — icon is a component ref so NavIcon can apply className
    const profileItems = useMemo(() => {
        if (!user) return [];
        return [
            {
                id: "profile",
                name: "Your Profile",
                label: "Your Profile",
                icon: UserCircleIcon,
                danger: false,
                onClick: openProfile,
            },
            { divider: true },
            {
                id: "logout",
                name: "Sign out",
                label: "Sign out",
                href: "/user/logout",
                icon: ArrowRightStartOnRectangleIcon,
                danger: true,
                onClick: logout,
            },
        ];
    }, [user, logout, openProfile]);

    return {
        user,
        isLoading,
        navGroups,
        profileItems,
        authFlatLinks: AUTH_FLAT_LINKS,
        publicLinks: PUBLIC_LINKS,
        logout,
        profileOpen,
        openProfile,
        closeProfile,
    };
}
