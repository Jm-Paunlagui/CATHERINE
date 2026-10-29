/**
 * playwright.config.js — Minimal Playwright harness for the checks JSDOM cannot
 * cover: rendered colour contrast (button / focus-ring specs) and real-browser
 * navigation flows (smart-home spec). Single chromium project.
 *
 * reducedMotion is left at the BROWSER DEFAULT (not forced to `reduce`).
 *
 * webServer runs `npm run dev` on :5173 with reuseExistingServer:true, so it
 * ATTACHES to an already-running dev server if you have one, and only spawns a
 * fresh one otherwise. Every spec mocks the API, so no backend is needed.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: "./e2e",
    // One motion sample plus a settle check — keep the per-test budget generous
    // enough for a cold dev-server first paint, but not so long a genuine hang
    // wastes minutes.
    timeout: 30_000,
    expect: { timeout: 10_000 },
    fullyParallel: false,
    reporter: [["list"]],
    use: {
        baseURL: "http://localhost:5173",
        trace: "on-first-retry",
        // Intentionally NOT set to "reduce" — we want to observe the wave move.
    },
    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
        },
    ],
    webServer: {
        command: "npm run dev",
        url: "http://localhost:5173",
        reuseExistingServer: true,
        timeout: 60_000,
    },
});
