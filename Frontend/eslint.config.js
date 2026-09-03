import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import { defineConfig, globalIgnores } from "eslint/config";
import localPlugin from "./eslint-rules/jsx-uses-vars.js";

export default defineConfig([
    // `coverage/` is Istanbul's generated HTML report — third-party vendored JS
    // that we neither wrote nor maintain. Linting it reports unfixable problems.
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
            // ignoreRestSiblings: the `const { drop, ...keep } = obj` omit-idiom
            // is the intended way to strip keys before an API call. Scoped to
            // rest-destructuring only; ordinary unused vars still error.
            "no-unused-vars": ["error", { varsIgnorePattern: "^[A-Z_]", ignoreRestSiblings: true }],
            // Local reimplementation of react/jsx-uses-vars — see
            // eslint-rules/jsx-uses-vars.js. Teaches core no-unused-vars that a
            // JSX tag-position read (`<Icon />`) counts as a use of the binding,
            // so `({ icon: Icon }) => <Icon />` is not a false positive.
            "local/jsx-uses-vars": "error",
        },
    },

    // ── Build tooling — runs in Node, not the browser ────────────────────────
    {
        files: ["vite.config.js", "vitest.config.js", "eslint.config.js", "eslint-rules/**/*.js"],
        languageOptions: { globals: { ...globals.node } },
    },

    // ── Test suite — jsdom (browser globals) running inside Node ─────────────
    {
        files: ["test/**/*.{js,jsx}"],
        languageOptions: { globals: { ...globals.browser, ...globals.node } },
    },
]);
