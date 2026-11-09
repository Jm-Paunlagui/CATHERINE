"use strict";

const { checkChangelog, TAG_RE } = require("../../../../scripts/verify-changelog-release.js");

const e = (version, title, createdAt, type = "release", displayDate = "2026-11-02") => ({ version, title, createdAt, type, displayDate });

describe("verify-changelog-release checkChangelog", () => {
    it("passes when every prerelease version is unique and the newest entry is the release", () => {
        const r = checkChangelog([e("2.1.15-dev.1", "2.1.15 Opened", "2026-11-01T01:00:00Z"), e("2.1.15-dev.2", "A fix", "2026-11-01T02:00:00Z", "fix"), e("2.1.15", "2.1.15 released (Stable)", "2026-11-01T03:00:00Z")], "2.1.15");
        expect(r.errors).toEqual([]);
        expect(r.newest.version).toBe("2.1.15");
    });

    it("fails when two entries share a prerelease version", () => {
        const r = checkChangelog([e("2.1.15-dev.2", "A", "2026-11-01T01:00:00Z", "fix"), e("2.1.15-dev.2", "B", "2026-11-01T02:00:00Z", "docs"), e("2.1.15", "2.1.15 released (Stable)", "2026-11-01T03:00:00Z")], "2.1.15");
        expect(r.errors.join(" ")).toMatch(/2\.1\.15-dev\.2 x2/);
    });

    it("allows a stable version to repeat (released + re-released)", () => {
        const r = checkChangelog([e("2.1.14", "2.1.14 released (Stable)", "2026-10-29T01:00:00Z"), e("2.1.14", "2.1.14 re-released (Stable)", "2026-11-01T01:00:00Z")], "2.1.14");
        expect(r.errors).toEqual([]);
    });

    it("fails when the newest entry is not the tag's version", () => {
        const r = checkChangelog([e("2.1.15", "2.1.15 released (Stable)", "2026-11-01T01:00:00Z"), e("2.1.15-rc.2", "Late note", "2026-11-01T05:00:00Z")], "2.1.15");
        expect(r.errors.join(" ")).toMatch(/newest entry is 2\.1\.15-rc\.2/);
    });

    it("orders by displayDate before createdAt, as the app does", () => {
        const r = checkChangelog([e("2.1.15", "2.1.15 released (Stable)", "2026-11-01T01:00:00Z", "release", "2026-11-03"), e("2.1.15-rc.2", "Earlier day", "2026-11-05T01:00:00Z", "release", "2026-11-02")], "2.1.15");
        expect(r.errors).toEqual([]);
    });

    it("fails when the changelog contains a later version than the tag", () => {
        const r = checkChangelog([e("2.1.14", "2.1.14 released (Stable)", "2026-11-03T01:00:00Z"), e("2.2.0-alpha.1", "2.2.0 promoted to Alpha", "2026-10-01T01:00:00Z")], "2.1.14");
        expect(r.errors.join(" ")).toMatch(/newer than 2\.1\.14/);
    });

    it("checks a prerelease tag against its exact version", () => {
        const ok = checkChangelog([e("2.2.0-alpha.21", "x", "2026-11-01T01:00:00Z", "test"), e("2.2.0-alpha.22", "Hotfix Included", "2026-11-01T02:00:00Z")], "2.2.0-alpha.22");
        expect(ok.errors).toEqual([]);
        const bad = checkChangelog([e("2.2.0-alpha.22", "Hotfix Included", "2026-11-01T02:00:00Z")], "2.2.0-alpha.23");
        expect(bad.errors.length).toBe(1);
    });

    it("only warns (never fails) on a release entry that is not a stage marker", () => {
        const r = checkChangelog([e("2.1.15-dev.1", "Live Server Status on Every Page", "2026-11-01T01:00:00Z"), e("2.1.15", "2.1.15 released (Stable)", "2026-11-01T02:00:00Z")], "2.1.15");
        expect(r.errors).toEqual([]);
        expect(r.warnings.length).toBe(1);
    });

    it("fails when a later stage step is dated before an earlier one (re-release promoted to Alpha after Beta)", () => {
        const r = checkChangelog([e("2.1.15-alpha.1", "2.1.15 promoted to Alpha", "2026-10-30T01:00:00Z", "release", "2026-10-30"), e("2.1.15-beta.1", "2.1.15 promoted to Beta", "2026-10-30T02:00:00Z", "release", "2026-10-30"), e("2.1.15-alpha.2", "2.1.15 promoted to Alpha", "2026-11-03T01:00:00Z", "release", "2026-11-03"), e("2.1.15", "2.1.15 released (Stable)", "2026-11-03T02:00:00Z", "release", "2026-11-03")], "2.1.15");
        expect(r.errors.join(" ")).toMatch(/out of date order \(e\.g\. 2\.1\.15-beta\.1 -> 2\.1\.15-alpha\.2\)/);
    });

    it("fails when a dev entry is dated after a later stage", () => {
        const r = checkChangelog([e("2.1.15-rc.1", "2.1.15 promoted to Release Candidate", "2026-10-30T01:00:00Z"), e("2.1.15-dev.8", "Late fix", "2026-10-30T02:00:00Z", "fix"), e("2.1.15", "2.1.15 released (Stable)", "2026-10-30T03:00:00Z")], "2.1.15");
        expect(r.errors.join(" ")).toMatch(/2\.1\.15-rc\.1 -> 2\.1\.15-dev\.8/);
    });

    it("fails an empty changelog", () => {
        expect(checkChangelog([], "2.1.15").errors).toEqual(["changelog is empty"]);
    });

    it("recognises release tags and ignores other tags", () => {
        for (const t of ["2.1.3", "v2.1.15", "v2.2.0-alpha.22", "2.2.0-rc.1"]) expect(TAG_RE.test(t)).toBe(true);
        for (const t of ["latest", "v2.1", "release-2.1.15", "v2.1.15-hotfix"]) expect(TAG_RE.test(t)).toBe(false);
    });
});
