import { singleAddress, maskAddress, credentialAddressOf } from "../../../../src/utils/emailAddress";
import { normalizeCellValue } from "../../../../src/utils/excelCell";
import { queryString } from "../../../../src/utils/http/queryString";

describe("singleAddress", () => {
    it("accepts one plain address and trims it", () => {
        expect(singleAddress("  a.b@corp.com ")).toBe("a.b@corp.com");
    });
    it.each([
        ["list with comma", "a@x.org, b@y.org"],
        ["semicolon list", "a@x.org;b@y.org"],
        ["display name", "Bob <b@x.org>"],
        ["placeholder", "N/A"],
        ["empty", "   "],
        ["no dot in domain", "a@localhost"],
        ["CRLF header injection", "a@x.org\r\nBcc: evil@y.org"],
        ["embedded newline", "a@x.org\nb@y.org"],
        ["over 254 chars", `${"a".repeat(250)}@x.org`],
    ])("rejects %s", (_n, v) => expect(singleAddress(v)).toBeNull());
    it("rejects non-strings including arrays (type confusion) and accepts null as empty", () => {
        expect(singleAddress(["a@x.org"])).toBeNull();
        expect(singleAddress(12)).toBeNull();
        expect(singleAddress({ text: "a@x.org" })).toBeNull();
        expect(singleAddress(null)).toBeNull();
        expect(singleAddress(undefined)).toBeNull();
    });
});

describe("maskAddress", () => {
    it("keeps first char and full domain", () => expect(maskAddress("juan.cruz@corp.com")).toBe("j***@corp.com"));
    it("returns null for anything singleAddress rejects", () => {
        expect(maskAddress("a@x.org,b@y.org")).toBeNull();
        expect(maskAddress(null)).toBeNull();
    });
});

describe("credentialAddressOf", () => {
    it("is null without a row", () => expect(credentialAddressOf(null)).toBeNull());
    it("prefers the resolver marker, even when null (several or no addresses)", () => {
        expect(credentialAddressOf({ _CREDENTIAL_EMAIL: "x@y.org", EMAIL: "other@y.org" })).toBe("x@y.org");
        expect(credentialAddressOf({ _CREDENTIAL_EMAIL: null, EMAIL: "other@y.org" })).toBeNull();
        expect(credentialAddressOf({ _CREDENTIAL_EMAIL: undefined, EMAIL: "other@y.org" })).toBeNull();
    });
    it("falls back to EMAIL then lower-case email, and refuses unsafe values", () => {
        expect(credentialAddressOf({ EMAIL: "a@x.org" })).toBe("a@x.org");
        expect(credentialAddressOf({ email: "b@x.org" })).toBe("b@x.org");
        expect(credentialAddressOf({ EMAIL: "a@x.org, c@x.org" })).toBeNull();
        expect(credentialAddressOf({})).toBeNull();
    });
});

describe("normalizeCellValue", () => {
    it("returns null for nullish and passes primitives and dates", () => {
        const d = new Date(0);
        expect(normalizeCellValue(undefined)).toBeNull();
        expect(normalizeCellValue(null)).toBeNull();
        expect(normalizeCellValue("s")).toBe("s");
        expect(normalizeCellValue(3)).toBe(3);
        expect(normalizeCellValue(false)).toBe(false);
        expect(normalizeCellValue(d)).toBe(d);
        expect(normalizeCellValue(() => 1)).toBeNull();
    });
    it("joins rich text, skipping empty segments", () => {
        expect(normalizeCellValue({ richText: [{ text: "a" }, { text: null }, null, { text: 2 }] })).toBe("a2");
    });
    it("maps error cells to null", () => expect(normalizeCellValue({ error: "#N/A" })).toBeNull());
    it("resolves formula, shared formula and bare result values", () => {
        expect(normalizeCellValue({ formula: "A1", result: 5 })).toBe(5);
        expect(normalizeCellValue({ sharedFormula: "A1", result: "x" })).toBe("x");
        expect(normalizeCellValue({ result: "r" })).toBe("r");
        expect(normalizeCellValue({ formula: "A1", result: { richText: [{ text: "n" }] } })).toBe("n");
    });
    it("resolves hyperlink and text cells", () => {
        expect(normalizeCellValue({ text: "t", hyperlink: "http://x" })).toBe("t");
        expect(normalizeCellValue({ text: { richText: [{ text: "q" }] } })).toBe("q");
    });
    it("never yields [object Object]: unknown shapes and over-deep chains collapse to null", () => {
        expect(normalizeCellValue({ foo: 1 })).toBeNull();
        let deep: unknown = "x";
        for (let i = 0; i < 12; i++) deep = { result: deep };
        expect(normalizeCellValue(deep)).toBeNull();
    });
});

describe("queryString", () => {
    it("keeps strings and drops arrays, objects and absent values", () => {
        expect(queryString("a")).toBe("a");
        expect(queryString("")).toBe("");
        expect(queryString(["a", "b"])).toBeUndefined();
        expect(queryString({ b: "1" })).toBeUndefined();
        expect(queryString(undefined)).toBeUndefined();
        expect(queryString(5)).toBeUndefined();
    });
});
