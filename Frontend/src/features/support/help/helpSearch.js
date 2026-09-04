/**
 * helpSearch.js — Shared, deterministic search engine for the Help corpus.
 *
 * WHAT THIS FILE DOES
 * ───────────────────
 * The single source of truth for "chatbot-like" help search: synonym
 * expansion, bounded typo tolerance, relevance scoring, and "did you mean?"
 * suggestions. Both the full Help Center (features/support/help/help.hook.js)
 * and the global Help Assistant launcher (components/shared/HelpAssistant/)
 * import from here so the two surfaces behave IDENTICALLY — a query that finds
 * an article in the launcher finds the same article in the Help Center, and a
 * typo recovers the same way in both. No model, no network — a pure lookup, so
 * there is no hallucination surface.
 *
 * WHY A SHARED MODULE (Anti-Pattern Auditor)
 * ──────────────────────────────────────────
 * These helpers previously lived only in useHelpAssistant.js. The Help Center
 * had its own simpler substring matcher. Two consumers now need the same
 * intelligence, so the logic is extracted ONCE here (rule of three satisfied
 * by two real consumers plus the tests) rather than copy-pasted — copy-paste
 * of a 100-line scorer across two files is exactly the anti-pattern to avoid.
 *
 * COMPLEXITY (Performance)
 * ────────────────────────
 * Matching is O(n·k) over the visible corpus (n = articles, k = query tokens),
 * with a bounded fuzzy fallback only on substring misses. The suggestion scan
 * is O(v) in the vocabulary and runs ONLY on the zero-match path. At the ~200-
 * article scale no index is warranted; a Map/Set index would add invalidation
 * cost for no measurable gain on a bounded, static dataset.
 *
 * SECURITY (Cybersecurity)
 * ────────────────────────
 * Pure string operations over public, non-sensitive help text. No secrets,
 * tokens, or PII are indexed. No DOM injection — callers render through
 * AnswerBody (CWE-79 safe). No user-controlled navigation here (CWE-601).
 *
 * @module helpSearch
 */

/**
 * Very common English filler words that carry no search signal. Dropped from a
 * multi-word query so a natural-language question ("Why did my login fail?")
 * matches on its meaningful terms ("login", "fail") instead of failing because
 * no article literally contains the whole sentence.
 * @type {Set<string>}
 */
export const STOP_WORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "can", "did", "do", "does", "for", "from", "how", "i", "in", "is", "it", "me", "my", "of", "on", "or", "the", "to", "was", "what", "when", "where", "which", "who", "why", "will", "with", "you", "your"]);

/**
 * Curated synonym / alias map. Users rarely use the exact word the docs use
 * ("logs" vs. "logging", "admin" vs. "administrator"), so before scoring we
 * expand each query token with any known aliases. This is a deterministic,
 * hand-maintained table — NOT a model — so it never hallucinates a match: an
 * alias only fires when it is literally present in this map. Keys are the words
 * users TYPE; values are the words the corpus actually CONTAINS. Bidirectional
 * entries are listed both ways so either direction resolves.
 *
 * @type {Record<string, string[]>}
 */
export const SYNONYMS = {
    money: ["balance", "wallet", "funds", "amount", "currency"],
    cash: ["balance", "funds"],
    freeze: ["lock", "disable", "block"],
    unlock: ["enable", "unfreeze"],
    disable: ["lock", "freeze", "deactivate"],
    enable: ["unlock", "activate"],
    download: ["export", "save"],
    export: ["download", "extract"],
    theme: ["appearance", "dark", "light", "color", "palette"],
    dark: ["theme", "appearance", "night"],
    password: ["login", "credentials", "signin"],
    login: ["password", "signin", "credentials"],
    // ── CATHERINE domain aliases (the words users actually TYPE) ──
    // Users type one phrasing; the corpus spells it another way. Expanding each
    // direction means either phrasing finds the same article. Deterministic,
    // hand-maintained — never guesses an expansion that is not listed here.
    logs: ["logging", "log", "audit"],
    logging: ["logs", "log", "audit"],
    metrics: ["observability", "monitoring", "telemetry"],
    observability: ["metrics", "monitoring", "telemetry"],
    admin: ["administrator", "management", "rbac"],
    administrator: ["admin", "management", "rbac"],
    oracle: ["database", "db", "connection"],
    database: ["oracle", "db", "connection"],
    session: ["timeout", "token", "expiry"],
    timeout: ["session", "expiry"],
};

/**
 * Common English suffixes stripped by the light stemmer, longest-first so
 * "-ing" is tried before "-s". Deliberately tiny and conservative — this is a
 * suffix chopper, not a linguistic stemmer (no Porter algorithm), because on a
 * small curated corpus an over-eager stem creates more false matches than it
 * prevents misses. Order matters: the first suffix that leaves a stem of at
 * least MIN_STEM_LEN wins.
 * @type {string[]}
 */
const STEM_SUFFIXES = ["ing", "ered", "ed", "es", "s"];

/** Never stem below this many characters — protects short roots like "log". */
const MIN_STEM_LEN = 4;

/**
 * Minimum token length for a NAKED SUBSTRING match against the corpus. A token
 * shorter than this must match on a WHOLE-WORD boundary instead — because a
 * 2-char token like "re" (from tokenizing "re-sign") is a substring of half the
 * English language ("are", "more", "record", "score", …) and would make the
 * search feel like it matches everything. At/above this length a substring hit
 * is still allowed so a legitimate stem like "loggin" continues to find
 * "logging". Whole-word matching for short tokens keeps the corpus trustworthy
 * without losing any real match.
 * @type {number}
 */
export const MIN_SUBSTRING_LEN = 3;

/**
 * Does the query `token` match the `haystack` at all? Short tokens (below
 * MIN_SUBSTRING_LEN) must appear as a WHOLE WORD — bounded by non-word
 * characters — so they cannot substring-pollute unrelated words. Longer tokens
 * may match as a naked substring so stems ("loggin" → "logging") still land.
 *
 * The optional `haystackWords` set is the fast path for the whole-word case:
 * membership is O(1) and avoids building a per-call RegExp on the hot loop.
 * When it is omitted, a bounded word-boundary RegExp is used as a fallback.
 *
 * @param {string} haystack — lowercased "question answer tags" blob
 * @param {string} token — a single lowercased (already-expanded) query token
 * @param {Set<string>} [haystackWords] — optional pre-split corpus word set
 * @returns {boolean}
 */
export function haystackMatchesToken(haystack, token, haystackWords) {
    if (token.length >= MIN_SUBSTRING_LEN) return haystack.includes(token);
    // Short token → whole-word only.
    if (haystackWords) return haystackWords.has(token);
    return new RegExp(`(?:^|[^a-z0-9])${token}(?:$|[^a-z0-9])`, "i").test(haystack);
}

/**
 * Word-length thresholds for typo tolerance. A 3-letter word must match exactly
 * (else "cat" fuzz-matches "car"/"can"); a 4–6 letter word tolerates 1 edit
 * ("balnce" → "balance"); a 7+ letter word tolerates 2 in the SUGGESTION path
 * only. Bounded by word length so the false-positive rate stays low on a small
 * corpus.
 */
export const FUZZY_MIN_LEN = 4;
const FUZZY_LEN_FOR_TWO_EDITS = 7;

/**
 * Bounded Levenshtein edit distance with early-exit. Returns the number of
 * single-character insert/delete/substitute edits to turn `a` into `b`, but
 * stops and returns `max + 1` the moment the running minimum exceeds `max` —
 * we never need the true distance beyond the tolerance, so this keeps the cost
 * at O(a·b) worst case but usually far less. Pure function, no allocation
 * beyond two rolling rows.
 *
 * @param {string} a
 * @param {string} b
 * @param {number} max — tolerance ceiling; anything above returns max+1
 * @returns {number}
 */
export function boundedLevenshtein(a, b, max) {
    const la = a.length;
    const lb = b.length;
    if (Math.abs(la - lb) > max) return max + 1;
    let prev = new Array(lb + 1);
    let curr = new Array(lb + 1);
    for (let j = 0; j <= lb; j += 1) prev[j] = j;
    for (let i = 1; i <= la; i += 1) {
        curr[0] = i;
        let rowMin = curr[0];
        for (let j = 1; j <= lb; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
            if (curr[j] < rowMin) rowMin = curr[j];
        }
        if (rowMin > max) return max + 1;
        [prev, curr] = [curr, prev];
    }
    return prev[lb];
}

/**
 * Typo tolerance for MATCHING a token against an article's words. Deliberately
 * STRICT so the result list stays trustworthy: 0 (exact only) below
 * FUZZY_MIN_LEN, else at most 1 edit. A too-lenient article match makes the
 * corpus feel like it matches everything; a single-edit ceiling catches the
 * common slip ("balnce" → "balance") without pulling in loosely-related words.
 *
 * @param {string} word
 * @returns {number}
 */
export function fuzzyToleranceFor(word) {
    return word.length < FUZZY_MIN_LEN ? 0 : 1;
}

/**
 * Typo tolerance for the "did you mean?" SUGGESTION, which only runs when the
 * article match already found nothing. It is more LENIENT than article matching
 * (up to 2 edits for longer words) precisely because it is the last-resort
 * recovery: a word garbled enough to miss every article (e.g. "ballanse") can
 * still be recognised as a near-miss of a real term ("balance") and offered
 * back to the user. Separating the two policies is what lets the suggestion
 * fire at all — if it shared the strict article tolerance, any word close
 * enough to suggest would already have produced a result and suppressed it.
 *
 * @param {string} word
 * @returns {number}
 */
export function suggestionToleranceFor(word) {
    if (word.length < FUZZY_MIN_LEN) return 0;
    if (word.length < FUZZY_LEN_FOR_TWO_EDITS) return 1;
    return 2;
}

/**
 * Shortest query fragment that carries any search signal. A 1–2 char fragment
 * (e.g. the "re" left over from splitting "re-sign") is noise: it is a
 * substring of, or a standalone token inside, a huge slice of the corpus
 * (hyphenated words like "re-settlement" and contractions like "you're" both
 * emit a bare "re"), so matching on it makes the search feel like it matches
 * everything. Fragments this short are dropped exactly like stop-words.
 *
 * NOTE on 2-char domain terms ("db", "id"): these live in SYNONYMS and are
 * expanded to their long forms during expandSynonyms(), so dropping the raw
 * 2-char token here does NOT lose them. A genuinely meaningful bare 2-char
 * query is not something this curated corpus indexes.
 * @type {number}
 */
export const MIN_MEANINGFUL_TOKEN_LEN = 3;

/**
 * Split a raw query into meaningful, lowercased search tokens. Punctuation is
 * stripped; stop-words AND sub-signal short fragments (< MIN_MEANINGFUL_TOKEN_LEN)
 * are removed — unless doing so would leave nothing, in which case we fall back
 * to the raw word list so a query of only short/stop words (e.g. "how do i")
 * still has something to match/expand.
 *
 * Hyphens and apostrophes INSIDE a word are kept, so a hyphenated compound the
 * corpus treats as one lexical unit ("re-sign", "read-through", "real-time")
 * stays intact and matches only genuine occurrences of that compound — instead
 * of being shattered at the hyphen into a noise fragment ("re") that matches
 * half the corpus. Leading/trailing hyphens or quotes (from typing "-foo" or
 * "foo-") are trimmed so they never leak into a token.
 *
 * @param {string} raw — the trimmed, lowercased query
 * @returns {string[]}
 */
export function tokenize(raw) {
    const words = raw
        // Split only on separators that are NOT an intra-word hyphen/apostrophe.
        .split(/[^a-z0-9'-]+/i)
        // Trim any hyphen/apostrophe that ended up at a word edge ("re-" → "re").
        .map((w) => w.replace(/^['-]+|['-]+$/g, ""))
        .filter(Boolean);
    const meaningful = words.filter((w) => !STOP_WORDS.has(w) && w.length >= MIN_MEANINGFUL_TOKEN_LEN);
    return meaningful.length > 0 ? meaningful : words;
}

/**
 * Reduce a word to a conservative stem by chopping ONE known suffix, so tense
 * and plural variants collapse to a common form: "logging" / "logged" / "logs"
 * → "log". Longest suffix first; never chops below MIN_STEM_LEN. Returns the
 * word unchanged when no suffix applies or chopping would leave too short a
 * root. Idempotent and pure. This is what lets a query of "logging requests"
 * match an article that only says "log".
 *
 * @param {string} word — a single lowercased token
 * @returns {string} the stem, or the original word if none applies
 */
export function stem(word) {
    if (word.length <= MIN_STEM_LEN) return word;
    for (const suffix of STEM_SUFFIXES) {
        if (word.endsWith(suffix) && word.length - suffix.length >= MIN_STEM_LEN) {
            return word.slice(0, word.length - suffix.length);
        }
    }
    return word;
}

/**
 * Expand a token list with curated synonyms AND stem variants so a user's word
 * matches the corpus's word regardless of tense, plural, or vocabulary. Three
 * additive passes, all deduped via a Set:
 *   1. the original token (always kept),
 *   2. its stem (so "logging" reaches "log"),
 *   3. synonyms of BOTH the token and its stem (so "logging" reaches "audit"
 *      via log's alias list).
 * O(k) in the token count — SYNONYMS lookup and stem are each O(1)/O(len).
 *
 * @param {string[]} tokens
 * @returns {string[]}
 */
export function expandSynonyms(tokens) {
    const out = new Set();
    for (const token of tokens) {
        out.add(token);
        const stemmed = stem(token);
        if (stemmed !== token) out.add(stemmed);
        for (const key of stemmed !== token ? [token, stemmed] : [token]) {
            const aliases = SYNONYMS[key];
            if (aliases) for (const alias of aliases) out.add(alias);
        }
    }
    return [...out];
}

/**
 * Accumulate a relevance score for a pre-lowercased haystack against the
 * (synonym-expanded) query tokens. An exact substring hit scores 1; a bounded
 * fuzzy hit scores 0.5 so exact matches always outrank typo matches. This is
 * an OR / "best-match" score, not strict AND: a natural-language question
 * still surfaces on the tokens that DO match without being sunk by the ones
 * that do not. Score 0 = not a result, so an off-topic query returns nothing.
 *
 * @param {string} haystack — lowercased "question answer tags" blob
 * @param {string[]} tokens — meaningful query tokens (already synonym-expanded)
 * @param {Set<string>} [haystackWords] — optional pre-split word set for the
 *        bounded fuzzy fallback; omit it to run exact-substring only.
 * @returns {number} accumulated match score (0 = no match)
 */
export function scoreTokens(haystack, tokens, haystackWords) {
    let score = 0;
    for (const token of tokens) {
        if (haystackMatchesToken(haystack, token, haystackWords)) {
            score += 1;
            continue;
        }
        if (haystackWords) {
            const tol = fuzzyToleranceFor(token);
            if (tol > 0) {
                let hit = false;
                for (const word of haystackWords) {
                    // Compare the token AND its stem against each corpus word so
                    // a fuzzy match survives a tense/plural difference on top of
                    // a typo (e.g. "loggng" → stem "loggn" → "log").
                    if (boundedLevenshtein(token, word, tol) <= tol || boundedLevenshtein(stem(token), stem(word), tol) <= tol) {
                        hit = true;
                        break;
                    }
                }
                if (hit) score += 0.5;
            }
        }
    }
    return score;
}

/**
 * Field-weighted, phrase-aware relevance score for a single article — the
 * ranking function behind the launcher's ordered result list. Richer than
 * scoreTokens (which is the boolean/OR matcher): here WHERE a token hits
 * matters and CONSECUTIVE hits are rewarded, so the most on-topic article
 * floats to the top of a natural-language query.
 *
 * Weighting rationale (a title hit is a stronger relevance signal than a
 * passing mention buried in the answer body):
 *   • tag hit      → 3  (tags are curated keywords — the strongest signal)
 *   • question hit → 2  (the title is what the article is ABOUT)
 *   • answer hit   → 1  (body mention — weakest, but still a match)
 *   • fuzzy hit    → half the field weight (exact always outranks a typo)
 *   • phrase bonus → +2 when two or more query tokens appear ADJACENT in the
 *                    question (so "audit log" beats an article that merely
 *                    mentions "audit" and "log" paragraphs apart).
 *
 * Returns 0 for no match, so an off-topic query still yields nothing.
 * O(f·k) where f = fields (3, constant) and k = tokens — bounded and cheap.
 *
 * @param {import("./help.data").HelpArticle} article
 * @param {string[]} tokens — synonym+stem-expanded query tokens
 * @returns {number} weighted relevance score (0 = no match)
 */
export function scoreArticle(article, tokens) {
    const question = article.question.toLowerCase();
    const answer = article.answer.toLowerCase();
    const tagBlob = article.tags.join(" ").toLowerCase();

    const questionWords = new Set(question.split(/[^a-z0-9]+/i).filter(Boolean));
    const answerWords = new Set(answer.split(/[^a-z0-9]+/i).filter(Boolean));
    const tagWords = new Set(tagBlob.split(/[^a-z0-9]+/i).filter(Boolean));

    /** Exact substring (weight) else bounded/stem fuzzy (half weight) else 0.
     *  Short tokens are held to a whole-word match (see haystackMatchesToken)
     *  so "re" cannot substring-inflate an article's score across the board. */
    const fieldScore = (haystack, words, weight, token) => {
        if (haystackMatchesToken(haystack, token, words)) return weight;
        const tol = fuzzyToleranceFor(token);
        if (tol > 0) {
            for (const word of words) {
                if (boundedLevenshtein(token, word, tol) <= tol || boundedLevenshtein(stem(token), stem(word), tol) <= tol) {
                    return weight / 2;
                }
            }
        }
        return 0;
    };

    let score = 0;
    for (const token of tokens) {
        // Best single-field weight for this token (tags > question > answer).
        score += Math.max(fieldScore(tagBlob, tagWords, 3, token), fieldScore(question, questionWords, 2, token), fieldScore(answer, answerWords, 1, token));
    }

    // Phrase-proximity bonus: reward any two ORIGINAL query tokens that appear
    // adjacent in the question. Skipped for single-token queries (nothing to be
    // adjacent to). Cheap — one includes() per adjacent pair.
    if (tokens.length >= 2) {
        for (let i = 0; i < tokens.length - 1; i += 1) {
            if (question.includes(`${tokens[i]} ${tokens[i + 1]}`)) {
                score += 2;
                break; // one phrase bonus is enough; avoid runaway stacking
            }
        }
    }

    return score;
}

/**
 * Does this article match the query at all? A convenience boolean wrapper over
 * scoreTokens for the Help Center's category-filter use case, which needs a
 * yes/no per article rather than a ranked score. Runs synonym expansion and the
 * bounded fuzzy fallback so it behaves exactly like the launcher's matcher.
 *
 * @param {import("./help.data").HelpArticle} article
 * @param {string[]} tokens — synonym-expanded query tokens
 * @returns {boolean}
 */
export function articleMatches(article, tokens) {
    const haystack = `${article.question} ${article.answer} ${article.tags.join(" ")}`.toLowerCase();
    if (haystack.includes(tokens.join(" "))) return true; // fast path
    const haystackWords = new Set(haystack.split(/[^a-z0-9]+/i).filter(Boolean));
    return scoreTokens(haystack, tokens, haystackWords) > 0;
}

/**
 * Build a deduped vocabulary set from a list of categories' article questions +
 * tags — the candidate pool for "did you mean?" suggestions. Only words of at
 * least FUZZY_MIN_LEN that are not stop-words are included, so the suggestion
 * never proposes a filler word. Callers should memoise this per role change,
 * not per keystroke.
 *
 * @param {import("./help.data").HelpCategory[]} categories — the VISIBLE (role-gated) categories
 * @returns {Set<string>}
 */
export function buildVocabulary(categories) {
    const vocab = new Set();
    for (const cat of categories) {
        for (const article of cat.articles) {
            const blob = `${article.question} ${article.tags.join(" ")}`.toLowerCase();
            for (const word of blob.split(/[^a-z0-9]+/i)) {
                if (word.length >= FUZZY_MIN_LEN && !STOP_WORDS.has(word)) vocab.add(word);
            }
        }
    }
    return vocab;
}

/**
 * Find the closest real corpus word to a mistyped query — the "did you mean?"
 * candidate. Tries EVERY query token (longest-first, since a longer token
 * carries more signal and its edit distance is more discriminating) and returns
 * the closest vocabulary word across all of them. A token that is ALREADY a real
 * corpus word is skipped rather than aborting the whole search, so a mixed query
 * like "balance ballanse" still corrects the typo instead of bailing on the
 * first real word. Returns null when nothing is close enough, so the caller
 * shows a plain "no results" rather than a misleading guess.
 *
 * O(t·v) — t query tokens (tiny) × v vocabulary (bounded by the corpus).
 * Intended to run ONCE on the zero-match path only — never per article, never
 * on the happy path.
 *
 * @param {string[]} tokens — the raw (non-synonym-expanded) query tokens
 * @param {Set<string>} vocabulary — deduped corpus word set
 * @returns {string|null} the suggested word, or null if no close match
 */
export function findSuggestion(tokens, vocabulary) {
    // Longest tokens first: they are the most information-bearing and their
    // edit distance is the least ambiguous. A copy keeps the caller's array
    // order intact (no in-place sort side effect).
    const ordered = [...tokens].sort((a, b) => b.length - a.length);

    let best = null;
    let bestDist = Infinity;
    for (const candidate of ordered) {
        const tol = suggestionToleranceFor(candidate);
        if (tol === 0) continue; // too short to fuzzy-correct
        if (vocabulary.has(candidate)) continue; // already a real word — skip, don't abort

        for (const word of vocabulary) {
            const d = boundedLevenshtein(candidate, word, tol);
            if (d <= tol && d < bestDist) {
                best = word;
                bestDist = d;
                if (d === 1) return best; // single-edit match is as good as it gets
            }
        }
    }
    return best;
}
