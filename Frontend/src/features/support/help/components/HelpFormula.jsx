/**
 * HelpFormula.jsx — Reusable formula and definition components for the Help Center.
 *
 * These are tier-1 components (used only within the help feature). They render
 * formulas, variable definitions, and worked examples using Aumovio design
 * tokens and theme-aware colours.
 *
 * No dangerouslySetInnerHTML — all content is static JSX (CWE-79 safe).
 */

import { BASE_COLOR_TEXT, STANDARD_BORDER } from "../../../../assets/styles/pre-set-styles";
import Badge from "../../../../components/ui/Badge";

/**
 * Colour accent classes for a DefList term. Each entry gives the term-label
 * text colour and the left accent-bar border colour, tuned for both themes.
 * Keys mirror the Badge variant names used across the help data (`color` prop).
 */
// Palette-adaptive families (orange/blue/purple) use the contrast-safe
// --*-foreground text token so the DefList term label is always legible on
// vivid/pale palettes; semantic families (green/red/grey) keep fixed anchors.
const DEFLIST_ACCENT = {
    orange: { text: "text-(--accent-foreground)", bar: "border-orange-400/60 dark:border-orange-400/50" },
    blue: { text: "text-(--blue-foreground)", bar: "border-blue-400/60 dark:border-blue-400/50" },
    green: { text: "text-success-600 dark:text-success-300", bar: "border-success-400/60 dark:border-success-400/50" },
    red: { text: "text-danger-600 dark:text-danger-300", bar: "border-danger-400/60 dark:border-danger-400/50" },
    purple: { text: "text-(--secondary-foreground)", bar: "border-purple-400/60 dark:border-purple-400/50" },
    grey: { text: "text-grey-600 dark:text-grey-300", bar: "border-grey-400/60 dark:border-grey-500/50" },
};

// ── Formula block ─────────────────────────────────────────────────────────────

/**
 * Renders a formula in a styled code-like block.
 *
 * @param {object} props
 * @param {React.ReactNode} props.children — the formula content
 * @param {string} [props.label] — optional label above the formula (e.g., "Formula")
 */
export function Formula({ children, label }) {
    return (
        <div className="my-2">
            {label && <span className={`block text-[10px] uppercase tracking-widest font-semibold ${BASE_COLOR_TEXT} opacity-40 mb-1`}>{label}</span>}
            <div className={`font-mono text-sm leading-relaxed p-4 rounded-lg bg-purple-400/5 dark:bg-purple-400/10 border border-purple-400/15 dark:border-purple-400/20 text-(--secondary-foreground)`}>{children}</div>
        </div>
    );
}

// ── Variable definition list ──────────────────────────────────────────────────

/**
 * Renders a list of variable definitions (name → description).
 *
 * @param {object} props
 * @param {Array<{ name: string, desc: string, color?: string }>} props.items
 * @param {string} [props.label] — optional label above the list
 */
export function DefList({ items, label }) {
    return (
        <div className="my-2">
            {label && <span className={`block text-[10px] uppercase tracking-widest font-semibold ${BASE_COLOR_TEXT} opacity-40 mb-1.5`}>{label}</span>}
            <dl className="space-y-2.5">
                {items.map((item) => {
                    const accent = DEFLIST_ACCENT[item.color] ?? DEFLIST_ACCENT.purple;
                    return (
                        <div key={item.name} className={`border-l-2 pl-3 ${accent.bar}`}>
                            <dt className={`font-mono text-xs font-semibold leading-snug ${accent.text}`}>{item.name}</dt>
                            <dd className={`mt-0.5 text-sm leading-relaxed ${BASE_COLOR_TEXT} opacity-65`}>{item.desc}</dd>
                        </div>
                    );
                })}
            </dl>
        </div>
    );
}

// ── Worked example ────────────────────────────────────────────────────────────

/**
 * Maps the WorkedExample's semantic variant names to the concrete variant keys
 * the Badge component understands. Badge has no "success"/"danger"/"info" keys —
 * it uses green/red/blue — so passing the semantic name straight through fell
 * through Badge's `V[variant] ?? V.grey` fallback and rendered grey regardless
 * of the variant the caller asked for. Translate here so every call site keeps
 * its readable semantic name AND gets the right colour.
 */
const EXAMPLE_BADGE_VARIANT = {
    success: "green",
    danger: "red",
    warn: "warning",
    warning: "warning",
    info: "blue",
    blue: "blue",
    green: "green",
    red: "red",
    purple: "purple",
    orange: "orange",
    grey: "grey",
};

/**
 * Renders a worked example with a scenario description and step-by-step values.
 *
 * @param {object} props
 * @param {string} props.title — scenario title (e.g., "First failed login")
 * @param {("success"|"danger"|"warn"|"info"|"blue"|"green"|"red"|"purple"|"orange"|"grey")} [props.variant="blue"]
 *   — colour of the "Example" badge. Semantic names (success/danger/warn/info)
 *   are mapped to Badge's colour keys; unknown values fall back to grey.
 * @param {Array<{ label: string, value: string }>} props.steps — computation steps
 * @param {string} [props.result] — final result summary
 */
export function WorkedExample({ title, variant = "blue", steps, result }) {
    const badgeVariant = EXAMPLE_BADGE_VARIANT[variant] ?? "grey";
    return (
        <div className={`my-2 rounded-lg ${STANDARD_BORDER} overflow-hidden`}>
            <div className="p-4 bg-grey-50 dark:bg-white/3 flex items-center gap-2">
                <Badge variant={badgeVariant} size="xs" pill>
                    Example
                </Badge>
                <span className={`text-xs font-semibold ${BASE_COLOR_TEXT} opacity-75`}>{title}</span>
            </div>
            <div className="p-4 space-y-1">
                {steps.map((step, i) => (
                    <div key={i} className="flex items-center justify-between gap-4 text-xs">
                        <span className={`${BASE_COLOR_TEXT} opacity-55`}>{step.label}</span>
                        <span className="font-mono font-semibold text-black/80 dark:text-white/85 tabular-nums">{step.value}</span>
                    </div>
                ))}
                {result && (
                    <>
                        <div className="border-t border-grey-200 dark:border-white/10 my-1.5" />
                        <div className="flex items-center justify-between gap-4 text-xs">
                            <span className={`font-semibold ${BASE_COLOR_TEXT} opacity-75`}>Result</span>
                            <span className="font-mono font-bold text-(--accent-foreground)">{result}</span>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

// ── Info callout ──────────────────────────────────────────────────────────────

/**
 * Renders a small info callout box.
 *
 * @param {object} props
 * @param {React.ReactNode} props.children
 * @param {"info"|"warn"|"success"} [props.variant="info"]
 */
export function Callout({ children, variant = "info" }) {
    const styles = {
        info: "bg-blue-400/5 dark:bg-blue-400/10 border-blue-400/20 text-(--blue-foreground)",
        warn: "bg-warn-400/5 dark:bg-warn-400/10 border-warn-400/20 text-warn-500 dark:text-warn-300",
        success: "bg-success-400/5 dark:bg-success-400/10 border-success-400/20 text-success-500 dark:text-success-300",
    };

    return <div className={`my-2 p-4 rounded-lg border text-sm leading-relaxed ${styles[variant] ?? styles.info}`}>{children}</div>;
}

// ── Inline highlight ──────────────────────────────────────────────────────────

/**
 * Highlights a phrase that directly answers the reader's question — a "strong
 * point" that a skimmer must not miss. Theme-aware (amber accent in light,
 * softened in dark) and CWE-79 safe (children are static JSX, never raw HTML).
 *
 * HIGHLIGHT THE ANSWER SKELETON, NOT JUST ONE PHRASE.
 * A help article exists to answer ONE question. Highlight EVERY strong point
 * that answers it — the specific words the reader came looking for — so that
 * reading only the highlighted chips gives the complete answer. Multiple
 * highlights per article are not only allowed, they are the goal: the chips are
 * the TL;DR of the explanation.
 *
 * What makes a phrase a "strong point" (highlight it):
 *   - It is the direct answer, a decisive condition, a number/limit, a
 *     guarantee, a warning, or the one action the reader must take.
 *   - Removing it would leave the question half-answered.
 *
 * What is NOT a strong point (leave it plain):
 *   - Connective prose, restatements of the question, background/context, or
 *     softening ("in almost every case", "as mentioned above"). Highlighting
 *     filler dilutes the chips and the skeleton stops reading as an answer.
 *
 * Keep each chip TIGHT — the 3–8 word core of the point, not the whole clause.
 * Ten tight, meaningful chips read as an answer; three rambling ones read as
 * random emphasis. Highlight the points, trim the words.
 *
 * TONE SELECTION IS A UI/UX DECISION, NOT A DECORATION:
 *   - On a NEUTRAL surface (the plain answer body), use a semantic tone
 *     (`good`/`bad`/`key`). The paragraph has no colour of its own, so one
 *     accent per point creates a clean focal point.
 *   - INSIDE a coloured `Callout` (success/warn/info) use `tone="plain"`. A
 *     green highlight inside a green callout has almost no contrast against its
 *     own container and reads as visual noise, not emphasis. The neutral tone
 *     keeps the phrase legible as "the key words" without stacking a second
 *     colour onto an already-coloured box. Emphasis needs contrast against its
 *     container, not agreement with it.
 *
 * @param {object} props
 * @param {React.ReactNode} props.children — the phrase to emphasise
 * @param {"key"|"good"|"bad"|"plain"} [props.tone="key"] — key (accent),
 *   good (green), bad (red), plain (neutral — for use inside coloured callouts).
 */
export function Mark({ children, tone = "key" }) {
    const tones = {
        key: "bg-orange-400/15 text-(--accent-foreground) dark:bg-orange-400/20",
        good: "bg-success-400/15 text-success-600 dark:bg-success-400/20 dark:text-success-300",
        bad: "bg-danger-400/15 text-danger-600 dark:bg-danger-400/20 dark:text-danger-300",
        // Neutral: inherits the callout's own text colour, adds only weight and a
        // faint contrast wash. Theme-aware via currentColor + black/white washes.
        plain: "bg-current/10 dark:bg-white/10 font-semibold",
    };
    return <mark className={`rounded px-1 py-px font-semibold ${tones[tone] ?? tones.key}`}>{children}</mark>;
}

// ── Plain-answer renderer (highlighting + chunking) ───────────────────────────

/**
 * Escapes a string for safe use inside a RegExp. Prevents a phrase containing
 * regex metacharacters (e.g. "(provisional)", "one-for-one") from being
 * interpreted as a pattern.
 *
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Wraps every occurrence of each `highlight` phrase in `text` with a
 * theme-aware <mark>, returning an array of strings and <mark> nodes.
 *
 * SAFETY: the phrases are AUTHOR-CHOSEN (passed explicitly per article), never
 * auto-detected. That is what keeps this from breaking the Help content tests —
 * a phrase is only ever split into <mark> when the author asked for it, so it
 * can never accidentally land inside a `findByText` substring on some other
 * article. The raw `text` (and thus the search index) is never mutated; marking
 * happens only at render time.
 *
 * CWE-79 safe: builds React nodes from plain string slices — no raw HTML.
 *
 * @param {string} text
 * @param {Array<string|{phrase:string, tone?:"key"|"good"|"bad"}>} phrases
 * @returns {React.ReactNode[]}
 */
function markPhrases(text, phrases) {
    const list = (phrases ?? [])
        .map((p) => (typeof p === "string" ? { phrase: p, tone: "key" } : { tone: "key", ...p }))
        .filter((p) => p.phrase);
    if (list.length === 0) return [text];

    // Longest phrases first so a phrase that contains another is matched whole.
    list.sort((a, b) => b.phrase.length - a.phrase.length);
    const toneByPhrase = new Map(list.map((p) => [p.phrase, p.tone]));
    const pattern = new RegExp(`(${list.map((p) => escapeRegExp(p.phrase)).join("|")})`, "g");

    const nodes = [];
    let last = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
        if (m.index > last) nodes.push(text.slice(last, m.index));
        nodes.push(
            <Mark key={`${m.index}-${m[0]}`} tone={toneByPhrase.get(m[0]) ?? "key"}>
                {m[0]}
            </Mark>,
        );
        last = m.index + m[0].length;
    }
    if (last < text.length) nodes.push(text.slice(last));
    return nodes;
}

/**
 * Splits prose into sentences WITHOUT ever breaking inside a decimal amount.
 *
 * The naive `/[^.!?]+[.!?]+/g` splitter treats the decimal point in "1,250.00"
 * as a sentence terminator, orphaning the "00" fragment at the start of the next
 * auto-chunked paragraph. This scanner keeps a `.` that is sandwiched between
 * digits (any decimal: 0.00, 1.50, 12.34) as ordinary sentence content, so
 * amounts stay intact regardless of how many values an answer contains.
 *
 * A run ends at a `.`/`!`/`?` (or a cluster like "?!") only when the character
 * immediately AFTER the cluster is whitespace or end-of-string AND the `.` is
 * not an inter-digit decimal point. Everything up to and including the
 * terminator + trailing whitespace is one sentence, matching the original
 * `join("")`-round-trip contract used by the chunker.
 *
 * O(n) time, O(n) space — n = text length, single left-to-right pass.
 *
 * @param {string} text — the raw answer string
 * @returns {string[]} sentences, each retaining its trailing punctuation + space
 */
// Module-private: only AnswerBody consumes it. Not exported, so this file keeps
// a components-only public surface (react-refresh/only-export-components).
function splitSentences(text) {
    const out = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch !== "." && ch !== "!" && ch !== "?") continue;

        // A decimal point sits between two digits — never a sentence end.
        const isDecimalDot = ch === "." && /\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "");
        if (isDecimalDot) continue;

        // Consume a terminator cluster ("?!", "...", "!?").
        let j = i;
        while (j + 1 < text.length && (text[j + 1] === "." || text[j + 1] === "!" || text[j + 1] === "?")) j++;

        // Valid sentence end only when followed by whitespace or end-of-string.
        const after = text[j + 1];
        if (after === undefined || /\s/.test(after)) {
            let end = j + 1;
            while (end < text.length && /\s/.test(text[end])) end++; // absorb trailing space
            out.push(text.slice(start, end));
            start = end;
            i = end - 1;
        } else {
            i = j; // skip the cluster, not a real boundary (e.g. "3.14x")
        }
    }
    if (start < text.length) out.push(text.slice(start));
    return out.length ? out : [text];
}

/**
 * Renders a plain-string `article.answer` as one or more readable paragraphs,
 * with optional theme-aware highlighting of key phrases.
 *
 * Both extras are OPT-IN and OFF BY DEFAULT, so every article that does not set
 * them renders as a single unmodified <p> — no visual regression and no impact
 * on the Help search index or the `findByText` content tests.
 *
 * CHUNKING — an answer is broken into paragraphs when EITHER:
 *   - the source string already contains a blank-line break (`\n\n`), which the
 *     author inserted deliberately; OR
 *   - `chunk` is true AND the answer is long (> `chunkThreshold` sentences), in
 *     which case sentences are grouped `perChunk` at a time.
 *
 * HIGHLIGHTING — pass `highlight` with the exact phrases to emphasise. Each is
 * wrapped in a theme-aware <mark> (see {@link Mark}).
 *
 * CWE-79 safe: plain strings only, never raw HTML.
 *
 * @param {object} props
 * @param {string} props.text — the raw `article.answer` string
 * @param {boolean} [props.chunk=false] — auto-chunk a long answer into paragraphs
 * @param {number} [props.perChunk=2] — sentences per auto-chunked paragraph
 * @param {number} [props.chunkThreshold=3] — min sentences before auto-chunking
 * @param {Array<string|{phrase:string, tone?:"key"|"good"|"bad"}>} [props.highlight]
 *   — exact phrases to wrap in a theme-aware highlight
 */
export function AnswerBody({ text, chunk = false, perChunk = 2, chunkThreshold = 3, highlight }) {
    // 1) Author-inserted blank lines always win.
    let paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

    // 2) Otherwise, auto-chunk long answers only when asked to.
    if (paragraphs.length === 1 && chunk) {
        const sentences = splitSentences(text);
        if (sentences.length > chunkThreshold) {
            paragraphs = [];
            for (let i = 0; i < sentences.length; i += perChunk) {
                paragraphs.push(sentences.slice(i, i + perChunk).join("").trim());
            }
        }
    }

    const render = (para, i) => (
        <p key={i} className={`text-sm leading-relaxed ${BASE_COLOR_TEXT} opacity-70`}>
            {markPhrases(para, highlight)}
        </p>
    );

    if (paragraphs.length <= 1) return render(text, 0);
    return <div className="space-y-3">{paragraphs.map(render)}</div>;
}
