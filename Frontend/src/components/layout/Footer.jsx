/**
 * footers/index.jsx
 * ─────────────────
 * Simple, reusable footer.
 * Replace the copy / links with your project's needs.
 */

import { BASE_COLOR_TEXT } from "../../assets/styles/pre-set-styles";
import Logo from "../ui/Logo";

export function Footer() {
    const year = new Date().getFullYear();

    return (
        <footer className="w-full border-t border-grey-200 dark:border-(--color-dark-muted)/20 bg-(--bg-surface)/80 backdrop-blur-sm font-aumovio">
            <div className="max-w-7xl mx-auto px-4 py-6 flex flex-col md:flex-row items-center justify-between gap-4">
                {/* Brand */}
                <div className="flex items-center gap-2">
                    <Logo className="h-6 w-auto" />
                </div>

                {/* Copyright */}
                <p className={`text-xs ${BASE_COLOR_TEXT}`}>© {year} Aumovio. All rights reserved.</p>

                {/* Optional links */}
                <div className="flex gap-4">
                    {[
                        { label: "Privacy", href: "/privacy" },
                        { label: "Terms", href: "/terms" },
                    ].map((l) => (
                        <a key={l.label} href={l.href} className="text-xs text-grey-500 dark:text-grey-400 hover:text-orange-400 transition-colors duration-200">
                            {l.label}
                        </a>
                    ))}
                </div>
            </div>
        </footer>
    );
}

export default Footer;
