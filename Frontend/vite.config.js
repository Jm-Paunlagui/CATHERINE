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
        port: 5173,
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
                    if (id.includes("node_modules")) {
                        if (id.includes("react") || id.includes("react-dom")) {
                            return "vendor-react";
                        }
                        if (id.includes("react-router-dom")) {
                            return "vendor-router";
                        }
                        if (id.includes("react-toastify") || id.includes("@headlessui") || id.includes("@heroicons") || id.includes("@fortawesome")) {
                            return "vendor-ui";
                        }
                        return "vendor";
                    }
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
