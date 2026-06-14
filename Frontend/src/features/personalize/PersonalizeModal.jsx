/**
 * PersonalizeModal — Mode, transparency, and 5-colour accent palette.
 *
 * Layout: two-column. Left = appearance settings; right = accent palette.
 * Each palette swatch renders a 5-segment horizontal strip showing all five
 * accent colours that will be applied to the design system.  The Custom swatch
 * opens the native colour picker; the derived 5-colour scheme is shown live.
 */
import { Bars3BottomLeftIcon, ComputerDesktopIcon, MoonIcon, PaintBrushIcon, PlusIcon, SunIcon } from "@heroicons/react/24/outline";
import { CheckIcon } from "@heroicons/react/24/solid";

import { TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";
import { Toggle } from "../../components/forms/Toggle";
import { ColorPicker } from "../../components/ui/ColorPicker";
import { Modal } from "../../components/ui/Modal";
import { usePersonalize } from "./personalize.hook";
import { generateCustomColors, PALETTES } from "./personalize.palettes";

// Quick-pick presets for the custom colour picker — a spread of vivid hues.
const CUSTOM_PRESETS = ["#ff4208", "#4827af", "#18a9e7", "#12caae", "#cec43a", "#e4115a", "#16a34a", "#9333ea", "#f59e0b", "#0ea5e9"];

const CUSTOM_FALLBACK = { primary: "#ff4208", secondary: "#4827af", blue: "#18a9e7", turquoise: "#12caae", yellow: "#cec43a" };

// ── Helpers ───────────────────────────────────────────────────────────────────

const MODE_OPTIONS = [
    { id: "system", label: "System", icon: ComputerDesktopIcon },
    { id: "light", label: "Light", icon: SunIcon },
    { id: "dark", label: "Dark", icon: MoonIcon },
];

const LAYOUT_OPTIONS = [
    { id: "sidebar", label: "Sidebar", icon: Bars3BottomLeftIcon },
    { id: "top", label: "Top Bar", icon: ComputerDesktopIcon },
];

// ── Layout atoms ──────────────────────────────────────────────────────────────

function SectionLabel({ children }) {
    return <p className="text-[11px] font-aumovio-bold uppercase tracking-widest text-grey-400 dark:text-grey-500 mb-3">{children}</p>;
}

function Divider() {
    return <div className="my-5 h-px bg-grey-100 dark:bg-grey-800" />;
}

// ── Mode selector ─────────────────────────────────────────────────────────────

function ModeSelector({ mode, setMode }) {
    return (
        <div className="grid grid-cols-3 gap-2">
            {MODE_OPTIONS.map(({ id, label, icon: Icon }) => {
                const active = mode === id;
                return (
                    <button
                        key={id}
                        type="button"
                        onClick={() => setMode(id)}
                        aria-pressed={active}
                        className={["flex flex-col items-center gap-2 px-3 py-4 rounded-xl border-2 text-sm font-aumovio", TRANSITION_COLORS, active ? "border-(--nav-active-border) bg-(--nav-active-bg) text-(--nav-active-text)" : "border-grey-200 dark:border-grey-700 text-grey-600 dark:text-grey-400 hover:border-(--nav-active-border)/60 hover:text-(--nav-active-text)"].join(" ")}
                    >
                        <Icon className="w-5 h-5 shrink-0" />
                        {label}
                    </button>
                );
            })}
        </div>
    );
}

// ── Layout selector ───────────────────────────────────────────────────────────

function LayoutSelector({ layout, setLayout }) {
    return (
        <div className="grid grid-cols-2 gap-2">
            {LAYOUT_OPTIONS.map(({ id, label, icon: Icon }) => {
                const active = layout === id;
                return (
                    <button
                        key={id}
                        type="button"
                        onClick={() => setLayout(id)}
                        aria-pressed={active}
                        className={["flex flex-col items-center gap-2 px-3 py-4 rounded-xl border-2 text-sm font-aumovio", TRANSITION_COLORS, active ? "border-(--nav-active-border) bg-(--nav-active-bg) text-(--nav-active-text)" : "border-grey-200 dark:border-grey-700 text-grey-600 dark:text-grey-400 hover:border-(--nav-active-border)/60 hover:text-(--nav-active-text)"].join(" ")}
                    >
                        <Icon className="w-5 h-5 shrink-0" />
                        {label}
                    </button>
                );
            })}
        </div>
    );
}

// ── 5-colour strip ────────────────────────────────────────────────────────────

/**
 * ColorStrip — 5-segment swatch showing the palette accent colours.
 * When `isDark` is true and `darkSurface` is provided, a small dark-surface
 * preview bar is rendered along the bottom of the strip so the user can see
 * what the dark mode background will look like before selecting.
 */
function ColorStrip({ colors, active, isDark, children }) {
    const list = [colors.primary, colors.secondary, colors.blue, colors.turquoise, colors.yellow];
    const showDarkPreview = isDark && colors.darkSurface;
    return (
        <div className={["relative w-14 h-9 rounded-lg overflow-hidden flex shadow-md shrink-0 flex-col", active ? "ring-2 ring-offset-1 ring-(--accent) ring-offset-(--bg-surface-2)" : ""].join(" ")}>
            <div className="flex flex-1">
                {list.map((c, i) => (
                    <div key={i} className="flex-1" style={{ background: c }} />
                ))}
            </div>
            {showDarkPreview && <div className="h-2 w-full shrink-0" style={{ background: colors.darkSurface }} title={`Dark surface: ${colors.darkSurface}`} />}
            {children}
        </div>
    );
}

const CHECK_OVERLAY = (
    <div className="absolute inset-0 flex items-center justify-center bg-black/20">
        <div className="w-5 h-5 rounded-full bg-white/90 flex items-center justify-center shadow">
            <CheckIcon className="w-3 h-3 text-black/70" />
        </div>
    </div>
);

// ── Predefined palette swatch ─────────────────────────────────────────────────

function PaletteSwatch({ palette, active, isDark, onSelect }) {
    const { id, name, colors } = palette;
    return (
        <button type="button" onClick={() => onSelect(id)} title={name} aria-label={name} aria-pressed={active} className={["flex flex-col items-center gap-1.5 p-1 rounded-xl", TRANSITION_COLORS].join(" ")}>
            <ColorStrip colors={colors} active={active} isDark={isDark}>
                {active && CHECK_OVERLAY}
            </ColorStrip>
            <span className="text-[9px] font-aumovio text-grey-500 dark:text-grey-400 leading-tight text-center max-w-14 truncate">{name}</span>
        </button>
    );
}

// ── Custom colour swatch ──────────────────────────────────────────────────────

function CustomSwatch({ active, isDark, customColor, onSelect }) {
    const derivedColors = customColor ? generateCustomColors(customColor) : CUSTOM_FALLBACK;

    return (
        <button type="button" onClick={onSelect} aria-label="Custom colour" aria-pressed={active} className={["flex flex-col items-center gap-1.5 p-1 rounded-xl", TRANSITION_COLORS].join(" ")}>
            <ColorStrip colors={derivedColors} active={active} isDark={isDark}>
                {active ? (
                    CHECK_OVERLAY
                ) : (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/25">
                        <div className="w-5 h-5 rounded-full bg-white/80 flex items-center justify-center shadow">
                            <PlusIcon className="w-3 h-3 text-black/60" />
                        </div>
                    </div>
                )}
            </ColorStrip>
            <span className="text-[9px] font-aumovio text-grey-500 dark:text-grey-400 leading-tight text-center">Custom</span>
        </button>
    );
}

// ── Palette grid ──────────────────────────────────────────────────────────────

function PaletteGrid({ activePalette, customColor, isDark, onSelect, onCustomColor }) {
    const predefined = PALETTES.filter((p) => p.id !== "custom" && p.colors !== null);
    const customEntry = PALETTES.find((p) => p.id === "custom");

    return (
        <div className="relative">
            <div className="max-h-64 overflow-y-auto hide-scrollbar -mr-1 pr-1">
                <div className="grid grid-cols-4 gap-x-1 gap-y-2">
                    {predefined.map((palette) => (
                        <PaletteSwatch key={palette.id} palette={palette} active={activePalette === palette.id} isDark={isDark} onSelect={onSelect} />
                    ))}
                    {customEntry && (
                        <CustomSwatch
                            active={activePalette === "custom"}
                            isDark={isDark}
                            customColor={customColor}
                            onSelect={() => {
                                onCustomColor(customColor || "#ff4208");
                                onSelect("custom");
                            }}
                        />
                    )}
                </div>
            </div>
            {/* Scroll-fade mask — tells user there are more palettes below */}
            <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-8 bg-linear-to-t from-(--bg-surface-2) to-transparent" />
        </div>
    );
}

// ── Active palette footer ─────────────────────────────────────────────────────

function ActivePaletteInfo({ activePalette, customColor, isDark }) {
    const entry = PALETTES.find((p) => p.id === activePalette);
    if (!entry) return null;

    const colors = activePalette === "custom" && customColor ? generateCustomColors(customColor) : entry.colors;

    if (!colors) return null;

    const hasDarkColors = isDark && colors.darkSurface && colors.darkText && colors.darkMuted;

    return (
        <div className="flex items-center gap-2 mt-3 px-1 flex-wrap">
            <div className="flex gap-0.5">
                {[colors.primary, colors.secondary, colors.blue, colors.turquoise, colors.yellow].map((c, i) => (
                    <div key={i} className="w-2.5 h-2.5 rounded-full" style={{ background: c }} />
                ))}
                {hasDarkColors && (
                    <>
                        <div className="w-px h-2.5 bg-grey-300 dark:bg-grey-600 mx-0.5 self-center" />
                        <div className="w-2.5 h-2.5 rounded-full ring-1 ring-grey-400/30" style={{ background: colors.darkSurface }} title={`Dark surface: ${colors.darkSurface}`} />
                        <div className="w-2.5 h-2.5 rounded-full ring-1 ring-grey-400/30" style={{ background: colors.darkText }} title={`Dark text: ${colors.darkText}`} />
                        <div className="w-2.5 h-2.5 rounded-full ring-1 ring-grey-400/30" style={{ background: colors.darkMuted }} title={`Dark muted: ${colors.darkMuted}`} />
                    </>
                )}
            </div>
            <span className="text-xs text-grey-500 dark:text-grey-400 font-aumovio">
                {entry.name}
                {activePalette === "custom" && customColor && <span className="ml-1.5 font-mono text-grey-400 dark:text-grey-500">{customColor.toUpperCase()}</span>}
                {hasDarkColors && <span className="ml-1.5 text-grey-400 dark:text-grey-500">· dark palette</span>}
            </span>
        </div>
    );
}

// ── Main modal ────────────────────────────────────────────────────────────────

/**
 * @param {{ open: boolean, onClose: () => void }} props
 */
export default function PersonalizeModal({ open, onClose }) {
    const { mode, setMode, isDark, transparency, setTransparency, palette, setPalette, customColor, setCustomColor, layout, setLayout } = usePersonalize();

    return (
        <Modal open={open} onClose={onClose} size="xl">
            {/* Custom header — negative margins break out of Modal's px-6 py-5 body wrapper */}
            <div className="-mx-6 -mt-5 px-6 py-4 border-b border-grey-200 dark:border-grey-700">
                <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg bg-(--accent-subtle) flex items-center justify-center">
                        <PaintBrushIcon className="w-4 h-4 text-(--nav-active-text)" />
                    </div>
                    <div>
                        <h2 className="text-base font-aumovio-bold text-black/85 dark:text-white/90">Personalize</h2>
                        <p className="text-[11px] text-grey-400 dark:text-grey-500">Appearance &amp; accent colours</p>
                    </div>
                </div>
            </div>

            {/* Two-column body — negative margins escape Modal's padding */}
            <div className="-mx-6 -mb-5 flex overflow-hidden">
                {/* Left column: appearance settings */}
                <div className="flex-1 min-w-0 px-6 py-5">
                    <div>
                        <SectionLabel>Choose your mode</SectionLabel>
                        <ModeSelector mode={mode} setMode={setMode} />
                    </div>

                    <Divider />

                    <div>
                        <SectionLabel>Navigation layout</SectionLabel>
                        <LayoutSelector layout={layout} setLayout={setLayout} />
                    </div>

                    <Divider />

                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-sm font-aumovio text-black/80 dark:text-white/80">Transparency effects</p>
                            <p className="text-xs text-grey-400 dark:text-grey-500 mt-0.5">Blur and frosted glass on surfaces</p>
                        </div>
                        <Toggle checked={transparency} onChange={setTransparency} size="md" color="accent" />
                    </div>
                </div>

                {/* Right column: accent palette */}
                <div className="w-72 shrink-0 px-5 py-5 border-l border-grey-200 dark:border-grey-700 bg-grey-50/50 dark:bg-white/2">
                    <SectionLabel>Accent colour</SectionLabel>
                    <PaletteGrid activePalette={palette} customColor={customColor} isDark={isDark} onSelect={setPalette} onCustomColor={setCustomColor} />
                    <ActivePaletteInfo activePalette={palette} customColor={customColor} isDark={isDark} />

                    {palette === "custom" && (
                        <div className="mt-4 pt-4 border-t border-grey-200 dark:border-grey-700">
                            <ColorPicker value={customColor || "#ff4208"} onChange={setCustomColor} presets={CUSTOM_PRESETS} label="Pick your colour" />
                            <p className="mt-2.5 text-[11px] leading-snug text-grey-400 dark:text-grey-500">The full 5-colour scheme and a matching dark theme are generated automatically from your colour.</p>
                        </div>
                    )}
                </div>
            </div>
        </Modal>
    );
}
