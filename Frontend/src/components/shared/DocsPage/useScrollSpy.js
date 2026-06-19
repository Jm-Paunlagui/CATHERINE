/**
 * useScrollSpy.js — Tracks which section is in view for a docs "On this page" rail.
 *
 * IntersectionObserver-based. Returns the id of the section currently nearest
 * the top of the viewport. Shared (tier 3) by all docs-style views.
 */

import { useEffect, useRef, useState } from "react";

/**
 * @param {{id: string, label: string}[]} sections  Section registry (stable ref —
 *        define as a module-level constant so the observer is not rebuilt each render).
 * @returns {string} The id of the active (in-view) section.
 * @example
 * const SECTIONS = [{ id: "overview", label: "Overview" }];
 * const active = useScrollSpy(SECTIONS); // O(n) observers, n = sections
 */
export function useScrollSpy(sections) {
    const [activeSection, setActiveSection] = useState(sections[0]?.id);
    const observerRef = useRef(null);

    useEffect(() => {
        const els = sections.map((s) => document.getElementById(s.id)).filter(Boolean);
        if (els.length === 0) return;

        observerRef.current = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        setActiveSection(entry.target.id);
                        break;
                    }
                }
            },
            { rootMargin: "-80px 0px -60% 0px", threshold: 0.1 },
        );

        for (const el of els) observerRef.current.observe(el);
        return () => observerRef.current?.disconnect();
    }, [sections]);

    return activeSection;
}

export default useScrollSpy;
