/**
 * Gallery — Responsive image grid with lightbox.
 *
 * Props:
 *   images     — [{ src, alt, caption? }]
 *   columns    — 2|3|4|5
 *   gap        — 'sm'|'md'|'lg'
 *   lightbox   — boolean
 *   masonry    — boolean
 */

import { ChevronLeftIcon, ChevronRightIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { ANIMATE_FADE_IN, HOVER_SCALE, TRANSITION_SMOOTH } from "../../assets/styles/pre-set-styles";

export function Gallery({ images = [], columns = 3, gap = "md", lightbox = true }) {
    const [selected, setSelected] = useState(null);
    const COLS = {
        2: "grid-cols-2",
        3: "grid-cols-2 md:grid-cols-3",
        4: "grid-cols-2 md:grid-cols-4",
        5: "grid-cols-2 md:grid-cols-5",
    };
    const GAPS = { sm: "gap-1", md: "gap-3", lg: "gap-6" };

    return (
        <>
            <div className={`grid ${COLS[columns] ?? COLS[3]} ${GAPS[gap] ?? GAPS.md}`}>
                {images.map((img, i) => (
                    <div
                        key={i}
                        onClick={() => lightbox && setSelected(i)}
                        className={`overflow-hidden rounded-xl bg-grey-100 dark:bg-(--bg-surface-3)
              ${lightbox ? "cursor-zoom-in" : ""} group`}
                    >
                        <img src={img.src} alt={img.alt ?? ""} className={`object-cover w-full h-48 ${TRANSITION_SMOOTH} ${HOVER_SCALE}`} />
                    </div>
                ))}
            </div>

            {/* Lightbox */}
            {lightbox && selected !== null && (
                <div className={`fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 ${ANIMATE_FADE_IN}`} onClick={() => setSelected(null)}>
                    <button onClick={() => setSelected(null)} className="absolute top-4 right-4 text-white/70 hover:text-white">
                        <XMarkIcon className="w-8 h-8" />
                    </button>
                    {selected > 0 && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                setSelected((s) => s - 1);
                            }}
                            className="absolute -translate-y-1/2 left-4 top-1/2 text-white/70 hover:text-white"
                        >
                            <ChevronLeftIcon className="w-8 h-8" />
                        </button>
                    )}
                    <img src={images[selected]?.src} alt={images[selected]?.alt} className="max-h-[90vh] max-w-full rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()} />
                    {selected < images.length - 1 && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                setSelected((s) => s + 1);
                            }}
                            className="absolute -translate-y-1/2 right-4 top-1/2 text-white/70 hover:text-white"
                        >
                            <ChevronRightIcon className="w-8 h-8" />
                        </button>
                    )}
                    {images[selected]?.caption && <p className="absolute text-sm -translate-x-1/2 bottom-6 left-1/2 text-white/80">{images[selected].caption}</p>}
                </div>
            )}
        </>
    );
}

export default Gallery;
