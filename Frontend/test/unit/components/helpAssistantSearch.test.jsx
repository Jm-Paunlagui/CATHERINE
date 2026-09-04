/**
 * helpAssistantSearch.test.jsx — the Help Assistant's "feels like a chatbot"
 * search intelligence: synonym expansion, typo tolerance, and the "did you
 * mean?" recovery on a zero-match query.
 *
 * WHY THESE TESTS EXIST
 * ─────────────────────
 * The launcher is a DETERMINISTIC lookup dressed up as a chatbot — no model,
 * so its intelligence lives entirely in the ranking code. These behaviours are
 * the difference between "sorry, nothing found" and a helpful assistant:
 *   1. a synonym ("dark") surfaces the appearance article via its "theme" tag,
 *   2. a small typo ("passwrd") still surfaces the "password" article,
 *   3. a garbled-but-close word ("passwrod") yields a "did you mean?"
 *      suggestion instead of a dead end.
 *
 * PORT NOTE (MEAL → CATHERINE): every example query is retuned to CATHERINE's
 * tier-0 corpus vocabulary — MEAL's "freeze my card" / "subsidy" / "balance"
 * do not exist here. No peso.
 *
 * HARNESS
 * ───────
 * Network is mocked ONLY at the MSW boundary via loginAs() — AuthMiddleware/
 * HttpClient are never stubbed. We log in as USER (tier 0) so the visible corpus
 * is the stable, public, general-tier set. The hook is exercised through
 * renderHook under a MemoryRouter (it calls useNavigate/useLocation). Query is
 * driven with act(); results are awaited with waitFor because the resolved role
 * (and therefore the visible corpus) settles one tick after mount.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { useHelpAssistant } from "../../../src/components/shared/HelpAssistant/useHelpAssistant";
import { loginAs } from "../../helpers/auth.js";
import { invalidateCache } from "../../../src/hooks/useRequest";

function wrapper({ children }) {
    return <MemoryRouter>{children}</MemoryRouter>;
}

/** Render the hook logged in as a tier-0 USER and wait until the role resolves. */
async function renderReady() {
    loginAs("USER");
    const view = renderHook(() => useHelpAssistant(), { wrapper });
    await waitFor(() => expect(view.result.current.isReady).toBe(true));
    return view;
}

describe("Help Assistant search — chatbot-like intelligence", function () {
    beforeEach(function () {
        // AuthMiddleware.isAuth() caches auth/me for 5 min via the useRequest
        // singleton; a prior test's cached user would otherwise leak in.
        invalidateCache();
    });

    it("surfaces the dark-mode appearance article for the SYNONYM 'dark'", async function () {
        const { result } = await renderReady();
        act(() => result.current.setQuery("dark"));
        await waitFor(() => expect(result.current.results.length).toBeGreaterThan(0));

        const questions = result.current.results.map((r) => r.article.question.toLowerCase());
        // "dark" is a curated alias of "theme"/"appearance"; the appearance
        // articles surface (the dark-mode article is the strongest hit).
        expect(questions.some((q) => q.includes("light and dark mode"))).toBe(true);
    });

    it("tolerates a small TYPO — 'passwrd' recovers straight into results via fuzzy match", async function () {
        const { result } = await renderReady();
        // 'passwrd' is ONE edit from 'password' (a real corpus tag), within the
        // strict article-match tolerance, so it recovers directly into results
        // with no dead end and no suggestion needed.
        act(() => result.current.setQuery("passwrd"));
        await waitFor(() => expect(result.current.results.length).toBeGreaterThan(0));

        const blob = result.current.results
            .map((r) => `${r.article.question} ${r.article.tags.join(" ")}`)
            .join(" ")
            .toLowerCase();
        expect(blob).toContain("password");
        expect(result.current.suggestion).toBeNull();
    });

    it("offers a 'did you mean?' suggestion when a word is too garbled to match any article", async function () {
        const { result } = await renderReady();
        // 'passwrod' is TWO edits from 'password' — beyond the strict article
        // tolerance (1), so no article scores > 0 → a true zero-match. But the
        // more-lenient suggestion tolerance (2) still recognises it as a
        // near-miss of a real term, so the recovery suggestion fires.
        act(() => result.current.setQuery("passwrod"));
        await waitFor(() => expect(result.current.suggestion).toBe("password"));
        expect(result.current.results).toEqual([]);
    });

    it("applySuggestion() rewrites the query to the correction and recovers results", async function () {
        const { result } = await renderReady();
        act(() => result.current.setQuery("passwrod"));
        await waitFor(() => expect(result.current.suggestion).toBe("password"));

        act(() => result.current.applySuggestion());
        expect(result.current.query).toBe("password");
        await waitFor(() => expect(result.current.results.length).toBeGreaterThan(0));
    });

    it("returns NOTHING and no suggestion for a genuinely off-topic query", async function () {
        const { result } = await renderReady();
        act(() => result.current.setQuery("purple giraffe"));
        // No exact match, no fuzzy match, and nothing in the corpus is one edit
        // from either word — so results stay empty and no misleading guess is made.
        await waitFor(() => expect(result.current.hasQuery).toBe(true));
        expect(result.current.results).toEqual([]);
        expect(result.current.suggestion).toBeNull();
    });
});
