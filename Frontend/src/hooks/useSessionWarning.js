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

    // Guards against the expiry path running more than once. React 19 StrictMode
    // double-invokes state updaters and effects; a background tab may also fire
    // several throttled ticks in a burst. Without this latch, signout/navigate
    // would run twice, racing the modal's own unmount and leaving it frozen
    // on screen (CWE-362 — race condition).
    const expiredRef = useRef(false);

    const expireSession = useCallback(() => {
        if (expiredRef.current) return;
        expiredRef.current = true;

        clearTimers();
        setVisible(false);
        AuthMiddleware.signout();
        CsrfMiddleware.clearToken();

        // Primary path: SPA navigation. In a backgrounded / throttled tab,
        // react-router's navigate() can be deferred and occasionally no-ops,
        // leaving the modal stuck. Schedule a hard-navigation fallback that
        // mirrors the proven HttpClient 440 path so the user is ALWAYS moved
        // off the app shell. If SPA nav already unmounted us, the location has
        // changed and the fallback is a harmless same-target replace.
        navigate("/login-timeout", { replace: true });

        if (typeof window !== "undefined" && window.location) {
            const target = "/login-timeout";
            setTimeout(() => {
                if (window.location.pathname !== target) {
                    window.location.replace(target);
                }
            }, 0);
        }
    }, [clearTimers, navigate]);

    // ── show modal + start countdown ───────────────────────────────────────────

    const showWarning = useCallback(() => {
        setVisible(true);
        setCountdown(WARNING_SECS);

        countdownTimerRef.current = setInterval(() => {
            // Drive the countdown off an ABSOLUTE wall-clock deadline rather
            // than counting ticks. Background tabs throttle setInterval (ticks
            // may be dropped or coalesced), so tick-counting drifts and can
            // stall before reaching zero — the exact "modal never redirects"
            // symptom. Wall-clock math is immune to throttling.
            const raw = localStorage.getItem("session_exp");
            const expiresAt = raw ? parseInt(raw, 10) : NaN;
            const remaining = Number.isFinite(expiresAt) ? Math.ceil((expiresAt - Date.now()) / 1000) : 0;

            if (remaining <= 0) {
                clearInterval(countdownTimerRef.current);
                setCountdown(0);
                expireSession();
                return;
            }
            setCountdown(remaining);
        }, 1000);
    }, [expireSession]);

    // ── (re-)schedule the warning timer based on stored expiry ─────────────────

    const schedule = useCallback(() => {
        clearTimers();
        setVisible(false);
        // A fresh (or extended) session is being scheduled — re-arm the expiry
        // latch so a later genuine expiry can fire exactly once.
        expiredRef.current = false;

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
        // popping the warning modal on a public page.
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
        if (raw) schedule();

        // Cross-tab synchronisation. The user commonly keeps several tabs open.
        // Without this, each tab runs an isolated timer: extending in one tab
        // leaves the others counting down on a stale deadline, and an expiry in
        // one tab leaves the others frozen on "Session Expiring Soon".
        //
        // The `storage` event fires in EVERY OTHER tab of the same origin when
        // localStorage changes (never in the tab that made the change).
        //   • session_exp cleared/removed  → that session ended → expire here too.
        //   • session_exp rewritten         → extended elsewhere → reschedule here.
        const onStorage = (event) => {
            if (event.key !== "session_exp") return;
            if (event.newValue === null) {
                expireSession();
            } else {
                schedule();
            }
        };
        window.addEventListener("storage", onStorage);

        return () => {
            clearTimers();
            window.removeEventListener("storage", onStorage);
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    return {
        visible,
        countdown,
        extending,
        extendSession,
        signOut: expireSession,
    };
}
