import path from "node:path";

import DevDocsService, { CORPUS_ROOT, FRESHNESS_SNAPSHOT_PATH } from "../../../src/services/DevDocsService";
import { AppError } from "../../../src/constants/errors";
import { logger } from "../../../src/utils/logger";
import { FakeDocsFs } from "../helpers/fakeDevDocsFs";

const gitMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
    const util = await import("node:util");
    const execFile: any = vi.fn();
    execFile[util.promisify.custom] = gitMock;
    return { execFile, default: { execFile } };
});

let fake: FakeDocsFs;
const docReads = () => fake.readCalls.filter((p) => p !== FRESHNESS_SNAPSHOT_PATH);
const SECRET = "TOP-SECRET-OUTSIDE-CORPUS";

beforeEach(() => {
    DevDocsService.invalidateManifest();
    gitMock.mockResolvedValue({ stdout: "" });
    fake = new FakeDocsFs(CORPUS_ROOT);
    fake.addFile("Support/ok.md", "# OK\nneedle inside");
    fake.install(vi, {
        [path.resolve(CORPUS_ROOT, "..", "package.json")]: SECRET,
        "/etc/passwd": SECRET,
    });
    vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    vi.spyOn(logger, "warning").mockImplementation(() => undefined as never);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("DevDocsService path traversal (CWE-22)", () => {
    const escapes = [
        path.join(CORPUS_ROOT, "..", "package.json"),
        `${CORPUS_ROOT}-evil/secret.md`,
        "/etc/passwd",
        path.join(CORPUS_ROOT, "Support", "..", "..", "package.json"),
    ];

    it.each(escapes)("_assertInsideCorpus blocks %s with a generic 500 and an error log", (p) => {
        let thrown: any;
        try { DevDocsService._assertInsideCorpus(p); } catch (e) { thrown = e; }
        expect(thrown).toBeInstanceOf(AppError);
        expect(thrown.statusCode).toBe(500);
        expect(String(thrown.message)).not.toContain(CORPUS_ROOT);
        expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it.each([
        "../package.json",
        "..%2f..%2fetc/passwd",
        "support/../../package.json",
        "/etc/passwd",
        "support/ok/../../../package.json",
        "..\\..\\windows\\win.ini",
        "support/ok\0.md",
    ])("getDoc id %j never reaches the filesystem and 404s", async (id) => {
        await expect(DevDocsService.getDoc(id)).rejects.toMatchObject({ statusCode: 404 });
        expect(docReads()).toEqual([]);
    });

    it("only serves files from the manifest even when the id is a path to a real file", async () => {
        const abs = path.join(CORPUS_ROOT, "Support", "ok.md");
        await expect(DevDocsService.getDoc(abs)).rejects.toMatchObject({ statusCode: 404 });
        expect((await DevDocsService.getDoc("support/ok")).markdown).toContain("needle");
    });

    it("search results never include content from outside the corpus", async () => {
        const r = await DevDocsService.search("TOP-SECRET");
        expect(r.total).toBe(0);
        expect(docReads().every((p) => p.startsWith(CORPUS_ROOT + path.sep))).toBe(true);
    });

    it("error bodies for a missing doc do not leak absolute paths", async () => {
        const err: any = await DevDocsService.getDoc("nope").catch((e) => e);
        expect(JSON.stringify([err.message, err.details])).not.toContain(CORPUS_ROOT);
    });

    it("rejects too-short search terms (cheap-scan guard)", async () => {
        await expect(DevDocsService.search("a")).rejects.toMatchObject({ statusCode: 400 });
        expect(docReads()).toEqual([]);
    });
});
