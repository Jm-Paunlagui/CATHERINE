/**
 * useScrollSpy — tracks which anchored section is currently in view.
 *
 * A single IntersectionObserver watches every `#id` named in `sections` and
 * the hook returns the id of the FIRST section (in `sections` order, not in
 * callback order) that is intersecting. When nothing intersects — the reader
 * has scrolled above the first anchor, or the page is shorter than the
 * viewport — the last known active id is kept, falling back to the first
 * section so the "On This Page" rail always highlights something.
 *
 * ── Stable `sections` identity is the caller's job ────────────────────────
 * The observer is rebuilt whenever the `sections` array REFERENCE changes,
 * because that is the effect's only dependency. A caller that derives its
 * sections from polled API data must `useMemo` the array on a stable key
 * (e.g. the joined section keys) — otherwise every poll that returns the same
 * data still tears the observer down and rebuilds it.
 *
 * ── No setState during the effect ─────────────────────────────────────────
 * The "which section should be active before the first callback fires"
 * decision is DERIVED during render rather than seeded with a setState in the
 * effect. That keeps the hook clear of react-hooks/set-state-in-effect and
 * means a `sections` change (midnight rollover adding a supper section) is
 * reflected on the very same render, not one paint later.
 */

import { useEffect, useState } from "react";

/**
 * @typedef {{ id: string, label: string }} ScrollSpySection
 */

/**
 * Observe `sections` and report the one currently in view.
 *
 * @param {ScrollSpySection[]} sections - Ordered section registry. Each `id`
 *   must match the `id` of an element rendered in the document.
 * @param {object} [options]
 * @param {string} [options.rootMargin="-96px 0px -70% 0px"] - Observer root
 *   margin. The top inset clears the sticky app navbar; the large bottom inset
 *   keeps the "active" band near the top of the viewport so a heading counts as
 *   active once it reaches reading position, not when it first peeks in from
 *   the bottom.
 * @returns {string|null} Active section id, or null when there are no sections.
 */
export function useScrollSpy(sections, options = {}) {
    const { rootMargin = "-96px 0px -70% 0px" } = options;
    const [observedId, setObservedId] = useState(null);

    useEffect(() => {
        if (!sections?.length) return undefined;

        // jsdom and older browsers ship no IntersectionObserver. Degrade to the
        // derived first-section fallback below rather than throwing mid-render.
        if (typeof IntersectionObserver === "undefined") return undefined;

        const visible = new Set();
        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) visible.add(entry.target.id);
                    else visible.delete(entry.target.id);
                }
                // Document order wins over callback order — the observer batches
                // entries and does not promise them top-to-bottom.
                const first = sections.find((s) => visible.has(s.id));
                if (first) setObservedId(first.id);
            },
            { rootMargin, threshold: 0 },
        );

        for (const section of sections) {
            const node = document.getElementById(section.id);
            if (node) observer.observe(node);
        }

        return () => observer.disconnect();
    }, [sections, rootMargin]);

    // Derived, not stored: an id that no longer exists in `sections` (a section
    // disappeared on the midnight rollover) must never stay highlighted.
    if (!sections?.length) return null;
    return sections.some((s) => s.id === observedId) ? observedId : sections[0].id;
}

export default useScrollSpy;
