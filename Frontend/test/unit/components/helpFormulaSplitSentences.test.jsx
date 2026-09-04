/**
 * helpFormulaSplitSentences.test.jsx — regression guard for the "so many 00"
 * decimal-rendering bug in the Help answer chunker.
 *
 * The Help answer auto-chunker (AnswerBody) splits long answers into paragraphs
 * on sentence boundaries. The original `/[^.!?]+[.!?]+/g` splitter treated the
 * decimal point in an amount ("1,250.00") as a sentence terminator, orphaning
 * the "00" fragment at the start of the next chunk — the stray "00" users
 * reported. The private `splitSentences` scanner now treats an inter-digit dot
 * as ordinary content.
 *
 * PORT NOTE (MEAL → CATHERINE):
 *   1. `splitSentences` was made MODULE-PRIVATE in HelpFormula.jsx (no longer
 *      exported). MEAL imported it directly; here we exercise it THROUGH the
 *      public `AnswerBody` render output — the only consumer — and assert on the
 *      rendered paragraphs.
 *   2. Every `₱` (peso) assertion is DROPPED — CATHERINE has no peso. The
 *      decimal-integrity guarantee (e.g. "1250.00" not split on the dot) is
 *      still asserted, on bare decimals.
 *
 * AnswerBody auto-chunks only when `chunk` is true AND the answer has more than
 * `chunkThreshold` (default 3) sentences, grouping `perChunk` (default 2)
 * sentences per <p>. Each test renders with `chunk` on so the splitter runs,
 * then asserts on the resulting paragraph text.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AnswerBody } from "../../../src/features/support/help/components/HelpFormula";

/** All rendered paragraph texts, in document order. */
function paragraphs() {
    return Array.from(document.querySelectorAll("p")).map((p) => p.textContent ?? "");
}

describe("AnswerBody / splitSentences — decimal-safe sentence splitting", () => {
    it("never orphans the fraction of a two-decimal amount into a bare '00' paragraph", () => {
        // Four sentences so chunk (perChunk=2) produces multiple <p> — the exact
        // condition under which the old splitter orphaned the "00".
        const text = "Your balance is 1,250.00 today. Thanks for checking in. It updates live. Nothing else to do.";
        render(<AnswerBody text={text} chunk perChunk={2} />);

        const paras = paragraphs();
        // No paragraph may START with a stray "00" — that was the reported bug.
        expect(paras.some((p) => /^\s*00\b/.test(p))).toBe(false);
        // The whole amount survives intact inside one paragraph.
        expect(paras.some((p) => p.includes("1,250.00"))).toBe(true);
        // Lossless: joined paragraphs equal the source (trimmed round-trip).
        expect(paras.join(" ").replace(/\s+/g, " ").trim()).toBe(text.replace(/\s+/g, " ").trim());
    });

    it("keeps multiple decimals in one sentence intact", () => {
        const text = "The breakdown is 2,040.00 earned plus 111.00 carried over. That is the running total. It never rounds. Refresh to confirm.";
        render(<AnswerBody text={text} chunk perChunk={2} />);

        const paras = paragraphs();
        expect(paras.some((p) => /^\s*00\b/.test(p))).toBe(false);
        expect(paras.some((p) => p.includes("2,040.00 earned plus 111.00 carried over."))).toBe(true);
    });

    it("still splits on genuine sentence ends (period + space)", () => {
        // Four short sentences → chunk into two paragraphs of two sentences each.
        const text = "First point here. Second point here. Third point here. Fourth point here.";
        render(<AnswerBody text={text} chunk perChunk={2} />);
        expect(paragraphs()).toHaveLength(2);
    });

    it("does not split on a decimal followed by a letter (3.14x)", () => {
        const text = "The value 3.14x is fine here. It stays on one line. Nothing breaks it. All good.";
        render(<AnswerBody text={text} chunk perChunk={4} />);
        // perChunk=4 groups all four sentences into ONE paragraph; the decimal
        // and the "3.14x" must stay intact.
        const paras = paragraphs();
        expect(paras).toHaveLength(1);
        expect(paras[0]).toContain("3.14x");
    });

    it("round-trips a 0.00 zero-value amount without producing a bare 00", () => {
        const text = "It shows 0.00 when the ledger is empty. Then it updates on the next tap. Nothing is lost. Check again shortly.";
        render(<AnswerBody text={text} chunk perChunk={2} />);

        const paras = paragraphs();
        expect(paras.some((p) => /^\s*00\b/.test(p))).toBe(false);
        expect(paras.some((p) => p.includes("0.00"))).toBe(true);
    });

    it("renders a short answer as a single unmodified paragraph (no chunking below threshold)", () => {
        // Two sentences ≤ chunkThreshold (3) → one paragraph, splitter effectively inert.
        const text = "This is short. It stays whole.";
        render(<AnswerBody text={text} chunk />);
        expect(paragraphs()).toHaveLength(1);
    });

    it("author-inserted blank lines always win over auto-chunking", () => {
        const text = "First paragraph with a decimal 12.50 inside it.\n\nSecond paragraph entirely separate.";
        render(<AnswerBody text={text} />);
        const paras = paragraphs();
        expect(paras).toHaveLength(2);
        expect(paras[0]).toContain("12.50");
        expect(screen.getByText(/Second paragraph entirely separate\./)).toBeInTheDocument();
    });
});
