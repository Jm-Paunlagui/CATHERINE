/**
 * useDebounce.js — Production-grade debounce hook.
 *
 * Features:
 *   - cancel()  — discard pending update
 *   - flush()   — immediately apply pending update
 *   - leading   — fire on the leading edge (first call), then debounce
 *   - isPending — true while a debounced update is in flight
 *   - maxWait   — force-flush after this many ms even if still changing
 *
 * Usage:
 *   // Basic
 *   const debounced = useDebounce(search, 300);
 *
 *   // With controls
 *   const { value, cancel, flush, isPending } = useDebounce(search, 300, {
 *     leading: false,
 *     maxWait: 1000,
 *   });
 *
 *   // Pass isPending to SearchBar spinner:
 *   <SearchBar isDebouncing={isPending} />
 */

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * @param {*}      value   — reactive value to debounce
 * @param {number} delay   — debounce delay in ms
 * @param {object} options
 * @param {boolean} [options.leading=false]    — also fire immediately on first change
 * @param {number}  [options.maxWait]          — max ms before forced flush
 * @returns {{ value, cancel, flush, isPending }}
 *          Also returns the debounced value directly when destructured as a primitive.
 */
export function useDebounce(value, delay = 300, options = {}) {
    const { leading = false, maxWait } = options;

    const [debounced, setDebounced] = useState(value);
    const [isPending, setIsPending] = useState(false);

    // Refs keep the latest values accessible inside timeouts without stale closures
    const pendingValue = useRef(value);
    const timer = useRef(null);
    const maxWaitTimer = useRef(null);
    const leadingFired = useRef(false);
    const isMounted = useRef(true);

    useEffect(() => {
        isMounted.current = true;
        return () => {
            isMounted.current = false;
        };
    }, []);

    const applyValue = useCallback((v) => {
        if (!isMounted.current) return;
        setDebounced(v);
        setIsPending(false);
        leadingFired.current = false;
    }, []);

    const cancel = useCallback(() => {
        clearTimeout(timer.current);
        clearTimeout(maxWaitTimer.current);
        timer.current = null;
        maxWaitTimer.current = null;
        if (isMounted.current) setIsPending(false);
        leadingFired.current = false;
    }, []);

    const flush = useCallback(() => {
        if (timer.current) {
            clearTimeout(timer.current);
            clearTimeout(maxWaitTimer.current);
            timer.current = null;
            maxWaitTimer.current = null;
            applyValue(pendingValue.current);
        }
    }, [applyValue]);

    // eslint-disable-next-line react-hooks/set-state-in-effect -- value-to-state sync: applies debounced value via timers; setIsPending tracks in-flight state
    useEffect(() => {
        pendingValue.current = value;

        // Leading edge: apply immediately on the first change in an idle period
        if (leading && !leadingFired.current) {
            leadingFired.current = true;
            applyValue(value);
        } else {
            setIsPending(true);
        }

        // Clear existing timer
        clearTimeout(timer.current);

        // Set debounce timer
        timer.current = setTimeout(() => {
            clearTimeout(maxWaitTimer.current);
            maxWaitTimer.current = null;
            timer.current = null;
            applyValue(pendingValue.current);
        }, delay);

        // Set maxWait timer (only once per idle period)
        if (maxWait && !maxWaitTimer.current) {
            maxWaitTimer.current = setTimeout(() => {
                clearTimeout(timer.current);
                timer.current = null;
                maxWaitTimer.current = null;
                applyValue(pendingValue.current);
            }, maxWait);
        }

        return () => {
            // Cleanup on unmount — don't call cancel() as that resets leadingFired
            clearTimeout(timer.current);
            clearTimeout(maxWaitTimer.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value, delay, leading, maxWait]);

    return { value: debounced, cancel, flush, isPending };
}

export default useDebounce;
