import { ComputerDesktopIcon, MoonIcon, SunIcon } from "@heroicons/react/24/outline";
import { TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";
import { useTheme } from "../../contexts/theme/ThemeContext";

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

export function ThemeToggle({ size = "md", variant = "cycle" }) {
    const { mode, setMode, toggle } = useTheme();
    const sz = size === "sm" ? "w-4 h-4" : "w-5 h-5";

    // Simple cycle button (default)
    if (variant === "cycle") {
        const Icon = ICONS[mode];
        return (
            <button onClick={toggle} aria-label={LABELS[mode]} title={LABELS[mode]} className={`p-2 border border-transparent rounded-lg text-grey-500 dark:text-grey-400 hover:text-(--accent-foreground) hover:bg-orange-400/10 hover:border-orange-400/20 ${TRANSITION_COLORS}`}>
                <Icon className={sz} />
            </button>
        );
    }

    // Segmented 3-button variant
    return (
        <div className="inline-flex items-center gap-0.5 p-1 rounded-xl bg-grey-100 dark:bg-(--bg-surface-3) border border-grey-200 dark:border-grey-700">
            {["system", "light", "dark"].map((m) => {
                const Icon = ICONS[m];
                const active = mode === m;
                return (
                    <button key={m} onClick={() => setMode(m)} aria-label={LABELS[m]} title={LABELS[m]} className={`p-1.5 rounded-lg ${TRANSITION_COLORS} ${active ? "bg-(--bg-surface) dark:bg-(--bg-surface-2) text-(--accent-foreground) shadow-sm" : "text-grey-500 dark:text-grey-400 hover:text-(--accent-foreground)"}`}>
                        <Icon className={sz} />
                    </button>
                );
            })}
        </div>
    );
}
