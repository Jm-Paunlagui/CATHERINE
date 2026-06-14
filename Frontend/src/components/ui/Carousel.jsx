/**
 * Carousel — Image / content slider.
 *
 * Props:
 *   items       — [{ id, content: ReactNode }]  OR  [{ id, src, alt, caption? }]
 *   autoPlay    — boolean
 *   interval    — ms (default 4000)
 *   showDots    — boolean
 *   showArrows  — boolean
 *   loop        — boolean
 *   transition  — 'slide' | 'fade'
 */
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useRef, useState } from "react";

export function Carousel({ items = [], autoPlay = true, interval = 4000, showDots = true, showArrows = true, loop = true, transition = "slide" }) {
    const [current, setCurrent] = useState(0);
    const timerRef = useRef(null);

    const count = items.length;

    const go = useCallback(
        (idx) => {
            let next = idx;
            if (loop) next = ((idx % count) + count) % count;
            else next = Math.max(0, Math.min(count - 1, idx));
            setCurrent(next);
        },
        [count, loop],
    );

    useEffect(() => {
        if (!autoPlay) return;
        timerRef.current = setInterval(() => go(current + 1), interval);
        return () => clearInterval(timerRef.current);
    }, [autoPlay, current, go, interval]);

    return (
        <div className="relative overflow-hidden select-none rounded-xl">
            {/* Slides */}
            <div
                className={`flex transition-transform duration-500 ease-in-out`}
                style={{
                    transform: transition === "slide" ? `translateX(-${current * 100}%)` : undefined,
                }}
            >
                {items.map((item, i) => (
                    <div
                        key={item.id ?? i}
                        className={`w-full shrink-0
            ${transition === "fade" ? `absolute inset-0 transition-opacity duration-500 ${i === current ? "opacity-100 z-10" : "opacity-0 z-0"}` : ""}`}
                    >
                        {item.src ? <img src={item.src} alt={item.alt ?? ""} className="object-cover w-full h-64 md:h-80" /> : item.content}
                        {item.caption && <div className="absolute bottom-0 left-0 right-0 px-4 py-2 text-sm text-white bg-black/50 font-aumovio backdrop-blur-sm">{item.caption}</div>}
                    </div>
                ))}
            </div>

            {/* Arrows */}
            {showArrows && (
                <>
                    <button onClick={() => go(current - 1)} className="absolute z-20 flex items-center justify-center w-8 h-8 transition-colors -translate-y-1/2 rounded-full shadow left-2 top-1/2 bg-white/80 dark:bg-black/50 hover:bg-white dark:hover:bg-black/80">
                        <ChevronLeftIcon className="w-4 h-4 text-grey-700 dark:text-grey-300" />
                    </button>
                    <button onClick={() => go(current + 1)} className="absolute z-20 flex items-center justify-center w-8 h-8 transition-colors -translate-y-1/2 rounded-full shadow right-2 top-1/2 bg-white/80 dark:bg-black/50 hover:bg-white dark:hover:bg-black/80">
                        <ChevronRightIcon className="w-4 h-4 text-grey-700 dark:text-grey-300" />
                    </button>
                </>
            )}

            {/* Dots */}
            {showDots && (
                <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex gap-1.5">
                    {items.map((_, i) => (
                        <button
                            key={i}
                            onClick={() => go(i)}
                            className={`rounded-full transition-all duration-300
                ${i === current ? "w-5 h-2 bg-orange-400" : "w-2 h-2 bg-white/60 dark:bg-white/30 hover:bg-white dark:hover:bg-white/60"}`}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

export default Carousel;
