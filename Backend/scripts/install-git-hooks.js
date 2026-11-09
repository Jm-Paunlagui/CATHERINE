"use strict";

/**
 * install-git-hooks.js — points git at the versioned hooks in Backend/.githooks/ (run by `npm install`
 * through the "prepare" script). The path is set relative to the repository root, so it works when
 * Backend/ is a folder of a monorepo. Silent no-op outside a git checkout (e.g. a packaged build).
 */
const { execFileSync } = require("child_process");
const path = require("path");

try {
    const root = path.resolve(__dirname, "..");
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, stdio: "ignore" });
    const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], { cwd: root, encoding: "utf8" }).trim();
    execFileSync("git", ["config", "core.hooksPath", `${prefix}.githooks`], { cwd: root, stdio: "ignore" });
} catch {
    /* not a git checkout, or git missing: nothing to install */
}
