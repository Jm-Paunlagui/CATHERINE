/**
 * auth.hook.js — Authentication state and handlers.
 *
 * Business logic layer. Uses auth.api.js for HTTP calls.
 * Views import this hook — never auth.api.js directly.
 */

import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { extractApiError, toast } from "../../components/ui/toast.utils";
import AuthMiddleware from "../../middleware/authentication/AuthMiddleware";
import CsrfMiddleware from "../../middleware/security/CsrfMiddleware";
import { parseRetryAfterSeconds } from "../../utils/retryAfter";
import { authApi } from "./auth.api";
import { getLandingPath } from "./roleRedirect";

const SESSION_TIMEOUT_MS = parseInt(import.meta.env.VITE_SESSION_TIMEOUT_MS ?? String(30 * 60 * 1000), 10);

export const useAuth = () => {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [integrityError, setIntegrityError] = useState(false);
    const [rateLimitSeconds, setRateLimitSeconds] = useState(null);
    const [accountLocked, setAccountLocked] = useState(false);
    const navigate = useNavigate();

    // Synchronous re-entrancy guard: the `loading` React state
    // is only reflected in the DOM/next render after React commits
    // setLoading(true) — a second click/submit dispatched before that commit
    // lands still reads a stale `loading === false` closure and proceeds. A
    // ref is mutated synchronously and immediately visible to any call that
    // happens within the same pre-commit window, so it closes that race.
    // Unlocked again only on a FAILED attempt (so the user can retry) — a
    // successful attempt leaves it locked, because `login()`'s own network
    // round-trip can resolve fast enough (a near-zero-latency backend) to
    // finish and unlock before a second, already-queued click's submit
    // event even reaches this handler; unconditionally clearing it in a
    // `finally` would reopen that exact window. `loading` state is kept
    // as-is for the UI (spinner/disabled prop).
    const submitInFlightRef = useRef(false);

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
        async (credentials, redirectPath = null) => {
            if (submitInFlightRef.current) return false;
            submitInFlightRef.current = true;
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
                AuthMiddleware.authenticate(user ? { firstName: user.firstName, lastName: user.lastName, userId: user.userId } : null);

                // Redirect to change-password flow when the account is using
                // the system default password or when the server explicitly
                // requires a password change on this session.
                if (user?.requiresPasswordChange) {
                    toast.info("Please change your password before continuing.");
                    navigate("/auth/change-password");
                } else {
                    // Explicit redirectPath (deep link) wins; otherwise land on the
                    // role's home page from the ROLE_LANDING_PATHS map.
                    navigate(redirectPath || getLandingPath(user?.role));
                }
                toast.success(response.data?.message || "Welcome!");
                return true;
            } catch (err) {
                const message = err.response?.data?.message || err.message || "We couldn't sign you in. Please try again.";
                const errorType = err.response?.data?.error?.type;
                setError(extractApiError(err, message));
                if (err.response?.status === 422 && errorType === "DataIntegrityError") {
                    setIntegrityError(true);
                } else if (err.response?.status === 429) {
                    const details = err.response?.data?.error?.details ?? [];
                    const retryDetail = details.find((d) => d.field === "retryAfter");
                    // Body detail first; the Retry-After header (now CORS-exposed) is the fallback.
                    const secs = retryDetail ? parseInt(retryDetail.issue, 10) : Math.ceil(parseRetryAfterSeconds(err.response?.headers?.["retry-after"]) ?? NaN);
                    if (!isNaN(secs)) setRateLimitSeconds(secs);
                } else if (err.response?.status === 423) {
                    setAccountLocked(true);
                }
                // Only unlock the guard on FAILURE, so the user can retry.
                // On success we deliberately leave it locked: the call above
                // already triggered navigate() away from this view, and a
                // second in-flight click (queued moments earlier, landing on
                // an about-to-unmount instance) must not fire a second
                // request — the response for THIS click alone can resolve
                // fast enough that a `finally`-unconditional reset would
                // already have cleared the guard before a queued sibling
                // click's own submit event even reaches this handler.
                submitInFlightRef.current = false;
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
