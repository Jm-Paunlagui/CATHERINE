/**
 * helpCenterSearch.test.jsx — the full Help Center page shares the SAME search
 * intelligence as the launcher: synonym expansion, typo tolerance, and the
 * "did you mean?" recovery on a zero-match query.
 *
 * WHY THESE TESTS EXIST
 * ─────────────────────
 * The launcher and the Help Center must search IDENTICALLY. Both consume the
 * shared `helpSearch` engine via `useHelp`, and this test proves the parity
 * holds:
 *   1. a synonym ("dark") surfaces the appearance article via its "theme" tag,
 *   2. a small typo ("passwrd") still surfaces the "password" article via fuzzy,
 *   3. a garbled-but-close word ("passwrod", 2 edits) yields a "did you mean?"
 *      suggestion instead of a dead end,
 *   4. applying the suggestion recovers into real results,
 *   5. a genuinely off-topic query stays empty with no misleading suggestion.
 *
 * PORT NOTE (MEAL → CATHERINE): every example query is retuned to CATHERINE's
 * tier-0 corpus vocabulary (password, sessions, appearance/theme) — MEAL's
 * "freeze my card" / "balance" articles do not exist here. No peso.
 *
 * HARNESS
 * ───────
 * Network mocked ONLY at the MSW boundary via loginAs() (AuthMiddleware/
 * HttpClient never stubbed). Logged in as USER (tier 0) for the stable public
 * corpus. The hook runs under MemoryRouter because useHelp reads/writes URL
 * search params. Query is driven through the hook's own setSearchQuery so URL
 * sync + trimming behave exactly as in the UI.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { useHelp } from "../../../src/features/support/help/help.hook";
import { loginAs } from "../../helpers/auth.js";
import { invalidateCache } from "../../../src/hooks/useRequest";

function wrapper({ children }) {
    return <MemoryRouter initialEntries={["/about/help"]}>{children}</MemoryRouter>;
}

/** Render useHelp logged in as a tier-0 USER and wait until auth resolves. */
async function renderReady() {
    loginAs("USER");
    const view = renderHook(() => useHelp(), { wrapper });
    await waitFor(() => expect(view.result.current.isLoading).toBe(false));
    return view;
}

/** Flatten the filtered category tree to a list of article questions (lowercased). */
function questionsOf(result) {
    return result.current.filteredCategories.flatMap((c) => c.articles.map((a) => a.question.toLowerCase()));
}

describe("Help Center search — parity with the launcher", function () {
    beforeEach(function () {
        // AuthMiddleware.isAuth() caches auth/me for 5 min via the useRequest
        // singleton; a prior test's cached user would otherwise leak in.
        invalidateCache();
    });

    it("surfaces the dark-mode appearance article for the SYNONYM 'dark'", async function () {
        const { result } = await renderReady();
        act(() => result.current.setSearchQuery("dark"));
        await waitFor(() => expect(result.current.matchCount).toBeGreaterThan(0));

        // "dark" is a curated alias of "theme"/"appearance"; the appearance
        // articles surface (the dark-mode article is the strongest hit).
        expect(questionsOf(result).some((q) => q.includes("light and dark mode"))).toBe(true);
    });

    it("tolerates a small TYPO — 'passwrd' recovers into results via fuzzy match", async function () {
        const { result } = await renderReady();
        // 'passwrd' is ONE edit from 'password', within the strict article-match
        // tolerance, so it recovers directly into results and no suggestion fires.
        act(() => result.current.setSearchQuery("passwrd"));
        await waitFor(() => expect(result.current.matchCount).toBeGreaterThan(0));
        expect(result.current.suggestion).toBeNull();
    });

    it("offers a 'did you mean?' suggestion for a garbled word ('passwrod') that misses every article", async function () {
        const { result } = await renderReady();
        // 'passwrod' is TWO edits from 'password' — beyond the strict article
        // tolerance (≤1) so it matches nothing, but within the lenient
        // suggestion tolerance (≤2) so the recovery still fires.
        act(() => result.current.setSearchQuery("passwrod"));
        await waitFor(() => expect(result.current.matchCount).toBe(0));
        expect(result.current.suggestion).toBe("password");
    });

    it("recovers into real results when the suggestion is applied", async function () {
        const { result } = await renderReady();
        act(() => result.current.setSearchQuery("passwrod"));
        await waitFor(() => expect(result.current.suggestion).toBe("password"));

        act(() => result.current.applySuggestion());
        await waitFor(() => expect(result.current.matchCount).toBeGreaterThan(0));
        // Applying the suggestion also drops any category filter, so the query
        // now reflects the corrected word.
        expect(result.current.searchQuery).toBe("password");
        expect(result.current.selectedCategoryId).toBeNull();
    });

    it("stays empty with NO suggestion for a genuinely off-topic query", async function () {
        const { result } = await renderReady();
        act(() => result.current.setSearchQuery("purple giraffe"));
        await waitFor(() => expect(result.current.matchCount).toBe(0));
        // Nothing in the corpus is within fuzzy range — a misleading suggestion
        // would be worse than none.
        expect(result.current.suggestion).toBeNull();
    });
});
