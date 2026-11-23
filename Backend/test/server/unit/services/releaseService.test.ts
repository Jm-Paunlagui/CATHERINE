/**
 * @fileoverview Unit tests for ReleaseService — the release-train state machine
 * (dev -> alpha -> beta -> rc -> stable) derived from changelog versions.
 */
import ReleaseService from "../../../../src/services/ReleaseService";
import ChangelogModel from "../../../../src/models/changelog.model";

const withVersions = (...versions: string[]) =>
    vi.spyOn(ChangelogModel, "listAll").mockReturnValue(versions.map((version) => ({ version })) as never);

afterEach(() => {
    vi.restoreAllMocks();
});

describe("ReleaseService.getState", () => {
    it("empty store: only 'open' is available, drafts seeded from 0.0.0", () => {
        withVersions();
        const s = ReleaseService.getState();
        expect(s).toMatchObject({ hasTarget: false, version: null, stage: null, nextActions: ["open"] });
        const open = s.drafts.open as Record<string, { version: string }>;
        expect(open.patch.version).toBe("0.0.1-dev.1");
        expect(open.minor.version).toBe("0.1.0-dev.1");
        expect(open.major.version).toBe("1.0.0-dev.1");
        expect(s.drafts.content).toBeNull();
    });

    it("stable top: opens the next cycle and offers no content draft", () => {
        withVersions("1.4.2");
        const s = ReleaseService.getState();
        expect(s).toMatchObject({ hasTarget: true, version: "1.4.2", stage: "stable", label: "Stable", nextActions: ["open"] });
        const open = s.drafts.open as Record<string, { version: string; type: string }>;
        expect(open.patch.version).toBe("1.4.3-dev.1");
        expect(open.minor.version).toBe("1.5.0-dev.1");
        expect(open.major.version).toBe("2.0.0-dev.1");
        expect(open.major.type).toBe("release");
        expect(s.drafts.content).toBeNull();
        expect(s.drafts.promote).toBeNull();
        expect(s.drafts.cut).toBeNull();
    });

    it.each([
        ["1.5.0-dev.3", "dev", "alpha", "Developer Preview", "Alpha"],
        ["1.5.0-alpha.1", "alpha", "beta", "Alpha", "Beta"],
        ["1.5.0-beta.2", "beta", "rc", "Beta", "Release Candidate"],
    ])("%s promotes %s -> %s", (v, stage, next, label, nextLabel) => {
        withVersions(v);
        const s = ReleaseService.getState();
        expect(s.stage).toBe(stage);
        expect(s.nextActions).toEqual(["promote"]);
        expect(s.label).toBe(label);
        const promote = s.drafts.promote as { version: string; message: string; title: string };
        expect(promote.version).toBe(`1.5.0-${next}.1`);
        expect(promote.title).toContain(nextLabel);
        expect(promote.message).toContain(label);
        const content = s.drafts.content as { version: string; type: string };
        expect(content.type).toBe("feat");
        expect(content.version).toBe(`1.5.0-${stage}.${Number(v.split(".").pop()) + 1}`);
    });

    it("rc top: cut drafts the stable release", () => {
        withVersions("2.0.0-rc.1");
        const s = ReleaseService.getState();
        expect(s.nextActions).toEqual(["cut"]);
        expect(s.drafts.cut).toMatchObject({ version: "2.0.0", stage: "stable", type: "release" });
        expect((s.drafts.content as { version: string }).version).toBe("2.0.0-rc.2");
        expect(s.drafts.promote).toBeNull();
    });

    it("picks the highest-precedence version regardless of list order", () => {
        withVersions("1.0.0", "1.2.0-beta.1", "1.2.0-alpha.9", "1.2.0-beta.3", "1.1.9", "0.9.0");
        const s = ReleaseService.getState();
        expect(s.version).toBe("1.2.0-beta.3");
        expect(s.iter).toBe(3);
    });

    it("compares major/minor/patch numerically and prerelease below stable", () => {
        withVersions("1.2.3-rc.5", "1.2.3", "1.2.2", "1.1.9", "0.9.9");
        expect(ReleaseService.getState().version).toBe("1.2.3");
        withVersions("2.0.0-dev.1", "1.9.9");
        expect(ReleaseService.getState().version).toBe("2.0.0-dev.1");
        withVersions("1.3.0-dev.1", "1.2.9");
        expect(ReleaseService.getState().version).toBe("1.3.0-dev.1");
        withVersions("1.2.4-dev.1", "1.2.3");
        expect(ReleaseService.getState().version).toBe("1.2.4-dev.1");
    });

    it("treats an unparseable prerelease tag as stable", () => {
        withVersions("1.0.0-weird");
        expect(ReleaseService.getState().stage).toBe("stable");
    });

    it("treats a missing version as 0.0.0 stable", () => {
        vi.spyOn(ChangelogModel, "listAll").mockReturnValue([{ version: undefined }] as never);
        const s = ReleaseService.getState();
        expect(s.version).toBe("0.0.0");
        expect(s.stage).toBe("stable");
    });
});
