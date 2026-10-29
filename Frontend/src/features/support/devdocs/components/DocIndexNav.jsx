/**
 * DocIndexNav.jsx — the documentation index rail.
 *
 * Deliberately the same shape as Version History's `DateJourneyNav`: a rail on
 * the RIGHT on desktop, stacked above the content on mobile, in a bordered
 * surface rather than a Card. The two pages are siblings under Support and a
 * reader should not have to relearn where the index lives when moving between
 * them.
 *
 * The DOM order is nav-then-content, and the parent flips it with
 * `lg:flex-row-reverse`. That is not a styling trick for its own sake — on a
 * phone the stack then reads "browse, then read", which is the order someone
 * actually uses it in, while desktop still gets the rail on the right.
 */

import { BASE_COLOR_BG, BASE_COLOR_TEXT, STANDARD_BORDER, TRANSITION_COLORS } from "../../../../assets/styles/pre-set-styles";
import { SearchInput } from "../../../../components/forms/SearchInput";
import { Skeleton } from "../../../../components/ui/Skeleton";

/**
 * One document row.
 *
 * The SUSPECT dot repeats what the badge on the document says, on purpose:
 * this is where someone chooses what to read, and "this one may be behind the
 * code" is worth knowing before opening it rather than after.
 */
function DocRow({ doc, active, onSelect }) {
    return (
        <li>
            <button
                type="button"
                onClick={() => onSelect(doc.id)}
                aria-current={active ? "page" : undefined}
                className={`group relative w-full flex items-center gap-3 pl-6 pr-2 py-2 rounded-lg text-left ${TRANSITION_COLORS} ${
                    active ? "bg-orange-400/10 dark:bg-orange-400/10" : "hover:bg-grey-100 dark:hover:bg-white/5"
                }`}
            >
                <span
                    className={`absolute left-2 w-2 h-2 rounded-full ring-2 ring-white dark:ring-(--color-dark-surface-elevated) ${
                        active ? "bg-(--accent-icon)" : "bg-grey-300 dark:bg-white/20"
                    }`}
                />
                <span className="flex-1 min-w-0">
                    <span
                        className={`block text-sm leading-tight truncate ${
                            active ? "font-semibold text-(--accent-foreground)" : `font-medium ${BASE_COLOR_TEXT} opacity-80`
                        }`}
                    >
                        {doc.title}
                    </span>
                </span>
                {doc.freshness === "SUSPECT" && (
                    <span
                        title="This document may be behind the code it describes"
                        className="shrink-0 w-1.5 h-1.5 rounded-full bg-warn-400"
                    />
                )}
            </button>
        </li>
    );
}

/**
 * @param {object} props
 * @param {object} props.hook - useDevDocs() return value
 */
export function DocIndexNav({ hook }) {
    const {
        sections, treeLoading, selectedId, setSelectedId,
        searchRaw, setSearchRaw, searchActive, searchResults, searchTotal, searchTruncated, searchLoading,
    } = hook;

    const docCount = sections.reduce((n, s) => n + (s.docs?.length ?? 0), 0);

    return (
        <nav
            aria-label="Developer documentation index"
            className={`rounded-2xl ${BASE_COLOR_BG} ${STANDARD_BORDER} p-4 lg:w-72 lg:shrink-0 lg:sticky lg:top-6`}
        >
            <h2 className={`text-sm font-aumovio-bold ${BASE_COLOR_TEXT}`}>Documentation</h2>
            <span className="block mt-1 w-10 h-0.5 rounded-full bg-(--accent-icon)" />

            {/* The tally is WITHHELD while loading rather than rendered from an
                empty array. "0 documents across 0 sections" is not a loading
                state, it is a factual claim that the corpus is empty — and it
                was on screen at the same moment the skeleton below said data
                was still arriving. Two contradictory answers to the same
                question is worse than one delayed answer. */}
            {treeLoading ? (
                <Skeleton className="mt-2 h-3 w-40" />
            ) : (
                <p className={`mt-2 text-xs ${BASE_COLOR_TEXT} opacity-50`}>
                    {docCount} document{docCount === 1 ? "" : "s"} across {sections.length} section{sections.length === 1 ? "" : "s"}
                </p>
            )}

            <div className="mt-3">
                <SearchInput value={searchRaw} onChange={setSearchRaw} placeholder="Search documentation" size="sm" disabled={treeLoading} />
            </div>

            {/* Measured scrollport, not `100vh` minus a guess at the chrome —
                see App.jsx's useScrollportHeightVar. */}
            <div className="mt-3 lg:max-h-[calc(var(--app-scroll-h,100vh)-11rem)] lg:overflow-y-auto">
                {treeLoading ? (
                    // Echoes the real structure — a section label, then its
                    // documents — instead of eight identical full-width slabs.
                    // A skeleton that does not match what replaces it makes the
                    // page jump on arrival, and reads as a broken list rather
                    // than as pending content.
                    //
                    // Row widths vary because real titles do; uniform bars are
                    // the tell that a skeleton was drawn rather than derived.
                    <div role="status" aria-live="polite" aria-busy="true" className="space-y-4">
                        <span className="sr-only">Loading documentation index…</span>
                        {[
                            ["w-16", ["w-11/12", "w-4/5"]],
                            ["w-20", ["w-full", "w-10/12", "w-3/4"]],
                            ["w-24", ["w-5/6", "w-full"]],
                        ].map(([labelW, rows], s) => (
                            <div key={s}>
                                <Skeleton className={`h-2.5 ${labelW} mb-2 ml-2`} />
                                <div className="space-y-1.5">
                                    {rows.map((rowW, r) => (
                                        <div key={r} className="flex items-center gap-3 pl-2">
                                            {/* Matches DocRow's leading dot. */}
                                            <Skeleton className="h-2 w-2 rounded-full shrink-0" />
                                            <Skeleton className={`h-3.5 ${rowW}`} />
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                ) : searchActive ? (
                    <SearchResults
                        loading={searchLoading}
                        results={searchResults}
                        total={searchTotal}
                        truncated={searchTruncated}
                        onSelect={setSelectedId}
                    />
                ) : (
                    sections.map((section) => (
                        <div key={section.name} className="mb-3">
                            <p className={`px-2 text-[10px] uppercase tracking-wide ${BASE_COLOR_TEXT} opacity-40 mb-1`}>
                                {section.name}
                            </p>
                            <ul className="space-y-0.5">
                                {(section.docs ?? []).map((doc) => (
                                    <DocRow key={doc.id} doc={doc} active={doc.id === selectedId} onSelect={setSelectedId} />
                                ))}
                            </ul>
                        </div>
                    ))
                )}
            </div>
        </nav>
    );
}

/** Search hits. Server-side search, so this renders what came back and nothing more. */
function SearchResults({ loading, results, total, truncated, onSelect }) {
    if (loading) {
        return (
            <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                ))}
            </div>
        );
    }
    if (!results.length) {
        return <p className={`px-2 text-sm ${BASE_COLOR_TEXT} opacity-60`}>No matches.</p>;
    }
    return (
        <div>
            <p className={`px-2 text-[10px] uppercase tracking-wide ${BASE_COLOR_TEXT} opacity-40 mb-1`}>
                {total} match{total === 1 ? "" : "es"}
                {truncated && ` · first ${results.length}`}
            </p>
            <ul className="space-y-0.5">
                {results.map((r, i) => (
                    <li key={`${r.id}-${r.line}-${i}`}>
                        <button
                            type="button"
                            onClick={() => onSelect(r.id)}
                            className={`w-full text-left px-2 py-1.5 rounded-lg ${TRANSITION_COLORS} hover:bg-grey-100 dark:hover:bg-white/5`}
                        >
                            <span className={`block text-sm font-medium truncate ${BASE_COLOR_TEXT} opacity-90`}>{r.title}</span>
                            {r.heading && (
                                <span className={`block text-[10px] uppercase tracking-wide truncate ${BASE_COLOR_TEXT} opacity-40`}>
                                    {r.heading}
                                </span>
                            )}
                            <span className={`block text-xs truncate ${BASE_COLOR_TEXT} opacity-60`}>{r.snippet}</span>
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    );
}

export default DocIndexNav;
