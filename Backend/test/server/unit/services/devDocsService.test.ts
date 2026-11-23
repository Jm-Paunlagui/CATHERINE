import path from "node:path";

import DevDocsService, {
    CORPUS_ROOT,
    FRESHNESS_SNAPSHOT_PATH,
    MIN_QUERY_LENGTH,
    SEARCH_RESULT_CAP,
    SECTION_SOURCE_MAP,
} from "../../../../src/services/DevDocsService";
import { AppError } from "../../../../src/constants/errors";
import { logger } from "../../../../src/utils/logger";
import { FakeDocsFs } from "../../helpers/fakeDevDocsFs";

const gitMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
    const util = await import("node:util");
    const execFile: any = vi.fn();
    execFile[util.promisify.custom] = gitMock;
    return { execFile, default: { execFile } };
});

const RS = String.fromCharCode(0x1e);
const gitOut = (...records: Array<[string, string[]]>) =>
    ({ stdout: records.map(([d, f]) => `${RS}${d}\n\n${f.join("\n")}\n`).join("") });

let fake: FakeDocsFs;
let snapshot: Record<string, string>;

function gitReturns(docs: string, sources: string) {
    gitMock.mockImplementation(async (_cmd: string, args: string[]) =>
        args.includes("dev-docs") ? { stdout: docs } : { stdout: sources });
}

beforeEach(() => {
    DevDocsService.invalidateManifest();
    fake = new FakeDocsFs(CORPUS_ROOT);
    fake.addFile("README.md", "# Welcome Doc\nhello world");
    fake.addFile("Support/arch-map.md", "# Architecture\nintro\n## Signing\nHMAC signing lives here\nmore");
    fake.addFile("Support/notes.txt", "ignored");
    fake.addFile("Custom/some_thing.MD", "no heading here\nsecond HMAC line");
    snapshot = {};
    fake.install(vi, snapshot);
    vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    vi.spyOn(logger, "warning").mockImplementation(() => undefined as never);
    gitMock.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); });

describe("DevDocsService constants", () => {
    it("exposes the static configuration", () => {
        expect(DevDocsService.CORPUS_ROOT).toBe(CORPUS_ROOT);
        expect(DevDocsService.MIN_QUERY_LENGTH).toBe(MIN_QUERY_LENGTH);
        expect(DevDocsService.SEARCH_RESULT_CAP).toBe(SEARCH_RESULT_CAP);
        expect(DevDocsService.SECTION_SOURCE_MAP).toBe(SECTION_SOURCE_MAP);
        expect(DevDocsService.FRESHNESS_SNAPSHOT_PATH).toBe(FRESHNESS_SNAPSHOT_PATH);
    });
});

describe("pure helpers", () => {
    it("_buildId slugs section and file name", () => {
        expect(DevDocsService._buildId("System Admin", "My\\Doc/Name.MD")).toBe("system admin/my-doc-name");
    });

    it.each([
        [null, "2026-01-01", "UNKNOWN"],
        ["2026-01-01", null, "UNKNOWN"],
        ["2026-02-01", "2026-01-01", "CURRENT"],
        ["2026-01-01", "2026-01-01", "CURRENT"],
        ["2025-12-31", "2026-01-01", "SUSPECT"],
    ])("_freshness(%s,%s)=%s", (d, s, expected) => {
        expect(DevDocsService._freshness(d, s)).toBe(expected);
    });

    it("_sectionSourceDate picks the newest known source date, or null", () => {
        const idx = new Map([["src/services/ChangelogService.ts", "2026-03-01"], ["src/utils/systemMap.ts", "2026-05-09"]]);
        expect(DevDocsService._sectionSourceDate("Support", idx)).toBe("2026-05-09");
        expect(DevDocsService._sectionSourceDate("Others", idx)).toBeNull();
        expect(DevDocsService._sectionSourceDate("Unmapped", idx)).toBeNull();
    });

    it("_assertInsideCorpus accepts the root and children, rejects escapes", () => {
        expect(DevDocsService._assertInsideCorpus(CORPUS_ROOT)).toBe(CORPUS_ROOT);
        expect(DevDocsService._assertInsideCorpus(path.join(CORPUS_ROOT, "a", "b.md"))).toBe(path.join(CORPUS_ROOT, "a", "b.md"));
        expect(() => DevDocsService._assertInsideCorpus(path.join(CORPUS_ROOT, "..", "x"))).toThrow(AppError);
        expect(logger.error).toHaveBeenCalled();
    });
});

describe("_readTitle", () => {
    it("uses the first H1", async () => {
        expect(await DevDocsService._readTitle(path.join(CORPUS_ROOT, "README.md"), "README.md")).toBe("Welcome Doc");
    });
    it("falls back to a humanised filename when no H1 exists", async () => {
        expect(await DevDocsService._readTitle(path.join(CORPUS_ROOT, "Custom/some_thing.MD"), "some_thing-doc.MD")).toBe("Some Thing Doc");
    });
    it("falls back when the file cannot be opened", async () => {
        expect(await DevDocsService._readTitle(path.join(CORPUS_ROOT, "missing.md"), "missing-file.md")).toBe("Missing File");
    });
});

describe("_commitDateIndex", () => {
    it("returns empty for no pathspecs without running git", async () => {
        expect((await DevDocsService._commitDateIndex([])).size).toBe(0);
        expect(gitMock).not.toHaveBeenCalled();
    });
    it("keeps the newest (first-seen) date per file and ignores blank lines", async () => {
        gitMock.mockResolvedValue(gitOut(["2026-02-02", ["a.md", "b.md"]], ["2025-01-01", ["a.md", "c.md"]]));
        const idx = await DevDocsService._commitDateIndex(["dev-docs"]);
        expect(Object.fromEntries(idx)).toEqual({ "a.md": "2026-02-02", "b.md": "2026-02-02", "c.md": "2025-01-01" });
    });
    it("ignores file lines that precede any commit record", async () => {
        gitMock.mockResolvedValue({ stdout: "orphan.md\n" });
        expect((await DevDocsService._commitDateIndex(["x"])).size).toBe(0);
    });
    it("returns empty when git is unavailable", async () => {
        gitMock.mockRejectedValue(new Error("git not found"));
        expect((await DevDocsService._commitDateIndex(["x"])).size).toBe(0);
    });
});

describe("freshness snapshot and date index resolution", () => {
    it("_loadFreshnessSnapshot keeps only string entries", async () => {
        snapshot[FRESHNESS_SNAPSHOT_PATH] = JSON.stringify({ docs: { "dev-docs/a.md": "2026-01-01", bad: 5 }, sources: null });
        const snap = await DevDocsService._loadFreshnessSnapshot();
        expect(Object.fromEntries(snap!.docs)).toEqual({ "dev-docs/a.md": "2026-01-01" });
        expect(snap!.sources.size).toBe(0);
    });
    it("_loadFreshnessSnapshot is null when unreadable or invalid", async () => {
        snapshot[FRESHNESS_SNAPSHOT_PATH] = "{not json";
        expect(await DevDocsService._loadFreshnessSnapshot()).toBeNull();
    });
    it("uses git when both indexes are populated", async () => {
        gitReturns(gitOut(["2026-01-01", ["dev-docs/README.md"]]).stdout, gitOut(["2026-01-01", ["src/x.ts"]]).stdout);
        const r = await DevDocsService._resolveDateIndexes();
        expect(r.docIndex.size).toBe(1);
        expect(r.sourceIndex.size).toBe(1);
    });
    it("falls back to the snapshot for whichever index git left empty", async () => {
        gitReturns("", gitOut(["2026-04-04", ["src/x.ts"]]).stdout);
        snapshot[FRESHNESS_SNAPSHOT_PATH] = JSON.stringify({ docs: { "dev-docs/README.md": "2026-02-02" }, sources: { "src/y.ts": "2020-01-01" } });
        const r = await DevDocsService._resolveDateIndexes();
        expect(Object.fromEntries(r.docIndex)).toEqual({ "dev-docs/README.md": "2026-02-02" });
        expect(Object.fromEntries(r.sourceIndex)).toEqual({ "src/x.ts": "2026-04-04" });
    });
    it("falls back to the snapshot sources when only the docs index is populated", async () => {
        gitReturns(gitOut(["2026-01-01", ["dev-docs/README.md"]]).stdout, "");
        snapshot[FRESHNESS_SNAPSHOT_PATH] = JSON.stringify({ docs: {}, sources: { "src/y.ts": "2020-01-01" } });
        const r = await DevDocsService._resolveDateIndexes();
        expect(r.docIndex.size).toBe(1);
        expect(r.sourceIndex.get("src/y.ts")).toBe("2020-01-01");
    });
    it("warns and returns empty indexes when neither git nor snapshot is available", async () => {
        gitMock.mockRejectedValue(new Error("no git"));
        const r = await DevDocsService._resolveDateIndexes();
        expect(r.docIndex.size + r.sourceIndex.size).toBe(0);
        expect(logger.warning).toHaveBeenCalledTimes(1);
    });
});

describe("getTree / manifest", () => {
    beforeEach(() => {
        gitReturns(
            gitOut(["2026-06-01", ["dev-docs/README.md", "dev-docs/Support/arch-map.md"]]).stdout,
            gitOut(["2026-05-01", ["src/utils/systemMap.ts", "src/services/DevDocsService.ts"]]).stdout,
        );
    });

    it("builds Overview first, then directories, with titles, sizes and freshness", async () => {
        const tree = await DevDocsService.getTree();
        expect(new Date(tree.generatedAt).toString()).not.toBe("Invalid Date");
        expect(tree.sections.map((s) => s.name)).toEqual(["Overview", "Custom", "Support"]);
        const overview = tree.sections[0].docs[0];
        expect(overview).toMatchObject({ id: "overview/readme", title: "Welcome Doc", docCommittedAt: "2026-06-01", freshness: "CURRENT" });
        const custom = tree.sections[1].docs[0];
        expect(custom).toMatchObject({ id: "custom/some_thing", title: "Some Thing", docCommittedAt: null, sourceCommittedAt: null, freshness: "UNKNOWN" });
        const support = tree.sections[2].docs;
        expect(support).toHaveLength(1);
        expect(support[0].title).toBe("Architecture");
        expect(support[0].sizeBytes).toBeGreaterThan(0);
    });

    it("marks a doc SUSPECT when its sources changed after it", async () => {
        gitReturns(gitOut(["2026-01-01", ["dev-docs/README.md"]]).stdout, gitOut(["2026-05-01", ["src/services/DevDocsService.ts"]]).stdout);
        const tree = await DevDocsService.getTree();
        expect(tree.sections[0].docs[0].freshness).toBe("SUSPECT");
    });

    it("caches the manifest within the TTL and rebuilds after expiry or invalidation", async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
            await DevDocsService.getTree();
            const calls = gitMock.mock.calls.length;
            await DevDocsService.getTree();
            expect(gitMock.mock.calls.length).toBe(calls);
            vi.setSystemTime(new Date("2026-01-01T00:06:00Z"));
            await DevDocsService.getTree();
            expect(gitMock.mock.calls.length).toBe(calls * 2);
            DevDocsService.invalidateManifest();
            await DevDocsService.getTree();
            expect(gitMock.mock.calls.length).toBe(calls * 3);
        } finally {
            vi.useRealTimers();
        }
    });

    it("throws CORPUS_UNAVAILABLE when the corpus root is unreadable", async () => {
        fake.failReaddir.add(CORPUS_ROOT);
        await expect(DevDocsService.getTree()).rejects.toMatchObject({ statusCode: 500 });
        expect(logger.error).toHaveBeenCalled();
    });

    it("skips a directory that cannot be listed and a file that vanishes before stat", async () => {
        fake.failReaddir.add(path.join(CORPUS_ROOT, "Custom"));
        fake.failStat.add(path.join(CORPUS_ROOT, "Support", "arch-map.md"));
        const tree = await DevDocsService.getTree();
        expect(tree.sections.map((s) => s.name)).toEqual(["Overview"]);
    });

    it("omits the Overview section when there are no root-level docs", async () => {
        fake.files.delete(path.join(CORPUS_ROOT, "README.md"));
        const tree = await DevDocsService.getTree();
        expect(tree.sections.map((s) => s.name)).toEqual(["Custom", "Support"]);
    });
});

describe("getDoc", () => {
    beforeEach(() => { gitReturns("", ""); snapshot[FRESHNESS_SNAPSHOT_PATH] = "{}"; });

    it("returns the markdown and metadata, case/whitespace-insensitively", async () => {
        const doc = await DevDocsService.getDoc("  SUPPORT/Arch-Map ");
        expect(doc).toMatchObject({ id: "support/arch-map", title: "Architecture", freshness: "UNKNOWN" });
        expect(doc.markdown).toContain("HMAC signing lives here");
    });

    it("404s for unknown ids, null and non-strings, truncating the echoed id", async () => {
        await expect(DevDocsService.getDoc("nope/none")).rejects.toMatchObject({ statusCode: 404 });
        await expect(DevDocsService.getDoc(null as never)).rejects.toMatchObject({ statusCode: 404 });
        const err: any = await DevDocsService.getDoc("x".repeat(500)).catch((e) => e);
        expect(JSON.stringify(err.details ?? err)).not.toContain("x".repeat(200));
    });

    it("500s with a read failure when the file disappears after the manifest was built", async () => {
        await DevDocsService.getTree();
        fake.failRead.add(path.join(CORPUS_ROOT, "Support", "arch-map.md"));
        await expect(DevDocsService.getDoc("support/arch-map")).rejects.toMatchObject({ statusCode: 500 });
        expect(logger.error).toHaveBeenCalled();
    });
});

describe("search", () => {
    beforeEach(() => { gitReturns("", ""); snapshot[FRESHNESS_SNAPSHOT_PATH] = "{}"; });

    it.each([undefined, null, "", " a "])("rejects short query %j", async (q) => {
        await expect(DevDocsService.search(q)).rejects.toMatchObject({ statusCode: 400 });
    });

    it("finds case-insensitive hits with the nearest heading and 1-based line numbers", async () => {
        const r = await DevDocsService.search("hmac");
        expect(r.total).toBe(2);
        expect(r.truncated).toBe(false);
        const hit = r.results.find((x) => x.id === "support/arch-map");
        expect(hit).toMatchObject({ heading: "Signing", line: 4, title: "Architecture" });
        expect(r.results.find((x) => x.id === "custom/some_thing")).toMatchObject({ heading: null, line: 2 });
    });

    it("ellipsises long lines on both sides of the snippet", async () => {
        fake.addFile("Support/long.md", `${"a".repeat(200)} NEEDLE ${"b".repeat(200)}`);
        DevDocsService.invalidateManifest();
        const r = await DevDocsService.search("needle");
        expect((r.results[0].snippet as string).startsWith("…")).toBe(true);
        expect((r.results[0].snippet as string).endsWith("…")).toBe(true);
    });

    it("caps collected results but keeps counting", async () => {
        fake.addFile("Support/many.md", Array.from({ length: SEARCH_RESULT_CAP + 10 }, () => "zzmatch").join("\n"));
        DevDocsService.invalidateManifest();
        const r = await DevDocsService.search("zzmatch");
        expect(r.results).toHaveLength(SEARCH_RESULT_CAP);
        expect(r.total).toBe(SEARCH_RESULT_CAP + 10);
        expect(r.truncated).toBe(true);
    });

    it("skips an unreadable document without failing the search", async () => {
        await DevDocsService.getTree();
        fake.failRead.add(path.join(CORPUS_ROOT, "Custom", "some_thing.MD"));
        const r = await DevDocsService.search("hmac");
        expect(r.total).toBe(1);
    });
});
