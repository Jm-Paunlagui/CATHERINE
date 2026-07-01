/**
 * useSessionWarning — Proactive session-expiry modal controller.
 *
 * Reads `session_exp` (a non-PII numeric ms timestamp) from localStorage and
 * schedules a warning modal `WARNING_SECS` before the session expires.
 *
 * Config (Vite env vars):
 *   VITE_SESSION_TIMEOUT_MS   — total session lifetime in ms  (default: 30 min)
 *   VITE_SESSION_WARNING_SECS — modal countdown in seconds    (default: 30 s)
 *
 * Flow:
 *   1. On mount, read session_exp and schedule the warning timer.
 *   2. When the timer fires, show the modal and start the countdown.
 *   3a. USER clicks "Extend Session" → POST auth/refresh → update
 *       session_exp → reschedule timer → close modal.
 *   3b. Countdown hits 0 → signout → navigate to /login-timeout.
 *   3c. USER clicks "Sign Out" → same as 3b.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { authApi } from "../features/auth/auth.api";
import AuthMiddleware from "../middleware/authentication/AuthMiddleware";
import CsrfMiddleware from "../middleware/security/CsrfMiddleware";

const SESSION_TIMEOUT_MS = parseInt(import.meta.env.VITE_SESSION_TIMEOUT_MS ?? String(30 * 60 * 1000), 10);
const WARNING_SECS = parseInt(import.meta.env.VITE_SESSION_WARNING_SECS ?? "30", 10);

export function useSessionWarning() {
    const navigate = useNavigate();
    const [visible, setVisible] = useState(false);
    const [countdown, setCountdown] = useState(WARNING_SECS);
    const [extending, setExtending] = useState(false);

    const warningTimerRef = useRef(null);
    const countdownTimerRef = useRef(null);

    // ── helpers ────────────────────────────────────────────────────────────────

    const clearTimers = useCallback(() => {
        clearTimeout(warningTimerRef.current);
        clearInterval(countdownTimerRef.current);
    }, []);

    const expireSession = useCallback(() => {
        clearTimers();
        setVisible(false);
        AuthMiddleware.signout();
        CsrfMiddleware.clearToken();
        navigate("/login-timeout", { replace: true });
    }, [clearTimers, navigate]);

    // ── show modal + start countdown ───────────────────────────────────────────

    const showWarning = useCallback(() => {
        setVisible(true);
        setCountdown(WARNING_SECS);

        countdownTimerRef.current = setInterval(() => {
            setCountdown((prev) => {
                if (prev <= 1) {
                    clearInterval(countdownTimerRef.current);
                    expireSession();
                    return 0;
                }
                return prev - 1;
            });
        }, 1000);
    }, [expireSession]);

    // ── (re-)schedule the warning timer based on stored expiry ─────────────────

    const schedule = useCallback(() => {
        clearTimers();
        setVisible(false);

        // Read the numeric ms expiry timestamp stored as a non-PII string (CWE-312).
        // The full user payload is never written to localStorage.
        const raw = localStorage.getItem("session_exp");
        if (!raw) return;
        const sessionExpiresAt = parseInt(raw, 10);
        if (!Number.isFinite(sessionExpiresAt)) return;

        const now = Date.now();
        const delay = sessionExpiresAt - now - WARNING_SECS * 1000;

        // Guard against NaN / negative values.
        // NaN causes setTimeout to fire immediately, popping the modal on login.
        if (!Number.isFinite(delay)) return;

        // Session already expired — clean up the stale hint silently instead of
        // popping the warning modal on a public page where the user isn't even
        // logged in. The next login will write a fresh session_exp.
        if (sessionExpiresAt <= now) {
            localStorage.removeItem("session_exp");
            return;
        }

        warningTimerRef.current = setTimeout(showWarning, Math.max(0, delay));
    }, [clearTimers, showWarning]);

    // ── extend session ─────────────────────────────────────────────────────────

    const extendSession = useCallback(async () => {
        setExtending(true);
        try {
            await authApi.refresh();
            // Update only the non-PII expiry hint — no user payload in localStorage (CWE-312).
            localStorage.setItem("session_exp", String(Date.now() + SESSION_TIMEOUT_MS));
            schedule();
        } catch {
            expireSession();
        } finally {
            setExtending(false);
        }
    }, [schedule, expireSession]);

    // ── mount / unmount ────────────────────────────────────────────────────────

    useEffect(() => {
        // Check for the non-PII session expiry hint (CWE-312 — no user object in storage).
        const raw = localStorage.getItem("session_exp");
        if (!raw) return;

        schedule();
        return clearTimers;
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    return {
        visible,
        countdown,
        extending,
        extendSession,
        signOut: expireSession,
    };
}
