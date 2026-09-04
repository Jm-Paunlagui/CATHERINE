/**
 * helpSearch.test.js — pure-function contract for the shared help search engine.
 *
 * WHY A SEPARATE PURE-FUNCTION SUITE
 * ──────────────────────────────────
 * helpAssistantSearch and helpCenterSearch prove the BEHAVIOUR end-to-end
 * through the hooks (with auth, MSW, and the real corpus). This suite pins the
 * INVARIANTS of the engine itself in isolation — no React, no network, no
 * corpus — so a change to a threshold, the synonym table, or the Levenshtein
 * early-exit is caught here with a one-line failure instead of a confusing
 * hook-test regression three layers up. These are the load-bearing edges:
 *   • boundedLevenshtein's early-exit returns max+1 (never the true distance)
 *   • the TWO tolerance policies differ exactly where the design depends on it
 *     (strict article match ≤1 vs. lenient suggestion ≤2) — the separation is
 *     what lets "did you mean?" fire at all
 *   • tokenize drops stop-words but never returns empty
 *   • expandSynonyms is additive + deduped
 *   • scoreTokens ranks exact (1) above fuzzy (0.5) above miss (0)
 *   • findSuggestion returns null for a real word and for an off-target word
 *
 * PORT NOTE (MEAL → CATHERINE): the MEAL micro-corpus and its synonym cases
 * ("money"→"balance", "rfid"→"card", "subsidy") are MEAL-domain vocabulary and
 * do NOT exist in CATHERINE's SYNONYMS. Every fixture here is re-tuned to the
 * REAL CATHERINE table in helpSearch.js — logs↔logging, metrics↔observability,
 * admin↔administrator, oracle↔database, session↔timeout — and to a neutral
 * micro-corpus of CATHERINE vocabulary. No peso (`₱`) anywhere.
 *
 * No mocks — every function here is pure. A fixed, tiny corpus keeps the
 * vocabulary assertions deterministic and independent of help.data changes.
 */

import { describe, expect, it } from "vitest";

import {
    FUZZY_MIN_LEN,
    STOP_WORDS,
    SYNONYMS,
    articleMatches,
    boundedLevenshtein,
    buildVocabulary,
    expandSynonyms,
    findSuggestion,
    fuzzyToleranceFor,
    scoreArticle,
    scoreTokens,
    stem,
    suggestionToleranceFor,
    tokenize,
} from "../../../src/features/support/help/helpSearch";

// ── Fixed micro-corpus (independent of help.data, CATHERINE vocabulary) ───────
const CORPUS = [
    {
        id: "cat-a",
        articles: [
            { id: "a1", question: "How does the app measure its own performance?", answer: "It records metrics for every route.", tags: ["metrics", "observability"] },
            { id: "a2", question: "How do I browse the audit logs?", answer: "Open the logging page.", tags: ["logging", "audit"] },
        ],
    },
];

describe("boundedLevenshtein", function () {
    it("returns 0 for identical strings", function () {
        expect(boundedLevenshtein("metrics", "metrics", 2)).toBe(0);
    });

    it("counts single-edit substitutions, insertions, and deletions", function () {
        expect(boundedLevenshtein("metrcs", "metrics", 2)).toBe(1); // insertion
        expect(boundedLevenshtein("metricss", "metrics", 2)).toBe(1); // deletion
        expect(boundedLevenshtein("metrisc", "metrics", 2)).toBe(2); // transposition = 2 edits
    });

    it("early-exits to max+1 once the true distance exceeds the ceiling", function () {
        // 'metrsic' is 2 edits from 'metrics'; with a ceiling of 1 the function
        // must NOT compute the real distance — it returns max+1 (=2) as a sentinel.
        expect(boundedLevenshtein("metrsic", "metrics", 1)).toBe(2);
        // A wildly different word also short-circuits on the length-diff guard.
        expect(boundedLevenshtein("giraffe", "hi", 2)).toBe(3);
    });
});

describe("tolerance policies", function () {
    it("fuzzyToleranceFor is STRICT — 0 below FUZZY_MIN_LEN, else 1", function () {
        expect(fuzzyToleranceFor("cat")).toBe(0); // 3 letters
        expect(fuzzyToleranceFor("logs")).toBe(1); // 4 letters (== FUZZY_MIN_LEN)
        expect(fuzzyToleranceFor("metrics")).toBe(1); // long word still only 1
        expect(FUZZY_MIN_LEN).toBe(4);
    });

    it("suggestionToleranceFor is LENIENT — 0 / 1 / 2 by length", function () {
        expect(suggestionToleranceFor("cat")).toBe(0); // < 4
        expect(suggestionToleranceFor("logs")).toBe(1); // 4–6
        expect(suggestionToleranceFor("oracle")).toBe(1); // 6
        expect(suggestionToleranceFor("metrics")).toBe(2); // 7 (>= two-edit threshold)
    });

    it("the two policies diverge exactly where the design depends on it", function () {
        // The whole "did you mean?" mechanism hinges on suggestion tolerance
        // being >= article tolerance for the SAME long word. If they were equal,
        // any suggestible word would already match an article and suppress the
        // suggestion. Guard that invariant explicitly.
        const word = "metrics";
        expect(suggestionToleranceFor(word)).toBeGreaterThan(fuzzyToleranceFor(word));
    });
});

describe("tokenize", function () {
    it("lowercases, strips punctuation, and drops stop-words", function () {
        expect(tokenize("how do i browse the audit logs?")).toEqual(["browse", "audit", "logs"]);
    });

    it("never returns empty — an all-stop-word query falls back to the raw words", function () {
        // "how do i" is entirely stop-words; dropping them would leave nothing,
        // so the raw words are kept rather than returning [].
        expect(tokenize("how do i")).toEqual(["how", "do", "i"]);
    });

    it("splits a decimal amount on the dot, dropping the tiny fraction token (no peso)", function () {
        // CATHERINE has no peso sign; money content is plain decimals. The search
        // tokenizer splits on non-alphanumerics and drops sub-length fragments,
        // so "1250.00" yields the searchable "1250" and the two-char "00" is
        // dropped as too short to be a meaningful token. (This is the search
        // tokenizer — distinct from AnswerBody's decimal-safe sentence splitter,
        // covered in helpFormulaSplitSentences.test.jsx.)
        expect(tokenize("1250.00 balance")).toEqual(["1250", "balance"]);
    });
});

describe("expandSynonyms", function () {
    it("adds curated aliases while retaining the originals (additive)", function () {
        const out = expandSynonyms(["logs"]);
        expect(out).toContain("logs"); // original kept
        expect(out).toContain("logging"); // alias added
        for (const alias of SYNONYMS.logs) expect(out).toContain(alias);
    });

    it("dedupes when two tokens expand to the same alias", function () {
        // 'logs' and 'logging' both alias to 'audit' — it must appear once.
        const out = expandSynonyms(["logs", "logging"]);
        expect(out.filter((w) => w === "audit")).toHaveLength(1);
    });

    it("passes a non-synonym token through, adding only its stem (no curated alias)", function () {
        // 'clustering' is not in the SYNONYMS table, so no curated alias is added.
        // expandSynonyms is stem-aware, so it also contributes the morphological
        // stem 'cluster'. The original is always retained.
        const out = expandSynonyms(["clustering"]);
        expect(out).toContain("clustering"); // original kept
        expect(out).toEqual(["clustering", "cluster"]); // stem added, nothing else
    });
});

describe("scoreTokens", function () {
    const haystack = "how does the app measure its own performance it records metrics for every route metrics observability";
    const words = new Set(haystack.split(/[^a-z0-9]+/i).filter(Boolean));

    it("scores an exact substring hit as 1 point", function () {
        expect(scoreTokens(haystack, ["metrics"], words)).toBe(1);
    });

    it("scores a bounded fuzzy hit as 0.5 — always below an exact hit", function () {
        // 'metrcs' is 1 edit from 'metrics': no substring hit, fuzzy fallback fires.
        expect(scoreTokens(haystack, ["metrcs"], words)).toBe(0.5);
    });

    it("returns 0 for an off-topic token so it is not a result", function () {
        expect(scoreTokens(haystack, ["giraffe"], words)).toBe(0);
    });

    it("runs exact-only when no word set is supplied (no fuzzy fallback)", function () {
        expect(scoreTokens(haystack, ["metrcs"])).toBe(0);
    });
});

describe("articleMatches", function () {
    const metricsArticle = CORPUS[0].articles[0];
    const logsArticle = CORPUS[0].articles[1];

    it("matches on an exact term", function () {
        expect(articleMatches(metricsArticle, ["metrics"])).toBe(true);
    });

    it("matches the logs article on the synonym-expanded 'observability' → 'metrics' is irrelevant; 'logs' → 'logging'", function () {
        expect(articleMatches(logsArticle, expandSynonyms(["logging"]))).toBe(true);
    });

    it("tolerates a one-edit typo", function () {
        expect(articleMatches(metricsArticle, ["metrcs"])).toBe(true);
    });

    it("rejects an off-topic query", function () {
        expect(articleMatches(metricsArticle, ["giraffe"])).toBe(false);
    });
});

describe("buildVocabulary", function () {
    const vocab = buildVocabulary(CORPUS);

    it("includes meaningful words of at least FUZZY_MIN_LEN", function () {
        expect(vocab.has("metrics")).toBe(true);
        expect(vocab.has("audit")).toBe(true);
        expect(vocab.has("logging")).toBe(true);
    });

    it("excludes stop-words and words shorter than FUZZY_MIN_LEN", function () {
        expect(vocab.has("how")).toBe(false); // stop-word
        expect(vocab.has("my")).toBe(false); // stop-word + too short
        expect(vocab.has("do")).toBe(false); // too short
        // Sanity: everything kept is long enough and not a stop-word.
        for (const w of vocab) {
            expect(w.length).toBeGreaterThanOrEqual(FUZZY_MIN_LEN);
            expect(STOP_WORDS.has(w)).toBe(false);
        }
    });
});

describe("findSuggestion", function () {
    const vocab = buildVocabulary(CORPUS);

    it("suggests the nearest real word for a garbled 2-edit query", function () {
        // 'metrsic' misses every article (2 edits) but is a suggestion-range
        // near-miss of 'metrics'.
        expect(findSuggestion(["metrsic"], vocab)).toBe("metrics");
    });

    it("returns null when the query IS already a real corpus word", function () {
        // No typo to correct — offering a suggestion would be noise.
        expect(findSuggestion(["metrics"], vocab)).toBeNull();
    });

    it("returns null for a word too short to fuzzy-match", function () {
        expect(findSuggestion(["cat"], vocab)).toBeNull();
    });

    it("returns null for a genuinely off-target word", function () {
        expect(findSuggestion(["giraffe"], vocab)).toBeNull();
    });

    it("considers the LONGEST token (most information-bearing)", function () {
        // The short 'my' is ignored; the correction targets 'metrsic'.
        expect(findSuggestion(["my", "metrsic"], vocab)).toBe("metrics");
    });

    it("corrects a typo even when an EARLIER token is already a real word", function () {
        // Old behaviour aborted on the first real word ('metrics') and returned
        // null. It must now skip the real word and still correct 'metrsic'.
        expect(findSuggestion(["metrics", "metrsic"], vocab)).toBe("metrics");
    });
});

// ── Smarter-search enhancements ─────────────────────────────────────────────

describe("stem", function () {
    it("chops one known suffix, longest-first (-ing before -s)", function () {
        expect(stem("caching")).toBe("cach");
        expect(stem("cached")).toBe("cach");
    });

    it("never chops below MIN_STEM_LEN — short roots survive", function () {
        expect(stem("logs")).toBe("logs"); // chopping -s → 'log' (3) is too short
        expect(stem("oracle")).toBe("oracle"); // no applicable suffix
    });

    it("is idempotent and pure — a stem re-stems to itself", function () {
        const once = stem("caching");
        expect(stem(once)).toBe(once);
    });
});

describe("expandSynonyms — stem + synonym awareness", function () {
    it("reaches synonyms when the raw token IS a synonym key ('logging')", function () {
        // 'logging' is a SYNONYMS key. Its aliases surface directly.
        const out = expandSynonyms(["logging"]);
        for (const alias of SYNONYMS.logging) expect(out).toContain(alias);
    });

    it("expands a CATHERINE domain alias to its long form ('oracle' → 'database')", function () {
        expect(expandSynonyms(["oracle"])).toContain("database");
    });

    it("expands 'metrics' to 'observability' (bidirectional CATHERINE alias)", function () {
        expect(expandSynonyms(["metrics"])).toContain("observability");
        expect(expandSynonyms(["observability"])).toContain("metrics");
    });

    it("passes an unknown token that is too short to stem through unchanged", function () {
        // 'xyz' is below MIN_STEM_LEN and is not a SYNONYMS key, so nothing is
        // added — it comes back exactly as given.
        expect(expandSynonyms(["xyz"])).toEqual(["xyz"]);
    });
});

describe("scoreArticle — field weighting + phrase proximity", function () {
    const metricsArticle = CORPUS[0].articles[0]; // tags: metrics, observability
    const logsArticle = CORPUS[0].articles[1]; // question: browse the audit logs; tags: logging, audit

    it("weights a TAG hit (3) above a QUESTION hit (2) above an ANSWER hit (1)", function () {
        // 'observability' is ONLY in a1's tags; 'records' is ONLY in a1's answer.
        const tagHit = scoreArticle(metricsArticle, ["observability"]); // tag(3)
        const answerHit = scoreArticle(metricsArticle, ["records"]); // answer only
        expect(tagHit).toBeGreaterThan(answerHit);
        expect(answerHit).toBe(1);
    });

    it("awards a phrase-proximity bonus for adjacent query tokens in the title", function () {
        // 'audit logs' IS adjacent in "browse the audit logs"; the reversed
        // order is not adjacent, so it earns no phrase bonus.
        const adjacent = scoreArticle(logsArticle, ["audit", "logs"]); // phrase bonus fires
        const scattered = scoreArticle(logsArticle, ["logs", "audit"]); // reversed → no adjacency
        expect(adjacent).toBeGreaterThan(scattered);
    });

    it("returns 0 for an off-topic query so it is not ranked", function () {
        expect(scoreArticle(metricsArticle, ["giraffe"])).toBe(0);
    });

    it("scores an exact hit above a fuzzy (typo) hit in the same field", function () {
        const exact = scoreArticle(metricsArticle, ["metrics"]); // tag exact → 3
        const fuzzy = scoreArticle(metricsArticle, ["metrcs"]); // tag fuzzy → 1.5
        expect(exact).toBeGreaterThan(fuzzy);
    });
});

describe("articleMatches — stem-aware", function () {
    it("matches an article on a synonym-expanded query ('audit' via logs alias)", function () {
        const logsArticle = CORPUS[0].articles[1];
        expect(articleMatches(logsArticle, expandSynonyms(["logs"]))).toBe(true);
    });
});
