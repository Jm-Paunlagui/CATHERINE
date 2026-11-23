import {
    normalizeText,
    findUnencodable,
    isLatin9Encodable,
    FOLD_MAP,
} from "../../../../src/utils/textNormalize";

describe("textNormalize (wave2)", () => {
    describe("normalizeText", () => {
        it.each([
            ["a—b", "a-b"],
            ["a–b", "a-b"],
            ["it’s", "it's"],
            ["“hi”", '"hi"'],
            ["wait…", "wait..."],
            ["• item", "* item"],
            ["a→b←c", "a->b<-c"],
        ])("folds %j to %j", (input, expected) => {
            expect(normalizeText(input)).toBe(expected);
        });

        it("leaves plain ASCII untouched", () => {
            expect(normalizeText("plain text 123")).toBe("plain text 123");
        });

        it("returns empty string and non-strings unchanged", () => {
            expect(normalizeText("")).toBe("");
            expect(normalizeText(42 as unknown as string)).toBe(42);
            expect(normalizeText(null as unknown as string)).toBeNull();
            const obj = {};
            expect(normalizeText(obj as unknown as string)).toBe(obj);
        });

        it("keeps astral characters intact as single units", () => {
            expect(normalizeText("x\u{1F600}—y")).toBe("x\u{1F600}-y");
        });

        it("every FOLD_MAP entry maps to a Latin-9 encodable ASCII-range string", () => {
            for (const [, to] of FOLD_MAP) {
                for (const ch of to) expect(isLatin9Encodable(ch)).toBe(true);
            }
        });
    });

    describe("isLatin9Encodable", () => {
        it("accepts Latin-9 additions", () => {
            for (const ch of ["€", "Š", "š", "Ž", "ž", "Œ", "œ", "Ÿ"]) {
                expect(isLatin9Encodable(ch)).toBe(true);
            }
        });

        it("rejects the ISO-8859-1 slots Latin-9 replaced", () => {
            for (const ch of ["¤", "¦", "¨", "´", "¸", "¼", "½", "¾"]) {
                expect(isLatin9Encodable(ch)).toBe(false);
            }
        });

        it("accepts code points up to 0xFF and rejects above", () => {
            expect(isLatin9Encodable("A")).toBe(true);
            expect(isLatin9Encodable("ÿ")).toBe(true);
            expect(isLatin9Encodable("Ā")).toBe(false);
            expect(isLatin9Encodable("\u{1F600}")).toBe(false);
        });

        it("treats an empty string as encodable (code point defaults to 0)", () => {
            expect(isLatin9Encodable("")).toBe(true);
        });
    });

    describe("findUnencodable", () => {
        it("returns [] for non-strings and empty strings", () => {
            expect(findUnencodable(undefined)).toEqual([]);
            expect(findUnencodable(5)).toEqual([]);
            expect(findUnencodable("")).toEqual([]);
        });

        it("returns [] when everything is encodable", () => {
            expect(findUnencodable("café €")).toEqual([]);
        });

        it("reports each offending character once, in first-seen order", () => {
            expect(findUnencodable("a中b中½c\u{1F600}½")).toEqual([
                "中",
                "½",
                "\u{1F600}",
            ]);
        });
    });
});
