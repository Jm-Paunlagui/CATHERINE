#!/usr/bin/env bun
/**
 * build.js — compiles the backend into one Bun executable and stages what it reads from disk.
 *
 *   bun run build              → dist/catherine-backend.exe   (Windows x64, the production target)
 *   bun run build:host         → dist/catherine-backend for THIS machine — run it to smoke-test
 *                                a build locally (the Windows exe cannot run on macOS/Linux)
 *
 * The source map is always embedded (--sourcemap=inline): without it every stack trace and
 * log call-site reads "root/catherine-backend:<line>" instead of "src/...:<line>". It carries
 * the source text, the same exposure as the old pkg build's --public --no-bytecode.
 *
 * Steps:
 *   1. scripts/build-devdocs-freshness.js writes src/generated/devDocsFreshness.json.
 *   2. `bun build --compile --sourcemap=inline` bundles server.js + node_modules into the executable.
 *   3. Stages, beside the exe, every file the server reads through APP_ROOT
 *      (src/utils/runtimePaths.ts): email templates and the freshness snapshot.
 *      `bun build --compile` bakes the BUILD machine's absolute __dirname into the binary,
 *      so nothing may be read relative to __dirname at runtime.
 *   4. Stages the native addons for the target platform:
 *        oracledb → dist/node_modules/oracledb/build/Release/  (passed as initOracleClient binaryDir)
 *        argon2   → dist/prebuilds/<platform-arch>/            (node-gyp-build's exe-relative lookup)
 *
 * Deployed separately, beside the exe (see deploy/DEPLOYMENT_RUNBOOK.md): .env, dev-docs/,
 * data/, certs/. logs/ is created at runtime.
 *
 * FAIL-LOUD CONTRACT: a native addon or asset that stages nothing fails the build (exit 1).
 * A missing native addon is a boot crash in the exe — WinSW then restart-loops the service.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const NODE_MODULES = path.join(ROOT, "node_modules");
const PKG = require(path.join(ROOT, "package.json"));

/** Bun compile target → Node-style platform-arch token used by the native packages' file layout. */
const TARGETS = {
    "bun-windows-x64": { platform: "win32", arch: "x64" },
    "bun-linux-x64": { platform: "linux", arch: "x64" },
    "bun-linux-arm64": { platform: "linux", arch: "arm64" },
    "bun-darwin-x64": { platform: "darwin", arch: "x64" },
    "bun-darwin-arm64": { platform: "darwin", arch: "arm64" },
};

/** Directories (relative to Backend/) the server reads through appPath(); copied as-is. */
const ASSET_DIRS = ["src/utils/email-templates", "src/generated"];

function parseArgs(argv) {
    const args = { target: "bun-windows-x64" };
    for (const a of argv) {
        if (a.startsWith("--target=")) args.target = a.slice("--target=".length);
        else throw new Error(`Unknown argument: ${a}`);
    }
    return args;
}

function run(cmd, cmdArgs) {
    const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: "inherit" });
    if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(" ")} exited with ${r.status}`);
}

function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    let count = 0;
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) count += copyDir(s, d);
        else {
            fs.copyFileSync(s, d);
            count++;
        }
    }
    return count;
}

function stageNatives({ platform, arch }, failures) {
    const staged = [];

    // oracledb: build/Release/oracledb-<ver>-<platform>-<arch>.node
    const oraRelease = path.join(NODE_MODULES, "oracledb", "build", "Release");
    const oraBins = fs.existsSync(oraRelease)
        ? fs.readdirSync(oraRelease).filter((f) => f.endsWith(`-${platform}-${arch}.node`))
        : [];
    if (oraBins.length === 0) failures.push(`oracledb: no ${platform}-${arch} .node under node_modules/oracledb/build/Release`);
    for (const f of oraBins) {
        const dest = path.join(DIST, "node_modules", "oracledb", "build", "Release", f);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(oraRelease, f), dest);
        staged.push(path.relative(DIST, dest));
    }

    // argon2: prebuilds/<platform>-<arch>/*.node → dist/prebuilds/<platform>-<arch>/
    const a2Dir = path.join(NODE_MODULES, "argon2", "prebuilds", `${platform}-${arch}`);
    const a2Bins = fs.existsSync(a2Dir) ? fs.readdirSync(a2Dir).filter((f) => f.endsWith(".node")) : [];
    if (a2Bins.length === 0) failures.push(`argon2: no .node under node_modules/argon2/prebuilds/${platform}-${arch}`);
    for (const f of a2Bins) {
        const dest = path.join(DIST, "prebuilds", `${platform}-${arch}`, f);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(a2Dir, f), dest);
        staged.push(path.relative(DIST, dest));
    }
    return staged;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const host = args.target === "host";
    const target = host ? null : TARGETS[args.target];
    if (!host && !target) throw new Error(`Unsupported --target=${args.target}. Use host or one of: ${Object.keys(TARGETS).join(", ")}`);
    const plat = host ? { platform: process.platform, arch: process.arch } : target;
    const exeName = PKG.name + (plat.platform === "win32" ? ".exe" : "");

    run(process.execPath, ["scripts/build-devdocs-freshness.js"]);

    fs.rmSync(DIST, { recursive: true, force: true });
    fs.mkdirSync(DIST, { recursive: true });

    const compileArgs = ["build", "--compile", "--sourcemap=inline", "server.js", "--outfile", path.join("dist", exeName)];
    if (!host) compileArgs.push(`--target=${args.target}`);
    run(process.execPath, compileArgs);
    // The map is already embedded (inline); Bun still writes a copy beside the exe. Don't ship it twice.
    fs.rmSync(path.join(DIST, `${exeName}.map`), { force: true });

    const failures = [];
    for (const rel of ASSET_DIRS) {
        const src = path.join(ROOT, rel);
        if (!fs.existsSync(src)) {
            failures.push(`asset folder missing: ${rel}`);
            continue;
        }
        const n = copyDir(src, path.join(DIST, rel));
        if (n === 0) failures.push(`asset folder empty: ${rel}`);
        else console.log(`  ✔  ${rel}/ (${n} file(s))`);
    }

    for (const f of stageNatives(plat, failures)) console.log(`  ✔  ${f.replace(/\\/g, "/")}`);

    if (failures.length > 0) {
        console.error("\nBuild FAILED — runtime file(s) not staged:");
        for (const f of failures) console.error(`  ✖  ${f}`);
        console.error("\nThe exe would crash at boot or at first use. Do NOT deploy this dist folder.");
        process.exit(1);
    }
    console.log(`\nBuild OK: dist/${exeName} (${plat.platform}-${plat.arch}).`);
}

main();
