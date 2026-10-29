#!/usr/bin/env node
/**
 * postbuild-copy-natives.js
 *
 * Auto-discovers and copies native .node addons that `pkg` cannot embed
 * into the snapshot to the dist/ folder so the compiled exe finds them
 * at runtime.
 *
 * How it works:
 *   1. Scans each package directory listed in NATIVE_PACKAGES for any
 *      file matching *.node (the compiled C++ addon binary).
 *   2. Filters to the current platform (win32-x64) so only relevant
 *      binaries are copied — not linux/darwin/arm variants.
 *   3. Preserves the relative path under node_modules/ so the Node.js
 *      addon resolution algorithm finds them next to the exe.
 *
 * Adding a new native package:
 *   Just append its name to NATIVE_PACKAGES — no paths or versions needed.
 *
 * FAIL-LOUD CONTRACT: a NATIVE_PACKAGES entry that stages ZERO binaries
 * fails the build (exit 1). A missing native addon is a boot crash in the
 * compiled exe — eager require("oracledb") throws → exit 1 → WinSW
 * restart-loops the service every 10 s — so it must never be a warning.
 *
 * Run automatically after `npm run build` / `npm run build:debug`.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const NODE_MODULES = path.join(ROOT, "node_modules");

/**
 * Packages that ship native .node addons.
 * The script will auto-discover the correct binary for the current platform.
 */
const NATIVE_PACKAGES = ["oracledb", "argon2"];

/**
 * Only copy binaries whose path contains one of these platform tokens.
 * This avoids copying darwin/linux/arm binaries that are irrelevant to
 * the Windows x64 pkg target.
 *
 * Matching is strict: "win32-x64" won't accidentally match "darwin-x64"
 * because we check for the full token bounded by path separators.
 */
const PLATFORM_FILTERS = [
    /[/\\]win32-x64[/\\]/,
    /[/\\]win-x64[/\\]/,
    /win32-x64\.node$/,
];

/**
 * Recursively find all files matching a pattern under a directory.
 */
function findFiles(dir, pattern, results = []) {
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            findFiles(full, pattern, results);
        } else if (pattern.test(entry.name)) {
            results.push(full);
        }
    }
    return results;
}

// ── Main ──────────────────────────────────────────────────────────────────

let copied = 0;
const failures = [];

for (const pkg of NATIVE_PACKAGES) {
    const pkgDir = path.join(NODE_MODULES, pkg);
    if (!fs.existsSync(pkgDir)) {
        failures.push(`${pkg}: package not installed under node_modules/`);
        continue;
    }

    const allNodes = findFiles(pkgDir, /\.node$/);

    // Filter to current platform only
    const platformNodes = allNodes.filter((f) =>
        PLATFORM_FILTERS.some((pattern) => pattern.test(f)),
    );

    if (platformNodes.length === 0) {
        failures.push(
            `${pkg}: no win32-x64 .node binary matched. ` +
                (allNodes.length
                    ? `Discovered (non-matching): ${allNodes
                          .map((f) => path.relative(NODE_MODULES, f))
                          .join(", ")} — extend PLATFORM_FILTERS if one of ` +
                      "these is the right binary."
                    : "No .node files found at all under the package."),
        );
        continue;
    }

    for (const srcPath of platformNodes) {
        // Preserve the path relative to node_modules/
        const relPath = path.relative(NODE_MODULES, srcPath);
        const destPath = path.join(DIST, "node_modules", relPath);

        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(srcPath, destPath);
        if (!fs.existsSync(destPath)) {
            failures.push(`${pkg}: copy verification failed for ${relPath}`);
            continue;
        }
        console.log(`  ✔  node_modules/${relPath.replace(/\\/g, "/")}`);
        copied++;
    }
}

if (failures.length > 0) {
    console.error("\nPostbuild FAILED — native addon(s) not staged:");
    for (const failure of failures) console.error(`  ✖  ${failure}`);
    console.error(
        "\nThe compiled exe would crash at boot (or at first use of the " +
            "affected module). Fix the install / platform filter and re-run " +
            "the build. Do NOT deploy this dist folder.",
    );
    process.exit(1);
}

console.log(`\nPostbuild: ${copied} native addon(s) copied to dist/.`);
