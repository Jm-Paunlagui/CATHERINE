"use strict";

/**
 * ReleaseService
 *
 * Derives the release-train state for the changelog and the DRAFT entries that
 * each stage transition would produce. ONE target version is "in flight" at a
 * time and advances through the stage ladder:
 *
 *     dev → alpha → beta → rc → stable
 *
 * This service is READ-ONLY — it never writes. Under the single-write-path model
 * every changelog entry (content builds AND stage markers) is created through
 * the normal `POST /api/v1/changelog` flow after the admin reviews a pre-filled
 * form. ReleaseService supplies that pre-fill: `getState()` returns the current
 * target plus a `drafts` object the UI seeds the form with.
 *
 *   stable / empty → drafts.open  (patch | minor | major → next "-dev.1" cycle)
 *   dev|alpha|beta → drafts.promote (advance one stage) + drafts.content
 *   rc             → drafts.cut (→ stable)              + drafts.content
 *
 * `drafts.content` is the next in-cycle build (another iteration of the current
 * stage) used by the plain "New Entry" action; it is null on a stable/empty
 * store, where a new cycle must be opened first.
 */

const ChangelogModel = require("../models/changelog.model");

// ── Stage ladder ──────────────────────────────────────────────────────────────

const STAGE_LADDER = ["dev", "alpha", "beta", "rc", "stable"];
const STAGE_ORDER = { dev: 0, alpha: 1, beta: 2, rc: 3, stable: 4 };
const STAGE_LABEL = {
    dev: "Developer Preview",
    alpha: "Alpha",
    beta: "Beta",
    rc: "Release Candidate",
    stable: "Stable",
};

// ── Pure SemVer helpers ───────────────────────────────────────────────────────

/**
 * Parses a version string into its numeric core plus release-stage tag.
 * A plain version with no pre-release tag is treated as "stable", iter 0.
 *
 * @param {string} v
 * @returns {{ major: number, minor: number, patch: number, stage: string, iter: number }}
 */
function parseVersion(v) {
    const [core, pre] = String(v ?? "0.0.0").split("-");
    const [major = 0, minor = 0, patch = 0] = core.split(".").map(Number);
    let stage = "stable";
    let iter = 0;
    if (pre) {
        const m = pre.toLowerCase().match(/^(dev|alpha|beta|rc)\.(\d+)/);
        if (m) {
            stage = m[1];
            iter = Number(m[2]);
        }
    }
    return { major, minor, patch, stage, iter };
}

/**
 * SemVer 2.0.0 precedence comparison. Core compared numerically; for an equal
 * core a pre-release sorts BELOW the bare release (dev<alpha<beta<rc<stable),
 * then by iteration.
 *
 * @param {object} a parsed version
 * @param {object} b parsed version
 * @returns {number} <0 if a<b, 0 if equal, >0 if a>b
 */
function compareVersion(a, b) {
    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    if (a.patch !== b.patch) return a.patch - b.patch;
    const as = STAGE_ORDER[a.stage] ?? 0;
    const bs = STAGE_ORDER[b.stage] ?? 0;
    if (as !== bs) return as - bs;
    return a.iter - b.iter;
}

/** @param {object} p parsed version @returns {string} "MAJOR.MINOR.PATCH" */
function coreStr(p) {
    return `${p.major}.${p.minor}.${p.patch}`;
}

/**
 * Bumps a core by the given SemVer level.
 * @param {object} p parsed version
 * @param {"patch"|"minor"|"major"} bump
 * @returns {{ major: number, minor: number, patch: number }}
 */
function bumpCore(p, bump) {
    if (bump === "major") return { major: p.major + 1, minor: 0, patch: 0 };
    if (bump === "minor") return { major: p.major, minor: p.minor + 1, patch: 0 };
    return { major: p.major, minor: p.minor, patch: p.patch + 1 };
}

/** @param {object} p parsed version @returns {string} composed version string */
function composeVersion(p) {
    return p.stage === "stable" ? coreStr(p) : `${coreStr(p)}-${p.stage}.${p.iter}`;
}

/**
 * Shapes a draft changelog entry for the create form to seed.
 * @param {string} version
 * @param {string} stage informational (the form derives stage from the version)
 * @param {string} type
 * @param {string} title
 * @param {string} message
 * @returns {{ version: string, stage: string, type: string, title: string, message: string, whatChanged: [] }}
 */
function draft(version, stage, type, title, message) {
    return { version, stage, type, title, message, whatChanged: [] };
}

// ── ReleaseService ────────────────────────────────────────────────────────────

class ReleaseService {
    /**
     * Returns the in-flight target parsed from the highest-precedence changelog
     * version, or null when the store is empty.
     * @returns {object|null} parsed version
     * @private
     */
    static _top() {
        const entries = ChangelogModel.listAll();
        if (!entries.length) return null;
        let top = parseVersion(entries[0].version);
        for (const e of entries) {
            const p = parseVersion(e.version);
            if (compareVersion(p, top) > 0) top = p;
        }
        return top;
    }

    /**
     * Builds the three "open next cycle" drafts (patch / minor / major) off a
     * base core, each a fresh "-dev.1".
     * @param {object} base parsed core
     * @returns {{ patch: object, minor: object, major: object }}
     * @private
     */
    static _openDrafts(base) {
        const mk = (bump) => {
            const c = bumpCore(base, bump);
            return draft(
                `${coreStr(c)}-dev.1`,
                "dev",
                "release",
                `Opened ${coreStr(c)} development`,
                `Started the ${bump} development cycle for ${coreStr(c)}.`,
            );
        };
        return { patch: mk("patch"), minor: mk("minor"), major: mk("major") };
    }

    /**
     * Derives the current release state plus the draft entry each available
     * action would produce. No persistence — the caller posts a (possibly
     * edited) draft through the normal create endpoint.
     *
     * @returns {{ hasTarget: boolean, version: string|null, core: string|null,
     *             stage: string|null, iter: number, label: string|null,
     *             nextActions: string[], drafts: object }}
     */
    static getState() {
        const top = ReleaseService._top();

        // Empty store — the only move is to open a first cycle.
        if (!top) {
            return {
                hasTarget: false,
                version: null,
                core: null,
                stage: null,
                iter: 0,
                label: null,
                nextActions: ["open"],
                drafts: {
                    content: null,
                    promote: null,
                    cut: null,
                    open: ReleaseService._openDrafts({ major: 0, minor: 0, patch: 0 }),
                },
            };
        }

        const core = coreStr(top);
        const stage = top.stage;

        let nextActions = [];
        let content = null;
        let promote = null;
        let cut = null;
        let open = null;

        if (stage === "stable") {
            // Cycle closed — open the next one (content must wait for that).
            nextActions = ["open"];
            open = ReleaseService._openDrafts(top);
        } else {
            // A cycle is in flight — another build is always loggable.
            content = draft(`${core}-${stage}.${top.iter + 1}`, stage, "feat", "", "");

            if (stage === "rc") {
                nextActions = ["cut"];
                cut = draft(
                    core,
                    "stable",
                    "release",
                    `${core} released (Stable)`,
                    `Release ${core} is now generally available.`,
                );
            } else {
                // dev | alpha | beta → promote one stage up.
                const nextStage = STAGE_LADDER[STAGE_LADDER.indexOf(stage) + 1];
                nextActions = ["promote"];
                promote = draft(
                    `${core}-${nextStage}.1`,
                    nextStage,
                    "release",
                    `${core} promoted to ${STAGE_LABEL[nextStage]}`,
                    `Build ${core} advanced from ${STAGE_LABEL[stage]} to ${STAGE_LABEL[nextStage]}.`,
                );
            }
        }

        return {
            hasTarget: true,
            version: composeVersion(top),
            core,
            stage,
            iter: top.iter,
            label: STAGE_LABEL[stage],
            nextActions,
            drafts: { content, promote, cut, open },
        };
    }
}

module.exports = ReleaseService;
