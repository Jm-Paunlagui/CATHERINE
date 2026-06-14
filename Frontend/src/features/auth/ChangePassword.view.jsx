/**
 * ChangePassword.view.jsx — Forced / voluntary password change screen.
 *
 * Presentation layer only. Imports useChangePassword hook and Aumovio
 * components. Never imports changePassword.api.js directly.
 *
 * Shown when:
 *   1. user.requiresPasswordChange === true (default password in use)
 *   2. USER navigates manually to /auth/change-password
 *
 * The `isDefaultPassword` flag is read from the stored user object to
 * tailor the subtitle text without any temp_token flow.
 *
 * Design mirrors Login.view.jsx: full-screen background image, blur
 * overlay, centred Card with Logo + Divider + form.
 */

import { LockClosedIcon } from "@heroicons/react/24/outline";
import PasswordChecklist from "react-password-checklist";

import aumovio from "../../assets/img/aumovio.jpeg";
import ErrorBoundary from "../../components/feedback/ErrorBoundary";
import Input from "../../components/forms/Input";
import Alert from "../../components/ui/Alert";
import Button from "../../components/ui/Button";
import Card from "../../components/ui/Card";
import Logo from "../../components/ui/Logo";
import Divider from "../../components/ui/typography/Divider";
import { H4 } from "../../components/ui/typography/Heading";
import Paragraph from "../../components/ui/typography/Paragraph";
import { useChangePassword } from "./changePassword.hook";

/**
 * @returns {JSX.Element}
 */
function ChangePasswordView() {
    const hook = useChangePassword();

    // isDefaultPassword is resolved asynchronously in the hook (H-02).
    // AuthMiddleware.isAuth() is async — never called synchronously at render.
    const isDefaultPassword = hook.isDefaultPassword;

    const canSubmit = hook.isPasswordValid && hook.form.newPassword === hook.form.confirmPassword && hook.form.newPassword.length > 0 && !hook.loading;

    return (
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
                            {/* Change Password Card */}
                            <Card variant="default" padding="none" className={`transition-smooth backface-hidden ${hook.shaking ? "animate-shake ring-2 ring-danger-400" : ""}`} onAnimationEnd={() => hook.setShaking(false)}>
                                <div className="px-6 py-8 lg:px-16">
                                    {/* Card Logo — theme-aware */}
                                    <div className="flex items-center justify-center mb-2 animate-fade-in-up">
                                        <Logo className="w-auto h-16 transition-transform duration-300 hover:scale-110 hover:rotate-6 drop-shadow-lg" />
                                    </div>

                                    <Divider variant="gradient" spacing="sm" />

                                    {/* Title */}
                                    <H4 align="center" className="animate-fade-in-up">
                                        Change Your Password
                                    </H4>

                                    {/* Subtitle */}
                                    <Paragraph size="sm" color="muted" className="mt-2 text-center opacity-80 animate-fade-in-up">
                                        {isDefaultPassword ? "You are using a temporary default password. Please set a secure password to protect your account." : "Please create a new password. It must meet all the requirements shown below."}
                                    </Paragraph>

                                    {/* Form */}
                                    <form className="mt-8 space-y-5 animate-fade-in-up" style={{ animationDelay: "0.2s" }} onSubmit={hook.handleSubmit} noValidate>
                                        <Input label="Current Password" name="currentPassword" type="password" value={hook.form.currentPassword} onChange={hook.handleChange} placeholder={isDefaultPassword ? "Your temporary password" : "Current password"} autoComplete="current-password" leftIcon={LockClosedIcon} />

                                        <Input label="New Password" name="newPassword" type="password" value={hook.form.newPassword} onChange={hook.handleChange} placeholder="Choose a strong password" autoComplete="new-password" leftIcon={LockClosedIcon} />

                                        <Input label="Confirm New Password" name="confirmPassword" type="password" value={hook.form.confirmPassword} onChange={hook.handleChange} placeholder="Repeat new password" autoComplete="new-password" leftIcon={LockClosedIcon} />

                                        {/* Password checklist (shown when user starts typing new password) */}
                                        {hook.form.newPassword.length > 0 && (
                                            <div className="pt-1">
                                                <PasswordChecklist rules={["minLength", "specialChar", "number", "capital", "match"]} minLength={8} value={hook.form.newPassword} valueAgain={hook.form.confirmPassword} onChange={(valid) => hook.setIsPasswordValid(valid)} iconSize={12} className="text-sm text-black/70 dark:text-white/70 font-aumovio space-y-1" />
                                            </div>
                                        )}

                                        {/* Server error */}
                                        {hook.error && (
                                            <Alert variant="danger" size="sm" dismissible>
                                                {hook.error}
                                            </Alert>
                                        )}

                                        {/* Actions */}
                                        <div className="flex flex-col gap-3 pt-2 animate-fade-in-up" style={{ animationDelay: "0.4s" }}>
                                            <Button type="submit" variant="gradient" size="lg" fullWidth loading={hook.loading} disabled={!canSubmit}>
                                                {hook.loading ? "Changing Password…" : "Change Password"}
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
    );
}

export default function ChangePasswordViewWrapped() {
    return (
        <ErrorBoundary>
            <ChangePasswordView />
        </ErrorBoundary>
    );
}
