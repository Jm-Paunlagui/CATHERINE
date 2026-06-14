/**
 * useRequest.js — Request deduplication + cache hook.
 *
 * Solves:
 *   1. Multiple components mounting at the same time triggering the same API
 *      call N times (e.g., three components all calling GET /users on mount).
 *   2. Rapid re-renders / route changes causing stale-response races.
 *   3. No built-in cache — every mount hits the network.
 *
 * Features:
 *   - In-flight deduplication: identical keys share one in-flight promise.
 *   - TTL cache: configurable per-call stale time (default 30 s).
 *   - Automatic refetch on window focus (opt-in).
 *   - Manual refetch / invalidation.
 *   - Abort on unmount to avoid state-updates on dead components.
 *   - Loading / error / data states with TypeScript-style JSDoc.
 *
 * Design notes:
 *   - The in-flight map and cache live at MODULE scope (singleton) so any
 *     number of component instances share the same deduplication window.
 *   - Works with any async function, not just httpClient — pass any () => Promise.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Usage
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * // Basic — fires once, caches 30 s
 * const { data, loading, error, refetch } = useRequest(
 *   'users/list',
 *   () => httpClient.get('users').then(r => r.data),
 * );
 *
 * // Custom stale time + refetch on focus
 * const { data } = useRequest(
 *   'dashboard/stats',
 *   () => httpClient.get('dashboard/stats').then(r => r.data),
 *   { staleTime: 60_000, refetchOnFocus: true },
 * );
 *
 * // Conditional fetch (key = null disables the request)
 * const { data } = useRequest(
 *   userId ? `users/${userId}` : null,
 *   () => httpClient.get(`users/${userId}`).then(r => r.data),
 * );
 *
 * // Manual invalidation from outside a component
 * import { invalidateCache } from './useRequest';
 * invalidateCache('users/list');       // bust one key
 * invalidateCache();                   // bust everything
 *
 * // Works great with useDebounce:
 * const { value: debouncedQuery, isPending } = useDebounce(query, 300);
 * const { data, loading } = useRequest(
 *   debouncedQuery ? `search?q=${debouncedQuery}` : null,
 *   () => httpClient.get(`search?q=${debouncedQuery}`).then(r => r.data),
 * );
 * <SearchBar isDebouncing={isPending || loading} />
 */

import { useCallback, useEffect, useRef, useState } from "react";

// ─── Module-level singletons ──────────────────────────────────────────────────

/** @type {Map<string, Promise<any>>} Currently in-flight requests keyed by cache key */
const IN_FLIGHT = new Map();

/** @type {Map<string, { data: any, timestamp: number }>} Resolved cache */
const CACHE = new Map();

/** Maximum number of cache entries before the oldest is evicted (L-01). */
const MAX_CACHE_SIZE = 200;

/**
 * Set a value in CACHE, evicting the oldest entry when the size limit is reached.
 * @param {string} key
 * @param {{ data: any, timestamp: number }} value
 */
function _cacheSet(key, value) {
    if (CACHE.size >= MAX_CACHE_SIZE && !CACHE.has(key)) {
        // Evict the oldest entry (Map iteration order = insertion order)
        const oldestKey = CACHE.keys().next().value;
        CACHE.delete(oldestKey);
    }
    CACHE.set(key, value);
}

// ─── Public cache utilities ───────────────────────────────────────────────────

/**
 * Bust the cache for one key, or the entire cache when called with no args.
 * Safe to call from event handlers, other hooks, or API response interceptors.
 * @param {string} [key]
 */
export function invalidateCache(key) {
    if (key === undefined) {
        CACHE.clear();
        IN_FLIGHT.clear();
    } else {
        CACHE.delete(key);
        IN_FLIGHT.delete(key);
    }
}

/**
 * Seed the cache externally (e.g., from a form's POST response that returns
 * the updated resource — no need to refetch).
 * @param {string} key
 * @param {any}    data
 */
export function seedCache(key, data) {
    _cacheSet(key, { data, timestamp: Date.now() });
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * @template T
 * @param {string|null}  key         — cache key; null disables the request
 * @param {() => Promise<T>} fetcher — async function that returns the data
 * @param {object}       [options]
 * @param {number}       [options.staleTime=30_000]    — cache TTL in ms
 * @param {boolean}      [options.refetchOnFocus=false] — re-fetch on window focus
 * @param {boolean}      [options.enabled=true]         — set false to pause
 * @param {(err: Error) => void} [options.onError]      — error side-effect
 * @param {(data: T)    => void} [options.onSuccess]    — success side-effect
 * @returns {{
 *   data:    T | null,
 *   loading: boolean,
 *   error:   Error | null,
 *   refetch: () => void,
 *   isStale: boolean,
 * }}
 */
export function useRequest(key, fetcher, options = {}) {
    const { staleTime = 30_000, refetchOnFocus = false, enabled = true, onError, onSuccess } = options;

    const [state, setState] = useState(() => {
        // Hydrate from cache synchronously on first render
        if (key && CACHE.has(key)) {
            const cached = CACHE.get(key);
            const isStale = Date.now() - cached.timestamp > staleTime;
            return { data: cached.data, loading: isStale, error: null, isStale };
        }
        return { data: null, loading: !!key && enabled, error: null, isStale: false };
    });

    // Stable refs so callbacks never go stale inside the async function
    const fetcherRef = useRef(fetcher);
    const onErrorRef = useRef(onError);
    const onSuccessRef = useRef(onSuccess);
    useEffect(() => {
        fetcherRef.current = fetcher;
        onErrorRef.current = onError;
        onSuccessRef.current = onSuccess;
    });

    const isMounted = useRef(true);
    useEffect(() => {
        isMounted.current = true;
        return () => {
            isMounted.current = false;
        };
    }, []);

    const execute = useCallback(
        async (force = false) => {
            if (!key || !enabled) return;

            // Check cache (unless forced)
            if (!force && CACHE.has(key)) {
                const cached = CACHE.get(key);
                if (Date.now() - cached.timestamp <= staleTime) {
                    if (isMounted.current) {
                        setState({ data: cached.data, loading: false, error: null, isStale: false });
                    }
                    return;
                }
            }

            // Deduplicate: reuse the existing in-flight promise for this key
            let promise = IN_FLIGHT.get(key);
            if (!promise) {
                promise = fetcherRef.current();
                IN_FLIGHT.set(key, promise);

                // When it settles, remove it from the in-flight map and seed cache
                promise
                    .then((data) => {
                        _cacheSet(key, { data, timestamp: Date.now() });
                        IN_FLIGHT.delete(key);
                    })
                    .catch(() => {
                        IN_FLIGHT.delete(key);
                    });
            }

            if (isMounted.current) {
                setState((s) => ({ ...s, loading: true, error: null }));
            }

            try {
                const data = await promise;
                if (isMounted.current) {
                    setState({ data, loading: false, error: null, isStale: false });
                    onSuccessRef.current?.(data);
                }
            } catch (err) {
                if (isMounted.current) {
                    const error = err instanceof Error ? err : new Error(String(err));
                    setState((s) => ({ ...s, loading: false, error }));
                    onErrorRef.current?.(error);
                }
            }
        },
        [key, enabled, staleTime],
    );

    // Run on mount and whenever key / enabled changes
    useEffect(() => {
        execute(false);
    }, [execute]);

    // Refetch on window focus
    useEffect(() => {
        if (!refetchOnFocus) return;
        const handler = () => execute(false);
        window.addEventListener("focus", handler);
        return () => window.removeEventListener("focus", handler);
    }, [refetchOnFocus, execute]);

    const refetch = useCallback(() => execute(true), [execute]);

    return { ...state, refetch };
}

export default useRequest;
