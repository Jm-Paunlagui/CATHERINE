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
 *   - Unset → src/config/apiBase.js falls back to http://localhost:2108/api/v1/,
 *     which points every API call, the CSRF bootstrap, and all SSE streams at
 *     the CLIENT's own machine. The app appears to load and then fails whole.
 *   - Plain http:// → an HTTPS-served page cannot call an HTTP API at all
 *     (mixed content is blocked by the browser). VITE_ALLOW_INSECURE_API=true
 *     is an explicit escape hatch for deliberate plain-HTTP test builds.
 *
 * Both are silent in dev and total in production, which is exactly the class of
 * mistake a build guard exists to catch. Dev and preview are unaffected — the
 * localhost fallback is the point there.
 */
function assertApiBaseUrl(mode) {
    if (mode !== "production") return;

    const env = loadEnv(mode, process.cwd(), "");
    const url = env.VITE_API_BASE_URL || process.env.VITE_API_BASE_URL || "";
    const allowInsecure = (env.VITE_ALLOW_INSECURE_API || process.env.VITE_ALLOW_INSECURE_API) === "true";

    if (!url) {
        throw new Error(
            "VITE_API_BASE_URL is not set. A production build would fall back to " +
                "http://localhost:2108/api/v1/ and target the client's own machine. " +
                "Set it in Frontend/.env.production, e.g. https://SERVER:2108/api/v1/",
        );
    }
    if (/^http:\/\//i.test(url) && !allowInsecure && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url)) {
        throw new Error(
            `VITE_API_BASE_URL is plain http:// ("${url}"). An HTTPS-served page ` +
                "cannot call an HTTP API — the browser blocks it as mixed content. " +
                "Use https://, or set VITE_ALLOW_INSECURE_API=true to opt into a plain-HTTP test build.",
        );
    }
}

/**
 * Substitutes the API origin into `dist/Web.config`'s Content-Security-Policy.
 *
 * IIS is the ONLY layer that can set headers on the SPA's own HTML response —
 * the API lives on a different port and can never reach that document. So the
 * CSP has to live in Web.config, and its `connect-src` has to name the API
 * origin (XHR + fetch + every EventSource stream target it, and a different
 * PORT is a different ORIGIN).
 *
 * Deriving it from VITE_API_BASE_URL rather than hand-writing a hostname means
 * the CSP cannot drift from the origin the app actually calls — one source of
 * truth for both.
 *
 * Fails the build if the placeholder survives: a CSP whose `connect-src` still
 * reads `__CSP_CONNECT_SRC__` blocks every API call, the CSRF bootstrap and all
 * SSE streams — the same silent-brick failure the VITE_API_BASE_URL guard above
 * exists to prevent.
 *
 * @param {string} apiOrigin e.g. "https://SERVER:2108"
 */
const cspWebConfigPlugin = (apiOrigin) => ({
    name: "csp-web-config",
    // `writeBundle` runs after copyPublicDir has emitted Web.config.
    async writeBundle(options) {
        const { readFile, writeFile } = await import("node:fs/promises");
        const path = await import("node:path");
        const outDir = options.dir ?? "dist";
        const target = path.join(outDir, "Web.config");

        let xml;
        try {
            xml = await readFile(target, "utf8");
        } catch {
            throw new Error(
                `csp-web-config: ${target} not found after build. public/Web.config is the ` +
                    "source of the IIS config (SPA fallback, MIME maps, security headers); " +
                    "without it the deployed app has no CSP, no HSTS and no SPA rewrite.",
            );
        }

        if (!xml.includes("__CSP_CONNECT_SRC__")) {
            throw new Error(
                "csp-web-config: placeholder __CSP_CONNECT_SRC__ not found in Web.config. " +
                    "Either the CSP header was removed, or it was hand-edited to a literal " +
                    "origin — which reintroduces the drift this plugin exists to prevent. " +
                    "Restore the placeholder in public/Web.config.",
            );
        }

        await writeFile(target, xml.replaceAll("__CSP_CONNECT_SRC__", apiOrigin), "utf8");
    },
});

/**
 * Removes the one `Function(...)` call in exceljs's browser bundle.
 *
 * `exceljs`'s `browser` entry is a pre-browserified bundle whose vendored copy
 * of `regenerator-runtime` ends:
 *
 *     try { regeneratorRuntime = n } catch (e) { Function("r", "regeneratorRuntime = r")(n) }
 *
 * The `try` branch is an implicit-global assignment. Vite converts the CJS
 * bundle to ESM, ESM is always strict, and an implicit global assignment in
 * strict mode is a ReferenceError — so the `catch` ALWAYS runs, and the
 * Function constructor is ALWAYS invoked. Under the Web.config CSP (`script-src
 * 'self'`, no 'unsafe-eval') the browser throws an EvalError at module init,
 * surfacing as a client-side render error on the first lazy route that pulls in
 * the export utilities.
 *
 * `globalThis.regeneratorRuntime = n` is what the eval'd string does, minus the
 * eval — so the fix is a rewrite, not a behaviour change. Adding 'unsafe-eval'
 * would re-open string-to-code execution for the WHOLE app to accommodate one
 * vendored polyfill.
 *
 * Two-layer guard, because a dep can reach the output without passing through
 * `transform` (dep pre-bundling): the transform rewrites it, and
 * `generateBundle` re-scans every emitted chunk and fails the build if the
 * pattern survived anywhere.
 */
const exceljsNoEvalPlugin = () => {
    const EVAL_CALL = /Function\(\s*(["'`])r\1\s*,\s*(["'`])regeneratorRuntime\s*=\s*r\2\s*\)\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
    let patched = 0;

    return {
        name: "exceljs-no-eval",
        enforce: "pre",
        transform(code, id) {
            if (!/node_modules[\\/]exceljs[\\/]/.test(id)) return null;
            if (!EVAL_CALL.test(code)) return null;
            EVAL_CALL.lastIndex = 0;
            patched += 1;
            return { code: code.replace(EVAL_CALL, "globalThis.regeneratorRuntime = $3"), map: null };
        },
        generateBundle(_options, bundle) {
            const leaked = Object.values(bundle)
                .filter((c) => c.type === "chunk" && /Function\(\s*(["'`])r\1\s*,/.test(c.code))
                .map((c) => c.fileName);

            if (leaked.length > 0) {
                throw new Error(
                    `exceljs-no-eval: the regenerator-runtime Function() call survived into ${leaked.join(", ")}. ` +
                        "It would throw EvalError at module init under the Web.config CSP (script-src 'self'). " +
                        "The minified pattern in exceljs has probably changed — update EVAL_CALL in vite.config.js. " +
                        "Do NOT 'fix' this by adding 'unsafe-eval' to the CSP.",
                );
            }
            if (patched === 0) {
                this.warn("exceljs-no-eval: no exceljs module was transformed — verify exceljs is still bundled and the pattern still matches.");
            }
        },
    };
};

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
    assertApiBaseUrl(mode);

    // Only meaningful for a production build — dev never serves Web.config.
    let apiOrigin = null;
    if (command === "build" && mode === "production") {
        const env = loadEnv(mode, process.cwd(), "");
        const apiBase = env.VITE_API_BASE_URL || process.env.VITE_API_BASE_URL || "";
        try {
            apiOrigin = new URL(apiBase).origin;
        } catch {
            throw new Error(
                `VITE_API_BASE_URL="${apiBase}" is not a parseable absolute URL, so the CSP's ` +
                    "connect-src origin cannot be derived. Use a full origin, e.g. " +
                    "https://<SERVER>:2108/api/v1/",
            );
        }
    }

    return {
        define: {
            __APP_VERSION__: JSON.stringify(pkg.version),
        },
        plugins: [
            react(),
            tailwindcss(),
            babel({ presets: [reactCompilerPreset()] }),
            exceljsNoEvalPlugin(),
            ...(apiOrigin ? [cspWebConfigPlugin(apiOrigin)] : []),
        ],
        // Loopback only: `host: true` exposed /__open-in-editor (launch-editor)
        // to the LAN. Use `npm run dev -- --host` to test from another device.
        server: {
            host: "localhost",
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
                    // rolldown-native codeSplitting groups (the successor of the
                    // deprecated `advancedChunks`, same group semantics), NOT rollup's
                    // manualChunks: manualChunks is never consulted for `\0` virtual
                    // modules, so vite's preload helper landed in an arbitrary group
                    // and pinned that whole group into the eager modulepreload set.
                    // codeSplitting groups match the raw module id (virtual ids included).
                    //
                    // Verify after ANY change here:
                    //   grep modulepreload dist/index.html
                    // vendor-excel / vendor-zip / vendor-mermaid* / vendor-markdown must NOT appear.
                    //   grep -E 'from"\./vendor-mermaid' dist/assets/vendor-*.js
                    // must find nothing (a static import pulls the chunk even without a preload).
                    codeSplitting: {
                        groups: [
                            // Must be FIRST — most specific wins.
                            { name: "vendor-preload", test: /vite[\\/]preload-helper/ },
                            { name: "vendor-router", test: /node_modules[\\/]react-router/ },
                            { name: "vendor-react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
                            { name: "vendor-ui", test: /node_modules[\\/](react-toastify|@headlessui|@heroicons|@fortawesome)/ },
                            // Heaviest libs, reachable only from lazily-loaded feature views.
                            { name: "vendor-excel", test: /node_modules[\\/]exceljs/ },
                            { name: "vendor-charts", test: /node_modules[\\/](react-)?apexcharts/ },
                            { name: "vendor-zip", test: /node_modules[\\/]jszip/ },
                            // Dev-docs viewer stack — MUST precede the catch-all `vendor`
                            // rule or mermaid rides into the eager bundle. @mermaid-js/parser
                            // gets its own group: shared with eager code, it otherwise pins
                            // all of vendor-mermaid (~4.7 MB) into every first load.
                            { name: "vendor-mermaid-parser", test: /node_modules\/@mermaid-js\// },
                            { name: "vendor-mermaid", test: /node_modules\/(mermaid|dagre-d3-es|khroma|cytoscape[a-z-]*|@braintree|roughjs|points-on-[a-z]+|path-data-parser)\// },
                            // Bare `d3` / `d3-*` deliberately NOT above: apexcharts imports
                            // d3 eagerly, so capturing it would make vendor-mermaid eager.
                            { name: "vendor-markdown", test: /node_modules\/(react-markdown|remark-[a-z-]+|rehype-[a-z-]+|mdast-[a-z-]+|micromark[a-z-]*|unified|unist-[a-z-]+|hast-[a-z-]+|vfile[a-z-]*|lowlight|highlight\.js|devlop|bail|trough|zwitch|comma-separated-tokens|space-separated-tokens|property-information|html-void-elements|character-entities[a-z-]*|decode-named-character-reference|ccount|markdown-table|longest-streak|stringify-entities|trim-lines|html-url-attributes|estree-[a-z-]+|style-to-[a-z-]+|parse-entities|is-plain-obj)\// },
                            { name: "vendor", test: /node_modules/ },
                        ],
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
