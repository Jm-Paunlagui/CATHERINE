/**
 * DevDocs.view.jsx — the developer documentation viewer.
 *
 * ADMIN / SUPER_ADMIN only. The route guard in App.jsx and the nav entry's own
 * role list are conveniences: they keep a non-admin from landing on a page of
 * 403s. The control is server-side, on every /dev-docs endpoint. Nothing in
 * this file should ever be described as protecting the corpus.
 *
 * LAYOUT MIRRORS VERSION HISTORY, deliberately. Both are Support pages built
 * around "pick one thing from an index, read it", so the index sits in the
 * same place — a bordered rail on the RIGHT on desktop — and the content sits
 * on the page surface rather than inside a Card. A reader moving between the
 * two pages should not have to relearn where anything is.
 *
 * DOM order is nav-then-content; `lg:flex-row-reverse` puts the rail on the
 * right on desktop while the mobile stack still reads "browse, then read".
 */

import { ANIMATE_FADE_IN_UP, ANIM_DELAY_0, BASE_COLOR_BG, BASE_COLOR_TEXT, STANDARD_BORDER, TRANSITION_COLORS } from "../../../assets/styles/pre-set-styles";
import { Alert } from "../../../components/ui/Alert";
import { Badge } from "../../../components/ui/Badge";
import { Skeleton } from "../../../components/ui/Skeleton";
import { Tooltip } from "../../../components/ui/Tooltip";
import ErrorBoundary from "../../../components/feedback/ErrorBoundary";
import { useScrollSpy } from "../../../components/shared/DocsPage";
import DocIndexNav from "./components/DocIndexNav";
import MarkdownDoc from "./components/MarkdownDoc";
import { useDevDocs } from "./devdocs.hook";

/**
 * Freshness chip.
 *
 * UNKNOWN is a real state rather than a missing value — an unmapped document is
 * not evidence that it is current, and saying so is more useful than showing
 * nothing at all.
 */
function FreshnessBadge({ freshness, docCommittedAt, sourceCommittedAt }) {
    const config = {
        CURRENT: {
            variant: "green",
            label: "Current",
            tip: `Updated ${docCommittedAt ?? "—"}, at or after the code it describes.`,
        },
        SUSPECT: {
            variant: "amber",
            label: "Check against code",
            // "May still be accurate" is load-bearing. A reader told flatly
            // "this is out of date" who then finds it accurate stops reading
            // the banner, and the next genuinely stale document goes unchecked.
            tip: `Last updated ${docCommittedAt ?? "—"}, but the code it describes changed on ${sourceCommittedAt ?? "—"}. It may still be accurate — verify before relying on it.`,
        },
        UNKNOWN: {
            variant: "grey",
            label: "Age unknown",
            tip: "No commit history available for this document or the code it describes.",
        },
    }[freshness];

    if (!config) return null;

    return (
        <Tooltip content={config.tip} placement="bottom">
            <span>
                <Badge variant={config.variant} size="xs" pill>
                    {config.label}
                </Badge>
            </span>
        </Tooltip>
    );
}

export default function DevDocsView() {
    const hook = useDevDocs();
    const { selectedMeta, doc, docLoading, toc, apiError, treeLoading, selectedId } = hook;

    // Which heading the reader is actually on. The SAME hook the shared
    // DocShell rail uses (reference pages), so the two
    // "On this page" rails in the app cannot drift in how they decide what is
    // active. `toc` is memoised on the markdown string, which is the stable
    // identity the observer needs — a re-render with the same document must
    // not tear the observer down and rebuild it.
    const activeId = useScrollSpy(toc);

    // The content pane is loading while the TREE is loading too. The hook
    // auto-selects the first document once the index arrives, so during that
    // window nothing is selected and nothing is fetching — but a document is
    // definitely on its way. Rendering "Select a document to begin." there told
    // the reader to do something they could not do yet, next to a rail that was
    // visibly still loading. The empty state is for a genuinely empty
    // selection, not for a pending one.
    const contentLoading = docLoading || (treeLoading && !selectedId);

    return (
        <ErrorBoundary>
            <div className="p-4 md:p-6 flex flex-col gap-4 animate-page-enter">
                {/* ── Header ─────────────────────────────────────────────── */}
                <div className={`flex flex-wrap items-start justify-between gap-4 ${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_0}`}>
                    <div>
                        <h1 className={`text-xl font-bold ${BASE_COLOR_TEXT}`}>Developer Documentation</h1>
                        <p className={`text-sm ${BASE_COLOR_TEXT} opacity-60`}>
                            Internal architecture reference. Administrators only.
                        </p>
                    </div>
                </div>

                {apiError && (
                    <Alert variant="danger" title="Could not load documentation">
                        {apiError.message}
                    </Alert>
                )}

                {/* ── Index rail (right on desktop) + document ────────────── */}
                <div className="flex flex-col lg:flex-row-reverse lg:items-start gap-4 lg:gap-8">
                    <DocIndexNav hook={hook} />

                    <article className="flex-1 min-w-0">
                        {selectedMeta && (
                            <div className="flex flex-wrap items-center gap-3 mb-4">
                                <nav aria-label="Breadcrumb" className={`text-sm ${BASE_COLOR_TEXT} opacity-60`}>
                                    <span>{selectedMeta.section}</span>
                                    <span aria-hidden="true" className="mx-1.5">
                                        ›
                                    </span>
                                    <span className="font-medium opacity-100">{selectedMeta.title}</span>
                                </nav>
                                <div className="ml-auto">
                                    <FreshnessBadge
                                        freshness={doc?.freshness ?? selectedMeta?.freshness}
                                        docCommittedAt={doc?.docCommittedAt ?? selectedMeta?.docCommittedAt}
                                        sourceCommittedAt={doc?.sourceCommittedAt ?? selectedMeta?.sourceCommittedAt}
                                    />
                                </div>
                            </div>
                        )}

                        {doc?.freshness === "SUSPECT" && (
                            <Alert variant="warning" title="This document may be behind the code" className="mb-4">
                                Last updated {doc.docCommittedAt ?? "—"}; the code it describes changed on{" "}
                                {doc.sourceCommittedAt ?? "—"}. Verify against the source before relying on it.
                            </Alert>
                        )}

                        {contentLoading ? (
                            // Shaped like a document: title, a paragraph of
                            // body, a heading, more body, then a diagram-sized
                            // block. The corpus is prose plus Mermaid, so a
                            // generic stack of equal bars would resettle
                            // visibly when the real content lands.
                            <div role="status" aria-live="polite" aria-busy="true" className="space-y-3">
                                <span className="sr-only">Loading document…</span>
                                <Skeleton className="h-7 w-1/2" />
                                <div className="space-y-2 pt-2">
                                    <Skeleton className="h-3.5 w-full" />
                                    <Skeleton className="h-3.5 w-11/12" />
                                    <Skeleton className="h-3.5 w-4/5" />
                                </div>
                                <Skeleton className="h-5 w-1/3 mt-6" />
                                <div className="space-y-2 pt-1">
                                    <Skeleton className="h-3.5 w-full" />
                                    <Skeleton className="h-3.5 w-10/12" />
                                </div>
                                <Skeleton className="h-44 w-full mt-4" />
                            </div>
                        ) : doc ? (
                            <div className="flex gap-8">
                                <div className="flex-1 min-w-0">
                                    <MarkdownDoc markdown={doc.markdown} />
                                </div>

                                {/* On-this-page. Above xl only, and only when
                                    there is more than one entry — a one-item
                                    outline is furniture, not navigation. */}
                                {toc.length > 1 && (
                                    <nav
                                        aria-label="On this page"
                                        // This element is BOTH the sticky rail and its own scroll container, so it
                                        // subtracts only the sticky top gap plus a bottom breather from the
                                        // measured scrollport height (`--app-scroll-h`, App.jsx). The old
                                        // `100vh - 8rem` assumed the sidebar-mode chrome and left the rail
                                        // taller than the scrollport in top-bar mode, where sticky then has
                                        // nothing to hold on to.
                                        className={`hidden xl:block w-56 shrink-0 rounded-2xl ${BASE_COLOR_BG} ${STANDARD_BORDER} p-4 sticky top-6 max-h-[calc(var(--app-scroll-h,100vh)-4rem)] overflow-y-auto`}
                                    >
                                        <h2 className={`text-sm font-aumovio-bold ${BASE_COLOR_TEXT}`}>On this page</h2>
                                        <span className="block mt-1 w-10 h-0.5 rounded-full bg-(--accent-icon)" />
                                        <ul className="mt-3 space-y-1 text-sm">
                                            {toc.map((item) => (
                                                <li key={item.id} className={item.depth === 3 ? "ml-3" : ""}>
                                                    <a
                                                        href={`#${item.id}`}
                                                        aria-current={item.id === activeId ? "location" : undefined}
                                                        className={`block truncate border-l-2 pl-2 -ml-2 ${TRANSITION_COLORS} ${
                                                            item.id === activeId
                                                                ? "border-(--accent-icon) text-(--accent-foreground) font-aumovio-bold opacity-100"
                                                                : `border-transparent ${BASE_COLOR_TEXT} opacity-70 hover:opacity-100 hover:text-(--accent-foreground)`
                                                        }`}
                                                    >
                                                        {item.text}
                                                    </a>
                                                </li>
                                            ))}
                                        </ul>
                                    </nav>
                                )}
                            </div>
                        ) : (
                            <p className={`text-sm ${BASE_COLOR_TEXT} opacity-60`}>Select a document to begin.</p>
                        )}
                    </article>
                </div>
            </div>
        </ErrorBoundary>
    );
}
