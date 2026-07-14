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
let skipped = 0;

for (const pkg of NATIVE_PACKAGES) {
    const pkgDir = path.join(NODE_MODULES, pkg);
    if (!fs.existsSync(pkgDir)) {
        console.warn(`  ⚠  Package not installed, skipping: ${pkg}`);
        skipped++;
        continue;
    }

    const allNodes = findFiles(pkgDir, /\.node$/);

    // Filter to current platform only
    const platformNodes = allNodes.filter((f) =>
        PLATFORM_FILTERS.some((pattern) => pattern.test(f)),
    );

    if (platformNodes.length === 0) {
        console.warn(`  ⚠  No win32-x64 .node binaries found in: ${pkg}`);
        skipped++;
        continue;
    }

    for (const srcPath of platformNodes) {
        // Preserve the path relative to node_modules/
        const relPath = path.relative(NODE_MODULES, srcPath);
        const destPath = path.join(DIST, "node_modules", relPath);

        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(srcPath, destPath);
        console.log(`  ✔  node_modules/${relPath.replace(/\\/g, "/")}`);
        copied++;
    }
}

console.log(
    `\nPostbuild: ${copied} native addon(s) copied to dist/, ${skipped} skipped.`,
);
