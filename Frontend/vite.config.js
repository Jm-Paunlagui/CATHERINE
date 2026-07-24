import { readFileSync } from "node:fs";
import process from "node:process";

import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import tailwindcss from "@tailwindcss/vite";
import babel from "@rolldown/plugin-babel";

// Read the package version once at config-load time so it can be inlined into the
// bundle as __APP_VERSION__ (consumed by src/config/appVersion.js). This keeps
// package.json as the single source of truth for the build's version number,
// while VITE_APP_VERSION (if set) still overrides it at runtime.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url)));

/**
 * Fails a PRODUCTION build when VITE_API_BASE_URL is unset or insecure.
 *
 * There is no runtime configuration — the value is baked into the bundle at
 * build time, so a bad value cannot be corrected after the fact:
 *
 *   - Unset → src/config/apiBase.js falls back to http://localhost:3000/api/v1/,
 *     which points every API call, the CSRF bootstrap, and all SSE streams at
 *     the CLIENT's own machine. The app appears to load and then fails whole.
 *   - Plain http:// → an HTTPS-served page cannot call an HTTP API at all
 *     (mixed content is blocked by the browser).
 *
 * Both are silent in dev and total in production, which is exactly the class of
 * mistake a build guard exists to catch. Dev and preview are unaffected — the
 * localhost fallback is the point there.
 */
function assertApiBaseUrl(mode) {
    if (mode !== "production") return;

    const { VITE_API_BASE_URL: url } = loadEnv(mode, process.cwd(), "VITE_");

    if (!url) {
        throw new Error(
            "VITE_API_BASE_URL is not set. A production build would fall back to " +
                "http://localhost:3000/api/v1/ and target the client's own machine. " +
                "Set it in Frontend/.env.production, e.g. https://SERVER:3000/api/v1/",
        );
    }
    if (url.startsWith("http://") && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url)) {
        throw new Error(
            `VITE_API_BASE_URL is plain http:// ("${url}"). An HTTPS-served page ` +
                "cannot call an HTTP API — the browser blocks it as mixed content. " +
                "Use https://, or build with --mode development if this is intentional.",
        );
    }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
    assertApiBaseUrl(mode);

    return {
        define: {
            __APP_VERSION__: JSON.stringify(pkg.version),
        },
        plugins: [react(), tailwindcss(), babel({ presets: [reactCompilerPreset()] })],
        server: {
            host: true,
            port: 5174,
        },
        base: "/", // Important for IIS deployment
        build: {
            outDir: "dist",
            assetsDir: "assets",
            // Ensure static files are properly copied
            rollupOptions: {
                input: {
                    main: "index.html",
                },
                output: {
                    manualChunks(id) {
                        const p = id.replace(/\\/g, "/");
                        if (!p.includes("/node_modules/")) return;

                        if (p.includes("/node_modules/react-router")) {
                            return "vendor-router";
                        }
                        if (p.includes("/node_modules/react/") || p.includes("/node_modules/react-dom/") || p.includes("/node_modules/scheduler")) {
                            return "vendor-react";
                        }
                        if (p.includes("/node_modules/react-toastify") || p.includes("/node_modules/@headlessui") || p.includes("/node_modules/@heroicons") || p.includes("/node_modules/@fortawesome")) {
                            return "vendor-ui";
                        }
                        // jsPDF is only reached via a dynamic import() (src/utils/qrStubPdf.js,
                        // the EmailFailureModal PDF-export fallback) and — together with its
                        // jspdf-exclusive transitive deps (fflate, fast-png, canvg) — adds
                        // ~640 kB raw / ~150 kB gzip. Giving the group its own chunk keeps it
                        // out of the catch-all "vendor" bucket below, which IS reached eagerly
                        // from the entry — merging jsPDF into it would force every user to
                        // download it on first load for a feature almost nobody hits.
                        // NOTE: deliberately NOT bucketing "@babel/runtime" here even though
                        // jspdf/canvg depend on it — the React Compiler babel preset injects
                        // @babel/runtime helper imports into virtually every compiled app
                        // chunk (main, vendor-react, feature views, …), so grouping it with
                        // jsPDF would drag this whole chunk back into the eager load path.
                        if (p.includes("/node_modules/jspdf") || p.includes("/node_modules/fflate") || p.includes("/node_modules/fast-png") || p.includes("/node_modules/canvg")) {
                            return "vendor-jspdf";
                        }
                        return "vendor";
                    },
                },
            },
            chunkSizeWarningLimit: 1500,
            // Copy additional files if needed
            copyPublicDir: true,
        },
        // Ensure static files from public directory are copied
        publicDir: "public",
    };
});
