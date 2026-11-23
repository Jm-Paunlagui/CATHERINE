/**
 * @fileoverview Unit tests for ChangelogService validation / normalisation and
 * the public (author-stripped) projections. The model is stubbed.
 */
import ChangelogService from "../../../../src/services/ChangelogService";
import ChangelogModel from "../../../../src/models/changelog.model";

const valid = {
    displayDate: "2026-01-02",
    version: " 1.4.0 ",
    title: "  Title ",
    message: " Msg  ",
    type: "feat",
};

afterEach(() => {
    vi.restoreAllMocks();
});

describe("ChangelogService.create validation", () => {
    it("normalises and forwards a valid body to the model", () => {
        const spy = vi.spyOn(ChangelogModel, "create").mockReturnValue({ id: "1" } as never);
        const out = ChangelogService.create({
            ...valid,
            whatChanged: [{ text: "x" }],
            authors: " a , b ,, ",
            coAuthors: [" c ", "", "d"],
        });
        expect(out).toEqual({ id: "1" });
        expect(spy).toHaveBeenCalledWith({
            displayDate: "2026-01-02",
            version: "1.4.0",
            title: "Title",
            message: "Msg",
            type: "feat",
            whatChanged: [{ text: "x" }],
            authors: ["a", "b"],
            coAuthors: ["c", "d"],
        });
    });

    it("accepts array authors and string coAuthors", () => {
        const spy = vi.spyOn(ChangelogModel, "create").mockReturnValue({} as never);
        ChangelogService.create({ ...valid, authors: [" x "], coAuthors: "p, q" });
        const arg = spy.mock.calls[0][0] as Record<string, unknown>;
        expect(arg.authors).toEqual(["x"]);
        expect(arg.coAuthors).toEqual(["p", "q"]);
    });

    it.each(["displayDate", "version", "title", "message", "type"])("400 when %s is missing", (field) => {
        const spy = vi.spyOn(ChangelogModel, "create");
        const body: Record<string, unknown> = { ...valid };
        delete body[field];
        expect(() => ChangelogService.create(body)).toThrow(expect.objectContaining({ statusCode: 400 }));
        expect(spy).not.toHaveBeenCalled();
    });

    it.each([
        ["non-string date", { displayDate: 20260102 }],
        ["malformed date", { displayDate: "02/01/2026" }],
        ["unknown type", { type: "hack" }],
        ["non-string type", { type: 5 }],
        ["v-prefixed version", { version: "v1.4.0" }],
        ["garbage prerelease", { version: "1.19.0-foo" }],
        ["prerelease without iteration", { version: "1.19.0-beta" }],
        ["two-part version", { version: "1.19" }],
        ["non-array whatChanged", { whatChanged: "nope" }],
    ])("400 for %s", (_n, patch) => {
        const spy = vi.spyOn(ChangelogModel, "create");
        expect(() => ChangelogService.create({ ...valid, ...patch })).toThrow(
            expect.objectContaining({ statusCode: 400 }),
        );
        expect(spy).not.toHaveBeenCalled();
    });

    it.each(["1.19.0-dev.1", "1.19.0-alpha.2", "1.19.0-beta.2", "1.19.0-rc.1.3"])("accepts release-stage version %s", (version) => {
        vi.spyOn(ChangelogModel, "create").mockReturnValue({} as never);
        expect(() => ChangelogService.create({ ...valid, version })).not.toThrow();
    });
});

describe("ChangelogService.update / delete", () => {
    it("partial update validates only supplied fields", () => {
        const spy = vi.spyOn(ChangelogModel, "update").mockReturnValue({ id: "7" } as never);
        expect(ChangelogService.update("7", { title: " New " })).toEqual({ id: "7" });
        expect(spy).toHaveBeenCalledWith("7", { title: "New" });
    });

    it("partial update still rejects an invalid supplied field", () => {
        const spy = vi.spyOn(ChangelogModel, "update");
        expect(() => ChangelogService.update("7", { type: "bogus" })).toThrow(expect.objectContaining({ statusCode: 400 }));
        expect(spy).not.toHaveBeenCalled();
    });

    it("rejects an empty id on update and delete", () => {
        expect(() => ChangelogService.update("", {})).toThrow(expect.objectContaining({ statusCode: 400 }));
        expect(() => ChangelogService.delete("")).toThrow(expect.objectContaining({ statusCode: 400 }));
    });

    it("delete forwards the id", () => {
        const spy = vi.spyOn(ChangelogModel, "delete").mockReturnValue(undefined as never);
        ChangelogService.delete("9");
        expect(spy).toHaveBeenCalledWith("9");
    });
});

describe("ChangelogService public projections", () => {
    const entries = [
        { id: "a", version: "1.0.0", authors: ["x"], coAuthors: ["y"] },
        { id: "b", version: "0.9.0", authors: ["z"] },
    ];

    it("listAll returns the model result untouched", () => {
        vi.spyOn(ChangelogModel, "listAll").mockReturnValue(entries as never);
        expect(ChangelogService.listAll()).toBe(entries);
    });

    it("listPublic strips authors and coAuthors", () => {
        vi.spyOn(ChangelogModel, "listAll").mockReturnValue(entries as never);
        expect(ChangelogService.listPublic()).toEqual([
            { id: "a", version: "1.0.0" },
            { id: "b", version: "0.9.0" },
        ]);
    });

    it("latestPublic is the first public entry, or null when empty", () => {
        const spy = vi.spyOn(ChangelogModel, "listAll").mockReturnValue(entries as never);
        expect(ChangelogService.latestPublic()).toEqual({ id: "a", version: "1.0.0" });
        spy.mockReturnValue([] as never);
        expect(ChangelogService.latestPublic()).toBeNull();
    });
});
