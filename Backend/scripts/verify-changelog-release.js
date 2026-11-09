"use strict";

/**
 * verify-changelog-release.js — checks that the changelog shipped with a release is correct.
 *
 * A GitHub release's "Source code (zip / tar.gz)" assets are built from the tag, so they carry
 * whatever data/changelog.enc the tag points at. This script reads that file straight from git
 * (never the working tree), decrypts it and checks:
 *   1. every prerelease version (-dev.N / -alpha.N / -beta.N / -rc.N) is used by ONE entry only;
 *   2. the newest entry (displayDate, then createdAt — the order the app shows) is the tag's own
 *      version, so the version badge reads the release being shipped;
 *   3. no entry belongs to a later core version than the tag;
 *   4. within each core version, versions only move forward in date order (no -alpha.3 dated
 *      after -beta.1, no -dev.8 dated after the stable release);
 *   5. (warning only) a "release" entry is a stage marker (opened / promoted / released / included).
 *
 * Usage (from Backend/):
 *   node scripts/verify-changelog-release.js                    every release tag (local tags)
 *   node scripts/verify-changelog-release.js v1.0.0             one tag
 *   node scripts/verify-changelog-release.js --ref <sha> --tag v1.0.0   (used by the pre-push hook)
 *   npm run audit:changelog-release [-- <tag>]
 *
 * Key: CHANGELOG_ENCRYPTION_KEY (64 hex) or DATA_SIGNING_SECRET, from the environment or .env
 * (dotenv is optional so CI can run this with no npm install). Nothing is written; no entry text
 * is printed, only versions and titles (the store is public release notes).
 */

const { execFileSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");

try {
    require("dotenv").config({ path: path.resolve(__dirname, "../.env"), quiet: true });
} catch {
    /* CI: key comes from the environment */
}

const TAG_RE = /^v?(\d+\.\d+\.\d+)(-(dev|alpha|beta|rc)\.\d+)?$/;
const STAGE_TITLE_RE = /(opened|why \d|promoted to|released \(stable\)|re-released|included|rollback, clean reinstall)/i;

/** @param {string} v @returns {{core:string, stage:string, n:number}} */
function splitVersion(v) {
    const [core, pre] = String(v).split("-");
    return { core, stage: pre ? pre.split(".")[0] : "stable", n: pre ? Number(pre.split(".")[1]) : 0 };
}

/** @returns {number} <0, 0, >0 for semantic core versions "a.b.c". */
function compareCore(a, b) {
    const x = a.split(".").map(Number);
    const y = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
}

/** Newest first, the order the app's Version History and badge use. */
function newestEntry(entries) {
    return [...entries].sort((a, b) => b.displayDate.localeCompare(a.displayDate) || b.createdAt.localeCompare(a.createdAt))[0];
}

const STAGE_RANK = { dev: 0, alpha: 1, beta: 2, rc: 3, stable: 4 };

/** "prev -> next" pairs where, within one core version in date order, the version goes backwards. A repeated stable version is allowed. */
function versionsOutOfOrder(entries) {
    const groups = {};
    for (const e of entries) (groups[splitVersion(e.version).core] ||= []).push(e);
    const bad = [];
    for (const list of Object.values(groups)) {
        list.sort((a, b) => a.displayDate.localeCompare(b.displayDate) || a.createdAt.localeCompare(b.createdAt));
        for (let i = 1; i < list.length; i++) {
            const a = splitVersion(list[i - 1].version);
            const b = splitVersion(list[i].version);
            const ra = STAGE_RANK[a.stage];
            const rb = STAGE_RANK[b.stage];
            if (rb < ra || (rb === ra && b.stage !== "stable" && b.n <= a.n)) bad.push(`${list[i - 1].version} -> ${list[i].version}`);
        }
    }
    return bad;
}

/**
 * Pure check of a decrypted changelog against the version it ships with.
 * @param {Array<{version:string,title:string,type:string,displayDate:string,createdAt:string}>} entries
 * @param {string} version  e.g. "1.0.0" or "1.1.0-alpha.2"
 * @returns {{ errors: string[], warnings: string[], newest: object|null }}
 */
function checkChangelog(entries, version) {
    const errors = [];
    const warnings = [];
    if (!Array.isArray(entries) || entries.length === 0) return { errors: ["changelog is empty"], warnings, newest: null };

    const counts = {};
    for (const e of entries) if (String(e.version).includes("-")) counts[e.version] = (counts[e.version] || 0) + 1;
    const shared = Object.entries(counts).filter(([, k]) => k > 1);
    if (shared.length) errors.push(`${shared.length} prerelease version(s) shared by more than one entry: ${shared.slice(0, 5).map(([v, k]) => `${v} x${k}`).join(", ")}`);

    const newest = newestEntry(entries);
    if (newest.version !== version) errors.push(`newest entry is ${newest.version} ("${newest.title}"), expected ${version}`);

    const outOfOrder = versionsOutOfOrder(entries);
    if (outOfOrder.length) errors.push(`${outOfOrder.length} entr${outOfOrder.length === 1 ? "y" : "ies"} out of date order (e.g. ${outOfOrder[0]})`);

    const core = splitVersion(version).core;
    const later = entries.filter((e) => compareCore(splitVersion(e.version).core, core) > 0);
    if (later.length) errors.push(`${later.length} entr${later.length === 1 ? "y" : "ies"} newer than ${core} (e.g. ${later[0].version})`);

    const notStage = entries.filter((e) => e.type === "release" && !STAGE_TITLE_RE.test(e.title));
    if (notStage.length) warnings.push(`${notStage.length} "release" entr${notStage.length === 1 ? "y is" : "ies are"} not stage markers (e.g. ${notStage[0].version} "${notStage[0].title}")`);

    return { errors, warnings, newest };
}

function resolveKey() {
    const raw = process.env.CHANGELOG_ENCRYPTION_KEY;
    if (raw && raw.length === 64) return Buffer.from(raw, "hex");
    const fallback = process.env.DATA_SIGNING_SECRET;
    if (fallback && fallback.length >= 32) return crypto.createHash("sha256").update(fallback).digest();
    throw new Error("Set CHANGELOG_ENCRYPTION_KEY (64-char hex) or DATA_SIGNING_SECRET (>= 32 chars).");
}

/** Decrypts data/changelog.enc as stored at a git ref (path relative to Backend/, so it works inside the monorepo). */
function loadAtRef(ref) {
    const raw = execFileSync("git", ["show", `${ref}:./data/changelog.enc`], { encoding: "utf8", maxBuffer: 1e8, cwd: path.resolve(__dirname, "..") });
    const { iv, authTag, ciphertext } = JSON.parse(raw);
    const d = crypto.createDecipheriv("aes-256-gcm", resolveKey(), Buffer.from(iv, "hex"));
    d.setAuthTag(Buffer.from(authTag, "hex"));
    const parsed = JSON.parse(Buffer.concat([d.update(Buffer.from(ciphertext, "hex")), d.final()]).toString("utf8"));
    return Array.isArray(parsed) ? parsed : parsed.entries;
}

function verifyRef(ref, tag) {
    const m = TAG_RE.exec(tag);
    if (!m) return { skipped: true };
    const version = m[1] + (m[2] || "");
    let entries;
    try {
        entries = loadAtRef(ref);
    } catch (e) {
        return { errors: [`cannot read or decrypt data/changelog.enc at ${tag}: ${e.message.split("\n")[0]}`], warnings: [], newest: null };
    }
    return { ...checkChangelog(entries, version), count: entries.length };
}

function main(argv) {
    const args = argv.slice(2);
    const refIdx = args.indexOf("--ref");
    const tagIdx = args.indexOf("--tag");
    let pairs;
    if (refIdx >= 0 && tagIdx >= 0) pairs = [[args[refIdx + 1], args[tagIdx + 1]]];
    else if (args[0] && !args[0].startsWith("--")) pairs = [[`refs/tags/${args[0]}`, args[0]]];
    else pairs = execFileSync("git", ["tag", "-l"], { encoding: "utf8" }).split(/\r?\n/).filter((t) => TAG_RE.test(t)).map((t) => [`refs/tags/${t}`, t]);

    let failed = 0;
    for (const [ref, tag] of pairs) {
        const r = verifyRef(ref, tag);
        if (r.skipped) continue;
        if (r.errors.length) {
            failed++;
            console.log(`FAIL ${tag}\n   - ${r.errors.join("\n   - ")}`);
        } else {
            console.log(`PASS ${tag.padEnd(16)} ${String(r.count).padStart(4)} entries · newest ${r.newest.version} "${r.newest.title}"`);
        }
        for (const w of r.warnings) console.log(`   warn: ${w}`);
    }
    if (failed) console.log(`\n${failed} release changelog(s) FAILED. Fix data/changelog.enc (scripts/seed-changelog.js) before tagging.`);
    return failed ? 1 : 0;
}

module.exports = { checkChangelog, splitVersion, compareCore, newestEntry, TAG_RE };

if (require.main === module) process.exit(main(process.argv));
