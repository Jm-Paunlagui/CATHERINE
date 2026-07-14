import { readFileSync } from "node:fs";

import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import babel from "@rolldown/plugin-babel";

// Read the package version once at config-load time so it can be inlined into the
// bundle as __APP_VERSION__ (consumed by src/config/appVersion.js). This keeps
// package.json as the single source of truth for the build's version number,
// while VITE_APP_VERSION (if set) still overrides it at runtime.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url)));

// https://vite.dev/config/
// export default defineConfig({
//   plugins: [
//     react(),
//     babel({ presets: [reactCompilerPreset()] })
//   ],
// })

export default defineConfig({
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
});
