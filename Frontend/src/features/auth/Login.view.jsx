/**
 * Login.view.jsx — Login page.
 *
 * Presentation layer only. All logic lives in auth.hook.js.
 * Uses the Aumovio design-system components throughout.
 */

import { LockClosedIcon, UserIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ErrorBoundary } from "../../components/feedback/ErrorBoundary";

import aumovio from "../../assets/img/aumovio.jpeg";
import Input from "../../components/forms/Input";
import Alert from "../../components/ui/Alert";
import Button from "../../components/ui/Button";
import Card from "../../components/ui/Card";
import Logo from "../../components/ui/Logo";
import Divider from "../../components/ui/typography/Divider";
import { H4 } from "../../components/ui/typography/Heading";
import Paragraph from "../../components/ui/typography/Paragraph";
import Text from "../../components/ui/typography/Text";
import { useAuth } from "./auth.hook";

const APP_NAME = import.meta.env.VITE_APP_NAME || "App";

function formatCountdown(secs) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    if (m === 0) return `${s}s`;
    return `${m}m ${s.toString().padStart(2, "0")}s`;
}

export default function LoginView() {
    const { loading, error, integrityError, login, rateLimitSeconds, clearRateLimit, accountLocked } = useAuth();
    const navigate = useNavigate();
    const [form, setForm] = useState({ username: "", password: "" });
    const [errorEffect, setErrorEffect] = useState(false);
    const [localError, setLocalError] = useState("");
    const [countdown, setCountdown] = useState(0);
    const intervalRef = useRef(null);

    useEffect(() => {
        if (!rateLimitSeconds) {
            setCountdown(0);
            return;
        }
        setCountdown(rateLimitSeconds);
        intervalRef.current = setInterval(() => {
            setCountdown((prev) => {
                if (prev <= 1) {
                    clearInterval(intervalRef.current);
                    clearRateLimit();
                    return 0;
                }
                return prev - 1;
            });
        }, 1000);
        return () => clearInterval(intervalRef.current);
    }, [rateLimitSeconds, clearRateLimit]);

    const handleChange = (e) => {
        setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
        setErrorEffect(false);
        setLocalError("");
    };

    const handleSubmit = async (e) => {
        e.preventDefault();

        if (loading || countdown > 0) return;

        if (!form.username.trim()) {
            setLocalError("Username is required");
            setErrorEffect(true);
            return;
        }
        if (!form.password.trim()) {
            setLocalError("Password is required");
            setErrorEffect(true);
            return;
        }

        const ok = await login(form);
        if (!ok) setErrorEffect(true);
    };

    const displayError = localError || error;

    return (
        <ErrorBoundary>
        <div className="fixed flex items-center w-full h-full min-h-screen font-aumovio">
            {/* Background image */}
            <div className="absolute inset-0 -z-10">
                <img alt="" className="object-cover w-full h-full" src={aumovio} />
            </div>

            {/* Top-left logo — always on dark background image */}
            <div className="absolute z-50 top-2 left-2">
                <Logo variant="white" className="w-auto h-16 md:h-20 lg:h-24" />
            </div>

            {/* Blur overlay */}
            <div className="absolute inset-0 z-0">
                <div className="w-full h-full transition-colors duration-500 bg-white/20 dark:bg-black/90 backdrop-blur-3xl" />
            </div>

            {/* Page content */}
            <div className="relative z-10 w-full">
                <div className="container h-full mx-auto">
                    <div className="flex items-center justify-center h-full min-h-screen py-8">
                        <div className="w-11/12 md:w-7/12 lg:w-6/12 xl:w-5/12">
                            {/* Login Card */}
                            <Card variant="default" padding="none" className={`transition-smooth backface-hidden ${errorEffect ? "animate-shake ring-2 ring-danger-400" : ""}`} onAnimationEnd={() => setErrorEffect(false)}>
                                <div className="px-6 py-8 lg:px-16">
                                    {/* Card Logo — theme-aware */}
                                    <div className="flex items-center justify-center mb-2 animate-fade-in-up">
                                        <Logo className="w-auto h-16 transition-transform duration-300 hover:scale-110 hover:rotate-6 drop-shadow-lg" />
                                    </div>

                                    <Divider variant="gradient" spacing="sm" />

                                    {/* Title */}
                                    <H4 align="center" className="animate-fade-in-up">
                                        Sign in to {APP_NAME}
                                    </H4>

                                    {/* Subtitle */}
                                    <Paragraph size="sm" color="muted" className="mt-2 text-center opacity-80 animate-fade-in-up">
                                        Welcome back! Please sign in to your account
                                    </Paragraph>

                                    {/* Form */}
                                    <form className="mt-8 space-y-5 animate-fade-in-up" style={{ animationDelay: "0.2s" }} onSubmit={handleSubmit}>
                                        <Input label="Username" name="username" type="text" placeholder="Username or USER ID" value={form.username} onChange={handleChange} autoComplete="username" leftIcon={UserIcon} error={errorEffect && localError === "Username is required" ? localError : undefined} />

                                        <Input label="Password" name="password" type="password" placeholder="Password" value={form.password} onChange={handleChange} autoComplete="current-password" leftIcon={LockClosedIcon} error={errorEffect && localError === "Password is required" ? localError : undefined} />

                                        {/* Rate-limit lockout alert */}
                                        {countdown > 0 && (
                                            <Alert variant="warning" title="Too many sign-in attempts" size="sm">
                                                Please wait {formatCountdown(countdown)} before trying again.
                                            </Alert>
                                        )}

                                        {/* Permanent lockout alert (HR-reset required) */}
                                        {accountLocked && (
                                            <Alert variant="danger" title="Account Permanently Locked" size="sm">
                                                Your account has been locked after too many failed sign-in attempts. Please contact HR to reset your password.
                                            </Alert>
                                        )}

                                        {/* Account integrity error (tampered/corrupted record) */}
                                        {integrityError && displayError && countdown === 0 && (
                                            <Alert variant="warning" title="Account Issue Detected" size="sm" dismissible>
                                                {displayError}
                                            </Alert>
                                        )}

                                        {/* Server error (non-rate-limit, non-integrity) */}
                                        {!integrityError && !accountLocked && displayError && localError !== displayError && countdown === 0 && (
                                            <Alert variant="danger" size="sm" dismissible>
                                                {displayError}
                                            </Alert>
                                        )}

                                        {/* Actions */}
                                        <div className="flex flex-col gap-3 pt-2 animate-fade-in-up" style={{ animationDelay: "0.4s" }}>
                                            <Text variant="italic" align="center">
                                                Use your HRIS or eFeedback credentials to log in.
                                            </Text>
                                            <Button type="submit" variant="gradient" size="lg" fullWidth loading={loading} disabled={loading || countdown > 0 || accountLocked}>
                                                {loading ? "Signing In…" : countdown > 0 ? `Locked out — ${formatCountdown(countdown)}` : accountLocked ? "Account Locked" : "Sign In"}
                                            </Button>
                                        </div>
                                    </form>
                                </div>
                            </Card>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        </ErrorBoundary>
    );
}
