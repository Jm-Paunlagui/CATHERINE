/**
 * changePassword.hook.js — Change Password state and handlers.
 *
 * Business logic layer. Imports changePassword.api.js.
 * Views import this hook — never the API file directly.
 *
 * Responsibilities:
 *   - Form state (currentPassword, newPassword, confirmPassword)
 *   - Client-side validation: non-empty, passwords match, new ≠ current
 *   - Calls PATCH auth/change-password
 *   - On success: refreshes stored user, clears auth cache, navigates to /dashboard
 *   - Shake animation trigger (shaking / setShaking)
 */

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "../../components/ui/toast.utils";
import AuthMiddleware from "../../middleware/authentication/AuthMiddleware";
import { changePasswordApi } from "./changePassword.api";

const EMPTY_FORM = {
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
};

/**
 * Core hook for the Change Password feature.
 *
 * @returns {object} All state and handlers consumed by ChangePassword.view.jsx
 */
export const useChangePassword = () => {
    const [form, setForm] = useState(EMPTY_FORM);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [isPasswordValid, setIsPasswordValid] = useState(false);
    const [shaking, setShaking] = useState(false);
    const [isDefaultPassword, setIsDefaultPassword] = useState(false);
    const navigate = useNavigate();

    // Resolve isDefaultPassword from the server-verified user object (H-02).
    // AuthMiddleware.isAuth() is async — never call it synchronously at render.
    useEffect(() => {
        let cancelled = false;
        AuthMiddleware.isAuth().then((user) => {
            if (!cancelled && user) {
                setIsDefaultPassword(user.isDefaultPassword === true);
            }
        });
        return () => { cancelled = true; };
    }, []);

    const handleChange = useCallback((e) => {
        const { name, value } = e.target;
        setForm((prev) => ({ ...prev, [name]: value }));
        setError("");
    }, []);

    /**
     * Validates all fields before submission.
     * Returns an error string when invalid, empty string when valid.
     *
     * @returns {string}
     */
    const validate = useCallback(() => {
        if (!form.currentPassword.trim()) return "Current password is required.";
        if (!form.newPassword.trim()) return "New password is required.";
        if (!form.confirmPassword.trim()) return "Please confirm your new password.";
        if (form.newPassword !== form.confirmPassword) return "Passwords do not match.";
        if (!isPasswordValid) return "Please ensure your new password meets all requirements.";
        if (form.currentPassword === form.newPassword) return "New password must be different from your current password.";

        // Note: server enforces the default-password constraint authoritatively.
        // No client-side check is needed here — it would require exposing the
        // default password in the frontend bundle (CWE-312 / M-16).

        return "";
    }, [form, isPasswordValid]);

    /**
     * Form submission handler.
     * Validates → calls API → updates stored user → navigates to /dashboard.
     */
    const handleSubmit = useCallback(
        async (e) => {
            if (e?.preventDefault) e.preventDefault();

            const validationError = validate();
            if (validationError) {
                setError(validationError);
                setShaking(true);
                return false;
            }

            setLoading(true);
            setError("");
            try {
                const res = await changePasswordApi.changePassword({
                    currentPassword: form.currentPassword,
                    newPassword: form.newPassword,
                });

                const user = res.data?.data?.user;
                if (user) {
                    // Update only the non-PII expiry hint — no user payload in localStorage (CWE-312)
                    const SESSION_TIMEOUT_MS = parseInt(import.meta.env.VITE_SESSION_TIMEOUT_MS ?? String(30 * 60 * 1000), 10);
                    localStorage.setItem("session_exp", String(Date.now() + SESSION_TIMEOUT_MS));
                }

                AuthMiddleware.clearAuthCache();
                toast.success(res.data?.message || "Password changed successfully!");
                const robotRedirect = import.meta.env.VITE_ROBOT_REDIRECT || "/dashboard";
                navigate(user?.role === "ROBOT" ? robotRedirect : "/dashboard");
                return true;
            } catch (err) {
                const message = err.response?.data?.message || err.message || "Failed to change password.";
                setError(message);
                setShaking(true);
                toast.error(message);
                return false;
            } finally {
                setLoading(false);
            }
        },
        [form, validate, navigate],
    );

    return {
        form,
        handleChange,
        loading,
        error,
        setError,
        isPasswordValid,
        setIsPasswordValid,
        shaking,
        setShaking,
        handleSubmit,
        isDefaultPassword,
    };
};
