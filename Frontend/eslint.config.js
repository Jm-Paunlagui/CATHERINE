import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import { defineConfig, globalIgnores } from "eslint/config";
import localPlugin from "./eslint-rules/jsx-uses-vars.js";

export default defineConfig([
    // `coverage/` is Istanbul's generated HTML report — third-party vendored JS
    // (block-navigation.js, prettify.js, sorter.js) that we neither wrote nor
    // maintain. Linting it reported an "unused eslint-disable directive" in
    // someone else's file, which is unfixable by definition.
    globalIgnores(["dist", "coverage"]),
    {
        files: ["**/*.{js,jsx}"],
        extends: [js.configs.recommended, reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
        plugins: { local: localPlugin },
        languageOptions: {
            ecmaVersion: 2020,
            globals: {
                ...globals.browser,
                // Injected at build time by Vite (see vite.config.js `define`).
                __APP_VERSION__: "readonly",
            },
            parserOptions: {
                ecmaVersion: "latest",
                ecmaFeatures: { jsx: true },
                sourceType: "module",
            },
        },
        rules: {
            // ignoreRestSiblings: the `const { drop, ...keep } = obj` omit-idiom is
            // the intended way to strip keys before an API call. Without this, every
            // omitted key is reported as an unused variable and the only
            // alternatives are noise — a disable comment or renaming real schema
            // fields. Scoped to rest-destructuring only; ordinary unused vars
            // still error.
            //
            // argsIgnorePattern: an underscore-prefixed parameter (`_label`,
            // `_isDark`) is the conventional signal for "part of the required
            // signature but intentionally unused" — e.g. a placeholder callback
            // that must accept the arg to sit at the right position but ignores
            // it. Mirrors the same underscore-throwaway intent as varsIgnorePattern
            // above; a positional param cannot be dropped like an unused var can.
            "no-unused-vars": ["error", { varsIgnorePattern: "^[A-Z_]", argsIgnorePattern: "^_", ignoreRestSiblings: true }],
            // Local reimplementation of eslint-plugin-react's `react/jsx-uses-vars`
            // — see eslint-rules/jsx-uses-vars.js for the full rationale. Teaches
            // core no-unused-vars that a JSX tag-position read (`<Icon />`) counts
            // as a use of the binding — without it, a destructured-and-renamed
            // callback param (`({ icon: Icon }) => <Icon />`) falsely reports Icon
            // as unused. See CLAUDE.md "13. Linting & Tooling" for the full story.
            "local/jsx-uses-vars": "error",
        },
    },

    // ── Build tooling — runs in Node, not the browser ────────────────────────
    // These files are executed by Vite/ESLint under Node and legitimately read
    // `process.env` (vite.config.js's VITE_API_BASE_URL production guard reads
    // it as the fallback when loadEnv finds nothing). The base block above only
    // declares browser globals, so `process` read as an undefined global and
    // the config that guards the production build was itself lint-failing.
    {
        files: ["vite.config.js", "vitest.config.js", "eslint.config.js", "eslint-rules/**/*.js"],
        languageOptions: { globals: { ...globals.node } },
    },

    // ── Test suite — jsdom (browser globals) running inside Node ─────────────
    // Vitest exposes both: the DOM comes from jsdom while the file itself runs
    // under Node, so `process`/`globalThis`/Buffer are all legitimately in
    // scope. Declaring this here replaces the per-file `/* eslint-env */`
    // comments, which flat config no longer honours (ESLint warns today and
    // will error in v10).
    //
    // NOT declared here: vitest's own `describe`/`it`/`expect`/`vi`. Even
    // though vitest.config.js sets `globals: true`, every test file in this
    // suite imports them explicitly from "vitest" — keeping them undeclared
    // means a missing import is caught by lint instead of surviving to a
    // confusing runtime failure.
    {
        files: ["test/**/*.{js,jsx}"],
        languageOptions: { globals: { ...globals.browser, ...globals.node } },
    },

    // ── Playwright harness pages — `createRoot(...).render(...)` entry points ──
    // Each fixture is a standalone page Playwright loads, like main.jsx: it
    // defines its components and mounts them, exporting nothing. Fast Refresh
    // boundaries do not apply to an entry module, so only-export-components
    // reports a non-problem on every harness component.
    {
        files: ["e2e/fixtures/**/*.jsx"],
        rules: { "react-refresh/only-export-components": "off" },
    },
]);
