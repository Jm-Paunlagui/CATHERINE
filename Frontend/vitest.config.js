/**
 * vitest.config.js — Frontend test harness configuration.
 *
 * Merges the REAL app vite config (React plugin + babel-plugin-react-compiler
 * pipeline, __APP_VERSION__ define) so tests compile through the exact same
 * transform chain as the production build. The Tailwind plugin is stripped: it
 * only emits CSS (irrelevant under jsdom) and slows collection down with
 * content scanning.
 *
 * `pool: "forks"` + `fileParallelism: false` mirror the backend's discipline —
 * module-scoped singletons (HttpClient, CsrfMiddleware, AuthMiddleware's cache)
 * would otherwise race across workers and produce order-dependent failures.
 */

import { defineConfig, mergeConfig } from "vitest/config";
import viteConfigFactory from "./vite.config.js";

// vite.config.js exports a factory — the production-only VITE_API_BASE_URL
// guard inside it no-ops for mode "test".
const viteConfig = viteConfigFactory({ command: "serve", mode: "test" });

// Strip Tailwind's vite plugin(s) — the CSS pipeline is dead weight under jsdom.
viteConfig.plugins = viteConfig.plugins
    .flat(Infinity)
    .filter(
        (p) =>
            p && !(typeof p.name === "string" && p.name.includes("tailwindcss")),
    );

export default mergeConfig(
    viteConfig,
    defineConfig({
        test: {
            environment: "jsdom",
            globals: true,
            // Tests must never inherit a developer's .env API target — that
            // would point the suite at a REAL backend. Pin the base URL to the
            // MSW-intercepted localhost fallback; keep this in lockstep with
            // test/helpers/msw/server.js.
            env: { VITE_API_BASE_URL: "http://localhost:3000/api/v1/" },
            setupFiles: ["test/helpers/setup.js"],
            pool: "forks",
            fileParallelism: false,
            css: false,
            include: ["test/**/*.test.{js,jsx,mjs}"],
            coverage: {
                provider: "v8",
                reporter: ["text", "html"],
                include: ["src/**/*.{js,jsx}"],
                exclude: ["src/main.jsx", "src/assets/**"],
            },
        },
    }),
);
