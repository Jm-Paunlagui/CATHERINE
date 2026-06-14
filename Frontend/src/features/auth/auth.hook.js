/**
 * auth.hook.js — Authentication state and handlers.
 *
 * Business logic layer. Uses auth.api.js for HTTP calls.
 * Views import this hook — never auth.api.js directly.
 */

import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "../../components/ui/toast.utils";
import AuthMiddleware from "../../middleware/authentication/AuthMiddleware";
import CsrfMiddleware from "../../middleware/security/CsrfMiddleware";
import { authApi } from "./auth.api";

const SESSION_TIMEOUT_MS = parseInt(import.meta.env.VITE_SESSION_TIMEOUT_MS ?? String(30 * 60 * 1000), 10);

export const useAuth = () => {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [integrityError, setIntegrityError] = useState(false);
    const [rateLimitSeconds, setRateLimitSeconds] = useState(null);
    const [accountLocked, setAccountLocked] = useState(false);
    const navigate = useNavigate();

    /**
     * Log in with userId + password.
     *
     * The view uses "username" as the form field name (UX label).
     * We map it to "userId" here to match the backend contract.
     *
     * The server sets the HTTP-only signed token + refreshToken cookies.
     * A non-PII session hint is written to localStorage for the isAuth() fast-path.
     */
    const login = useCallback(
        async (credentials, redirectPath = import.meta.env.VITE_DEFAULT_REDIRECT || "/operations/consumption") => {
            setLoading(true);
            setError(null);
            setIntegrityError(false);
            setAccountLocked(false);
            try {
                const response = await authApi.login({
                    userId: credentials.username ?? credentials.userId,
                    password: credentials.password,
                });

                const user = response.data?.data?.user;

                // Persist only the numeric ms expiry timestamp — no PII, no user payload
                // (CWE-312). useSessionWarning reads this key to compute its warning delay.
                if (user) {
                    const expiresAt = Date.now() + SESSION_TIMEOUT_MS;
                    localStorage.setItem("session_exp", String(expiresAt));
                }

                // Set the non-PII session hint, clear the stale cache, and write
                // the minimal traceability identity for X-Client-Username headers.
                AuthMiddleware.authenticate(
                    user ? { firstName: user.firstName, lastName: user.lastName, userId: user.userId } : null,
                );

                // Redirect to change-password flow when the account is using
                // the system default password or when the server explicitly
                // requires a password change on this session.
                if (user?.requiresPasswordChange) {
                    toast.info("Please change your password before continuing.");
                    navigate("/auth/change-password");
                } else {
                    const landingPath = user?.role === "ROBOT" ? (import.meta.env.VITE_ROBOT_REDIRECT || redirectPath) : redirectPath;
                    navigate(landingPath);
                }
                toast.success(response.data?.message || "Welcome!");
                return true;
            } catch (err) {
                const message = err.response?.data?.message || err.message || "Login failed";
                const errorType = err.response?.data?.error?.type;
                setError(message);
                if (err.response?.status === 422 && errorType === "DataIntegrityError") {
                    setIntegrityError(true);
                } else if (err.response?.status === 429) {
                    const details = err.response?.data?.error?.details ?? [];
                    const retryDetail = details.find((d) => d.field === "retryAfter");
                    const secs = parseInt(retryDetail?.issue, 10);
                    if (!isNaN(secs)) setRateLimitSeconds(secs);
                } else if (err.response?.status === 423) {
                    setAccountLocked(true);
                }
                toast.error(message);
                return false;
            } finally {
                setLoading(false);
            }
        },
        [navigate],
    );

    /**
     * Log out — calls server to clear HTTP-only cookies, then clears local state.
     * Server failure is non-CRITICAL: local state is cleared regardless.
     */
    const logout = useCallback(async () => {
        try {
            await authApi.logout();
        } catch {
            /* server logout failure is non-critical */
        }

        AuthMiddleware.signout();
        CsrfMiddleware.clearToken();
        toast.success("Signed out");
        navigate("/auth");
    }, [navigate]);

    const clearRateLimit = useCallback(() => {
        setRateLimitSeconds(null);
        setError(null);
    }, []);

    return { loading, error, integrityError, login, logout, rateLimitSeconds, clearRateLimit, accountLocked };
};
