import { useEffect } from "react";

/** Quiet period after the last resize before `--app-scroll-h` is rewritten. */
export const SETTLE_MS = 120;

/**
 * Publishes the height of `#app-main-scroll` — the app's real scrollport — as the
 * `--app-scroll-h` CSS variable on <html>.
 *
 * WHY: every sticky rail in the app (Version History's date journey, Help's
 * category nav, Dev Docs' index + "On This Page", the shared DocShell) caps
 * its own height so it fits beside the content it navigates. They all used to
 * cap against `100vh` minus a HARD-CODED guess at the chrome above them
 * (`calc(100vh - 19rem)`, `- 16rem`, `- 8rem`). That guess is only right in
 * one layout mode: sidebar mode puts a sidebar header over the scrollport,
 * top-bar mode puts the navbar AND the breadcrumb bar there instead, and the
 * two are not the same height. Guess low and the rail ends up TALLER than the
 * scrollport — at which point `position: sticky` can no longer hold it: an
 * element taller than its scrollport sticks only until its bottom edge
 * arrives, then scrolls away under the top bar. That is the "nav is not
 * sticky in top bar mode" report, and it is why the same rails behaved in
 * sidebar mode.
 *
 * Measuring removes the guess: the variable is the scrollport's ACTUAL height
 * in every mode, at every breakpoint, and it updates when the chrome does
 * (breadcrumb wrapping to two lines, a banner appearing, the window
 * resizing). Rails subtract only their own in-panel chrome from it.
 *
 * @param {import('react').RefObject<HTMLElement>} ref - the #app-main-scroll node
 */
export function useScrollportHeightVar(ref) {
    useEffect(() => {
        const node = ref.current;
        if (!node) return undefined;

        let last = 0;
        let timer = null;
        const publish = () => {
            timer = null;
            // A zero height means the node is not laid out yet (or is in a
            // non-layout environment such as jsdom). Publishing 0 would make
            // every rail's `calc(var(--app-scroll-h) - <chrome>)` negative and
            // collapse it to nothing, so leave the variable unset and let the
            // `100vh` fallback in each calc() stand.
            const h = node.clientHeight;
            if (h > 0 && h !== last) {
                last = h;
                document.documentElement.style.setProperty("--app-scroll-h", `${h}px`);
            }
        };
        // A custom property on <html> is inherited by EVERY element, so each write restyles the whole
        // document. While the server status banner's row animates, #app-main-scroll changes height every
        // frame: writing per frame cost ~475 ms of style recalc per 350 ms enter (laggy banner).
        // Publish once the size has settled instead; the rails read a value at
        // most SETTLE_MS old, and an unchanged height writes nothing.
        const schedule = () => {
            clearTimeout(timer);
            timer = setTimeout(publish, SETTLE_MS);
        };
        publish();

        // ResizeObserver is absent in some test environments; the rails carry
        // a `100vh` fallback in their own calc(), so the app degrades to the
        // old behaviour rather than to a broken layout.
        if (typeof ResizeObserver === "undefined") {
            window.addEventListener("resize", schedule);
            return () => {
                clearTimeout(timer);
                window.removeEventListener("resize", schedule);
            };
        }
        const ro = new ResizeObserver(schedule);
        ro.observe(node);
        return () => {
            clearTimeout(timer);
            ro.disconnect();
        };
    }, [ref]);
}

export default useScrollportHeightVar;
