import { ComputerDesktopIcon, MoonIcon, SunIcon } from "@heroicons/react/24/outline";
import { TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";
import { useTheme } from "../../contexts/theme/useTheme";

const ICONS = {
    system: ComputerDesktopIcon,
    light: SunIcon,
    dark: MoonIcon,
};

const LABELS = {
    system: "System theme",
    light: "Light theme",
    dark: "Dark theme",
};

// Cycle-button looks. `default` = standalone; `nav` / `chrome` mirror the Personalize button beside them
// in Navbar / SidebarHeader (chrome = the gradient desktop sidebar header).
const CYCLE_TONES = {
    default: "border-transparent text-grey-500 dark:text-grey-400 hover:text-(--accent-foreground) hover:bg-orange-400/10 hover:border-orange-400/20",
    nav: "border-transparent text-grey-500 dark:text-grey-400 hover:text-(--nav-active-text) hover:bg-(--nav-hover-bg) hover:border-(--accent)/20",
    chrome: "max-lg:border-transparent max-lg:text-grey-500 dark:max-lg:text-grey-400 max-lg:hover:text-(--text-accent) max-lg:hover:bg-(--nav-hover-bg) max-lg:hover:border-(--accent)/20 lg:text-(--chrome-to-text) lg:bg-(--chrome-to-glass-bg) lg:border-(--chrome-to-glass-border) lg:hover:bg-(--chrome-to-hover-bg) lg:hover:text-(--chrome-to-hover-text)",
};

/**
 * Theme switcher. Both variants carry `data-lock-exempt`: they stay usable while the server lock
 * (ServerLockGuard) makes every other control inert, because changing the theme is local-only.
 *
 * @param {{ size?: "sm"|"md", variant?: "cycle"|"segmented", tone?: "default"|"nav"|"chrome" }} props
 *        `tone` only affects the cycle variant.
 */
export function ThemeToggle({ size = "md", variant = "cycle", tone = "default" }) {
    const { mode, setMode, toggle } = useTheme();
    const sz = size === "sm" ? "w-4 h-4" : "w-5 h-5";

    // Simple cycle button (default)
    if (variant === "cycle") {
        const Icon = ICONS[mode];
        return (
            <button data-lock-exempt onClick={toggle} aria-label={LABELS[mode]} title={LABELS[mode]} className={`p-2 border rounded-lg ${CYCLE_TONES[tone] ?? CYCLE_TONES.default} ${TRANSITION_COLORS}`}>
                <Icon className={sz} />
            </button>
        );
    }

    // Segmented 3-button variant
    return (
        <div data-lock-exempt className="inline-flex items-center gap-1 p-1 rounded-xl bg-grey-100 dark:bg-(--bg-surface-3) border border-grey-200 dark:border-grey-700">
            {["system", "light", "dark"].map((m) => {
                const Icon = ICONS[m];
                const active = mode === m;
                return (
                    <button key={m} onClick={() => setMode(m)} aria-label={LABELS[m]} title={LABELS[m]} className={`p-2 rounded-lg ${TRANSITION_COLORS} ${active ? "bg-(--bg-surface) dark:bg-(--bg-surface-2) text-(--accent-foreground) shadow-sm" : "text-grey-500 dark:text-grey-400 hover:text-(--accent-foreground)"}`}>
                        <Icon className={sz} />
                    </button>
                );
            })}
        </div>
    );
}
