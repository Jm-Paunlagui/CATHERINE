/**
 * helpConsistency.test.jsx — structural + editorial invariants over the REAL
 * Help Center content (help.data.jsx). No mocks, no fixtures: these assertions
 * run against the shipped corpus so a careless content edit fails CI instead of
 * reaching users.
 *
 * WHAT IS GUARANTEED
 * ──────────────────
 * 1. Structural integrity — every category has an id / label / description /
 *    icon and at least one article; every article has an id, a question that
 *    reads as a question, a substantial answer, and search tags.
 * 2. Uniqueness — category ids are unique, and article ids are globally unique
 *    (the launcher keys results by article id).
 * 3. Contiguous nav groups — a `roleGroup` divider label never appears in two
 *    non-adjacent blocks, which would stamp the same divider twice in the rail.
 * 4. Plain-language guard — end-user answers must not leak internal identifiers
 *    (CWE refs, ORA- codes, raw class/module names, HTML sink names). The
 *    content is explicitly "rewritten for end-user consumption" per the file
 *    header, so any leak is a regression.
 *
 * PORT NOTE (MEAL → CATHERINE): rewritten for CATHERINE's corpus. All MEAL
 * domain tokens (excess-fund, RFID, vendor, station/terminal, ₱) are dropped;
 * the banned-token list targets CATHERINE's own internal vocabulary instead.
 */

import { describe, expect, it } from "vitest";

import { HELP_CATEGORIES } from "../../../src/features/support/help/help.data";

/** Flatten to a { cat, article } list for global assertions. */
const allArticles = HELP_CATEGORIES.flatMap((cat) => cat.articles.map((article) => ({ cat, article })));

describe("Help content — structural integrity", () => {
    it("has at least a meaningful number of categories", () => {
        expect(HELP_CATEGORIES.length).toBeGreaterThanOrEqual(10);
    });

    it("gives every category an id, label, description, icon, and ≥1 article", () => {
        for (const cat of HELP_CATEGORIES) {
            expect(cat.id, `category id missing`).toBeTruthy();
            expect(typeof cat.id).toBe("string");
            expect(cat.label, `${cat.id} label`).toBeTruthy();
            expect(cat.description, `${cat.id} description`).toBeTruthy();
            expect(cat.icon, `${cat.id} icon`).toBeTruthy();
            expect(Array.isArray(cat.articles)).toBe(true);
            expect(cat.articles.length, `${cat.id} has no articles`).toBeGreaterThan(0);
        }
    });

    it("gives every article an id, a question, a substantial answer, and tags", () => {
        for (const { cat, article } of allArticles) {
            const where = `${cat.id}/${article.id}`;
            expect(article.id, `${where} id`).toBeTruthy();
            expect(article.question, `${where} question`).toBeTruthy();
            // Questions should read as questions.
            expect(article.question.trim().endsWith("?"), `${where} question must end with '?'`).toBe(true);
            // Answers must be real prose, not a stub.
            expect(typeof article.answer).toBe("string");
            expect(article.answer.trim().length, `${where} answer too short`).toBeGreaterThan(40);
            // Tags power search — every article needs at least one.
            expect(Array.isArray(article.tags), `${where} tags`).toBe(true);
            expect(article.tags.length, `${where} needs ≥1 tag`).toBeGreaterThan(0);
            for (const tag of article.tags) {
                expect(typeof tag, `${where} tag type`).toBe("string");
                expect(tag.trim().length, `${where} empty tag`).toBeGreaterThan(0);
            }
        }
    });
});

describe("Help content — uniqueness", () => {
    it("has unique category ids", () => {
        const ids = HELP_CATEGORIES.map((c) => c.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("has globally unique article ids (launcher keys on them)", () => {
        const ids = allArticles.map(({ article }) => article.id);
        const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
        expect(dupes, `duplicate article ids: ${dupes.join(", ")}`).toEqual([]);
    });
});

describe("Help content — contiguous nav groups", () => {
    it("never repeats a roleGroup divider label in non-adjacent blocks", () => {
        // Walk categories in order; each time the roleGroup value changes, that's
        // a new block. A given label may head at most ONE block.
        const seen = new Set();
        let prev;
        for (const cat of HELP_CATEGORIES) {
            const group = cat.roleGroup ?? null;
            if (group !== prev) {
                if (group != null) {
                    expect(seen.has(group), `roleGroup "${group}" appears in a second, non-contiguous block`).toBe(false);
                    seen.add(group);
                }
                prev = group;
            }
        }
    });
});

describe("Help content — plain-language guard (no internal identifiers leak to users)", () => {
    // Tokens that must never appear in user-facing question/answer text. The
    // header promises the corpus is "rewritten for end-user consumption (no
    // test evidence, no CWE references, no code snippets)".
    const BANNED = [
        /CWE-\d/i, // security taxonomy ids
        /\bORA-\d/i, // Oracle error codes
        /dangerouslySetInnerHTML/, // React HTML sink
        /\bnpm run\b/i, // build commands
        /process\.env/i, // env access
        /httpClient\b/, // internal module name
        /AuthMiddleware\b/, // internal class name
    ];

    it("keeps banned internal tokens out of every question and answer", () => {
        for (const { cat, article } of allArticles) {
            const prose = `${article.question} ${article.answer}`;
            for (const rx of BANNED) {
                expect(rx.test(prose), `${cat.id}/${article.id} leaks ${rx} in user-facing text`).toBe(false);
            }
        }
    });
});
