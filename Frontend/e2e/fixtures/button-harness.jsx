/**
 * button-harness.jsx — TEST-ONLY mount point for e2e/button-contrast.spec.js.
 *
 * ?mode=button&v=<variant>
 *   Mounts the REAL src/components/ui/Button.jsx inside the real ThemeProvider
 *   and a real <Card>: one enabled instance per size (xs..xl), plus a disabled
 *   and a loading instance at md. Every instance is wrapped so 24px of bare
 *   Card surface surrounds it (the spec samples the surface 6px outside).
 *
 * ?mode=tiles
 *   Mounts the shared icon-tile variants:
 *     - "header": a page-header tile (ICON_TILE + ICON_TILE_NEUTRAL) on the page surface.
 *     - one chip per METRIC_COLOR key (below — the same accent / semantic tint
 *       families the Dashboard cards use), wrapped in ICON_TILE and placed on
 *       a card surface (CARD_CHROME).
 *
 * Nothing here is routed or imported by the production app.
 */
import { faChartLine, faCoins, faPlus } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "../../src/assets/styles/index.css";
import { ICON_TILE, ICON_TILE_NEUTRAL } from "../../src/assets/styles/pre-set-styles";
import { ThemeProvider } from "../../src/contexts/theme/ThemeContext";
import Button from "../../src/components/ui/Button";
import Card from "../../src/components/ui/Card";

const SIZES = ["xs", "sm", "md", "lg", "xl"];

const HEADER_TILE = `${ICON_TILE} ${ICON_TILE_NEUTRAL}`;
const HEADER_ICON = "text-(--accent-icon)";
const METRIC_TILE_SHELL = ICON_TILE;
const CARD_CHROME = "rounded-xl p-4 bg-(--bg-surface) dark:bg-(--bg-surface-2) border border-(--color-card-surface-border) dark:border-white/10 shadow-sm";

// Palette-adaptive families use the contrast-safe --*-foreground icon tokens; semantic ones stay fixed.
const METRIC_COLOR = {
    accent: { badge: "bg-orange-400/10 dark:bg-orange-400/15", icon: "text-(--accent-icon)" },
    purple: { badge: "bg-purple-400/10 dark:bg-purple-400/15", icon: "text-(--secondary-foreground)" },
    blue: { badge: "bg-blue-400/10 dark:bg-blue-400/15", icon: "text-(--blue-foreground)" },
    success: { badge: "bg-success-400/10 dark:bg-success-400/15", icon: "text-success-400" },
    danger: { badge: "bg-danger-400/10 dark:bg-danger-400/15", icon: "text-danger-400" },
    warn: { badge: "bg-warn-400/10 dark:bg-warn-400/15", icon: "text-warn-400" },
};

const cell = { padding: 24, display: "inline-flex" };

function ButtonHarness({ variant }) {
    return (
        <Card variant="default" padding="lg">
            <div data-testid="mount" style={{ display: "flex", flexWrap: "wrap", alignItems: "center" }}>
                {SIZES.map((s) => (
                    <div key={s} style={cell}>
                        <Button variant={variant} size={s} data-testid={`btn-${s}`}>
                            <FontAwesomeIcon icon={faPlus} className="text-[10px]" />
                            Save Changes
                        </Button>
                    </div>
                ))}
                <div style={cell}>
                    <Button variant={variant} size="md" disabled data-testid="btn-disabled">
                        <FontAwesomeIcon icon={faPlus} className="text-[10px]" />
                        Save Changes
                    </Button>
                </div>
                <div style={cell}>
                    <Button variant={variant} size="md" loading data-testid="btn-loading">
                        Save Changes
                    </Button>
                </div>
            </div>
        </Card>
    );
}

function TilesHarness() {
    return (
        <div data-testid="mount">
            <div style={cell}>
                <div className={HEADER_TILE} data-testid="tile-header">
                    <FontAwesomeIcon icon={faChartLine} className={HEADER_ICON} />
                </div>
            </div>
            <div className={CARD_CHROME} style={{ display: "flex", flexWrap: "wrap" }}>
                {Object.entries(METRIC_COLOR).map(([key, c]) => (
                    <div key={key} style={cell}>
                        <div className={`${METRIC_TILE_SHELL} ${c.badge}`} data-testid={`tile-${key}`}>
                            <FontAwesomeIcon icon={faCoins} className={`text-sm ${c.icon}`} />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

const q = new URLSearchParams(window.location.search);
const mode = q.get("mode") ?? "button";

createRoot(document.getElementById("root")).render(
    <StrictMode>
        <ThemeProvider>
            <div style={{ minHeight: "100vh", padding: 48, background: "var(--bg-surface)" }}>
                <div style={{ maxWidth: 900 }}>{mode === "tiles" ? <TilesHarness /> : <ButtonHarness variant={q.get("v") ?? "primary"} />}</div>
            </div>
        </ThemeProvider>
    </StrictMode>,
);
