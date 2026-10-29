/**
 * MermaidBlock.jsx — renders one ```mermaid fence.
 *
 * The corpus carries 103 diagrams across 29 of its 30 documents, so this is
 * not a garnish — if it does not work, the viewer does not work. Three things
 * it has to get right, each of which is a real failure mode rather than a
 * theoretical one.
 *
 * 1. LAZY IMPORT. Mermaid is ~1 MB minified. A top-level import puts it in the
 *    main bundle for every user of the app, including the roles that cannot
 *    open this page at all. The dynamic import below means the cost lands only
 *    when an admin actually renders a diagram.
 *
 * 2. THEME CHANGES NEED A RE-RENDER, NOT A RESTYLE. `mermaid.initialize` sets
 *    the theme for SUBSEQUENT renders; SVGs already in the DOM do not re-theme
 *    themselves. So `isDark` is a dependency of the render effect, not a class
 *    on a wrapper. Get this wrong and the diagrams stay light-on-light after a
 *    toggle, which reads as a broken page rather than a styling miss.
 *
 *    And use the BUILT-IN themes — see the initialize call for why "base" plus
 *    selected themeVariables leaves ER, class and state diagrams on their
 *    light defaults.
 *
 * 3. FAILURES ARE CONTAINED. A malformed diagram makes `render` throw. One bad
 *    fence in one document must not blank the page, so a throw falls back to
 *    the fenced source in a <pre>. The reader still gets the content and the
 *    failure is visible without being fatal.
 *
 *    Catching the throw is NOT sufficient on its own — see
 *    `suppressErrorRendering` in the initialize call. Mermaid's default
 *    parse-error path draws its bomb glyph into a div it parented to
 *    document.body and leaks it, OUTSIDE this component's tree, before the
 *    throw ever reaches us. Containment needs both halves.
 *
 * The component reads `useTheme()` itself rather than taking a theme prop:
 * a prop would make every ancestor re-render on a toggle to deliver it.
 *
 * PAN AND ZOOM. Several of these are large sequence charts that do not fit a
 * column at readable size. Pan is OFF by default and behind a toggle,
 * deliberately: a diagram that captures the pointer as soon as it is touched
 * fights a reader who was only trying to scroll the page past it. Pan off, the
 * block scrolls like any other wide content; pan on, the viewport is clipped
 * and dragging moves the diagram.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { LuHand, LuMaximize, LuZoomIn, LuZoomOut } from "react-icons/lu";
import { useTheme } from "../../../../contexts/theme/useTheme";
import { Spinner } from "../../../../components/ui/Spinner";

/** Module-scoped so the ~1 MB import is paid once per session, not per diagram. */
let _mermaidPromise = null;

/**
 * Loads mermaid once and returns the shared instance.
 * @returns {Promise<object>}
 */
function loadMermaid() {
    if (!_mermaidPromise) {
        _mermaidPromise = import("mermaid").then((m) => m.default ?? m);
    }
    return _mermaidPromise;
}

/**
 * @param {object} props
 * @param {string} props.code - the raw body of the ```mermaid fence
 */
export default function MermaidBlock({ code }) {
    const { isDark } = useTheme();
    const reactId = useId();
    // Mermaid needs a DOM-id-safe string; useId contains colons.
    const domId = `mermaid-${reactId.replace(/[^a-zA-Z0-9]/g, "")}`;

    // One keyed result rather than three flags. The key is the (code, theme)
    // pair the result was produced for, so "is this stale" is a comparison
    // rather than a flag another effect has to remember to flip — and nothing
    // is set synchronously inside the effect body, which would be a cascading
    // render.
    const renderKey = `${isDark ? "d" : "l"}:${code}`;
    const [result, setResult] = useState({ key: null, svg: null, failed: false });

    // Guards a late render landing after the theme flipped again, or after
    // unmount: both would otherwise leave a diagram in the wrong theme.
    const renderSeq = useRef(0);

    useEffect(() => {
        const seq = ++renderSeq.current;
        let cancelled = false;

        loadMermaid()
            .then(async (mermaid) => {
                if (cancelled || seq !== renderSeq.current) return;

                mermaid.initialize({
                    startOnLoad: false,
                    // The BUILT-IN themes, not "base" plus a handful of
                    // themeVariables.
                    //
                    // That was the first attempt and it produced worse output
                    // than doing nothing: the generic variables (primaryColor,
                    // lineColor, …) cover flowcharts, but ER, class, state and
                    // sequence diagrams each read their OWN slots. Everything
                    // left unnamed fell back to the LIGHT defaults, so an ER
                    // diagram rendered white boxes with black text on a dark
                    // page — a half-themed diagram, which reads as broken
                    // rather than as slightly-off colours.
                    //
                    // "dark" and "default" are internally consistent across
                    // every diagram type mermaid supports. They are not an
                    // exact Aumovio palette match, and that trade is
                    // deliberate: a diagram that is coherently near the palette
                    // beats one that is exactly on-palette in the four slots
                    // someone remembered and wrong everywhere else.
                    theme: isDark ? "dark" : "default",
                    darkMode: isDark,
                    themeVariables: {
                        // The page already supplies the surface; an opaque
                        // diagram background would sit as a pale slab inside
                        // the dark article.
                        background: "transparent",
                        fontSize: "14px",
                    },
                    securityLevel: "strict", // no click handlers or raw HTML from a diagram
                    // REQUIRED for condition 3 to actually hold — without it
                    // the fallback below is dead code that still leaks.
                    //
                    // On a PARSE error mermaid's default path does not simply
                    // throw. It swaps the diagram for its built-in "error"
                    // diagram, DRAWS that (the bomb glyph plus "Syntax error
                    // in text" / "mermaid version 12.0.0") into the temporary
                    // div it appended to document.body, and only then rethrows
                    // the parse error — reaching the rethrow before its own
                    // removeTempElements() call. So the throw arrives here and
                    // we render the <pre>, but the bomb stays parented to
                    // <body> forever: one orphan per bad fence, stacking up
                    // outside this component's tree where no amount of
                    // component-level handling can reach it.
                    //
                    // suppressErrorRendering makes the parse-error branch
                    // clean up and throw WITHOUT drawing the error diagram, so
                    // a bad fence costs one <pre> and nothing else.
                    suppressErrorRendering: true,
                });

                const { svg: out } = await mermaid.render(domId, code);
                if (cancelled || seq !== renderSeq.current) return;
                setResult({ key: renderKey, svg: out, failed: false });
            })
            .catch(() => {
                if (cancelled || seq !== renderSeq.current) return;
                // Condition 3. The source is still worth showing.
                setResult({ key: renderKey, svg: null, failed: true });
            });

        return () => {
            cancelled = true;
        };
        // `isDark` belongs here — see condition 2 in the file header.
    }, [code, isDark, domId, renderKey]);


    const fresh = result.key === renderKey;

    // ── Viewport ─────────────────────────────────────────────────────────────
    const ZOOM_STEP = 0.25;
    const ZOOM_MIN = 0.5;
    const ZOOM_MAX = 4;

    const [view, setView] = useState({ key: null, scale: 1, x: 0, y: 0 });
    const [panMode, setPanMode] = useState(false);
    const [dragging, setDragging] = useState(false);
    const drag = useRef(null);

    // Every mutation stamps the current renderKey, so a viewport left over
    // from the previous diagram is recognisable as stale rather than applied.
    const zoom = useCallback(
        (delta) =>
            setView((v) => {
                const base = v.key === renderKey ? v : { scale: 1, x: 0, y: 0 };
                return {
                    key: renderKey,
                    x: base.x,
                    y: base.y,
                    scale: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number((base.scale + delta).toFixed(2)))),
                };
            }),
        [renderKey],
    );

    const reset = useCallback(() => setView({ key: renderKey, scale: 1, x: 0, y: 0 }), [renderKey]);

    // Leaving pan mode drops the offset but KEEPS the zoom. Someone who zoomed
    // in, panned to a corner, then switched panning off wants to stop dragging
    // — not to lose the magnification they just chose.
    const togglePan = useCallback(() => {
        setPanMode((on) => {
            if (on) setView((v) => ({ ...v, key: renderKey, x: 0, y: 0 }));
            return !on;
        });
    }, [renderKey]);

    const onPointerDown = (e) => {
        if (!panMode) return;
        drag.current = { startX: e.clientX, startY: e.clientY, originX: viewFor.x, originY: viewFor.y };
        setDragging(true);
        e.currentTarget.setPointerCapture?.(e.pointerId);
    };

    const onPointerMove = (e) => {
        if (!panMode || !drag.current) return;
        const d = drag.current;
        setView((v) => ({ ...v, key: renderKey, x: d.originX + (e.clientX - d.startX), y: d.originY + (e.clientY - d.startY) }));
    };

    const endDrag = (e) => {
        drag.current = null;
        setDragging(false);
        e.currentTarget.releasePointerCapture?.(e.pointerId);
    };

    // A new diagram, or a re-render for a theme change, starts from a known
    // viewport — carrying a pan offset across would leave the reader looking
    // at empty space wondering where the diagram went.
    //
    // Done by KEYING the viewport rather than resetting it from an effect. An
    // effect that calls setState synchronously is a cascading render; storing
    // the key the viewport belongs to and ignoring a stale one is the same
    // behaviour without the extra pass.
    const viewFor = view.key === renderKey ? view : { key: renderKey, scale: 1, x: 0, y: 0 };

    if (fresh && result.failed) {
        return (
            <div className="my-4">
                <p className="text-xs mb-1 text-black/50 dark:text-white/50">
                    This diagram could not be rendered. Its source is shown instead.
                </p>
                <pre className="p-3 overflow-x-auto text-xs rounded-lg bg-grey-100 dark:bg-(--bg-surface-3) text-black/80 dark:text-white/80">
                    <code>{code}</code>
                </pre>
            </div>
        );
    }

    // Nothing rendered for this (code, theme) pair yet. A previously rendered
    // SVG is kept on screen while a theme change re-renders, so toggling does
    // not flash a spinner over every diagram on the page.
    if (!fresh && !result.svg) {
        return (
            <div className="flex items-center gap-2 my-4 p-4 rounded-lg bg-grey-100 dark:bg-(--bg-surface-3)">
                <Spinner size="sm" />
                <span className="text-xs text-black/60 dark:text-white/60">Rendering diagram…</span>
            </div>
        );
    }

    const ctrl =
        "p-1.5 rounded-md text-black/70 dark:text-white/70 hover:bg-black/10 dark:hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent";

    return (
        <div className="relative my-4">
            {/* Always present rather than revealed on hover: a touch screen has
                no hover, and a control nobody can find is not a control. */}
            <div className="absolute top-2 right-2 z-10 flex items-center gap-0.5 rounded-lg p-0.5 border bg-grey-100/90 border-grey-300/60 dark:bg-(--bg-surface-3)/90 dark:border-white/10 backdrop-blur">
                <button
                    type="button"
                    onClick={togglePan}
                    aria-label={panMode ? "Disable pan mode" : "Enable pan mode"}
                    aria-pressed={panMode}
                    title={panMode ? "Pan mode on — drag to move" : "Pan mode off"}
                    className={`${ctrl} ${panMode ? "bg-(--accent-icon)/20 text-(--accent-foreground)" : ""}`}
                >
                    <LuHand size={15} />
                </button>
                <button type="button" onClick={() => zoom(-ZOOM_STEP)} disabled={viewFor.scale <= ZOOM_MIN} aria-label="Zoom out" title="Zoom out" className={ctrl}>
                    <LuZoomOut size={15} />
                </button>
                <button type="button" onClick={() => zoom(ZOOM_STEP)} disabled={viewFor.scale >= ZOOM_MAX} aria-label="Zoom in" title="Zoom in" className={ctrl}>
                    <LuZoomIn size={15} />
                </button>
                <button
                    type="button"
                    onClick={reset}
                    disabled={viewFor.scale === 1 && viewFor.x === 0 && viewFor.y === 0}
                    aria-label="Reset zoom and position"
                    title="Reset"
                    className={ctrl}
                >
                    <LuMaximize size={15} />
                </button>
            </div>

            {/* Pan OFF: scrolls horizontally like any other wide content.
                Pan ON: overflow clipped and dragging moves the diagram.
                Allowing both at once makes them fight — the drag scrolls the
                container and moves the transform at the same time. */}
            <div
                className={panMode ? "overflow-hidden touch-none" : "overflow-x-auto"}
                style={panMode ? { cursor: dragging ? "grabbing" : "grab" } : undefined}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
            >
                <div
                    role="img"
                    aria-label="Diagram"
                    style={{
                        transform: `translate(${viewFor.x}px, ${viewFor.y}px) scale(${viewFor.scale})`,
                        transformOrigin: "top left",
                        // No easing while dragging — an eased transform lags the
                        // pointer and reads as the diagram being stuck.
                        transition: dragging ? "none" : "transform 120ms ease-out",
                    }}
                    // Mermaid output, rendered with securityLevel "strict". The
                    // source is first-party repo content from an admin-gated
                    // endpoint, and `rehype-raw` is deliberately NOT enabled
                    // anywhere in this feature, so no caller-authored HTML
                    // reaches this path.
                    dangerouslySetInnerHTML={{ __html: result.svg ?? "" }}
                />
            </div>

            {viewFor.scale !== 1 && (
                <span className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded text-[10px] tabular-nums bg-grey-100/90 text-black/60 dark:bg-(--bg-surface-3)/90 dark:text-white/60">
                    {Math.round(viewFor.scale * 100)}%
                </span>
            )}
        </div>
    );
}
