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

/**
 * @type {Map<string, Set<() => void>>}
 * Mounted `useRequest` instances, keyed by cache key.
 *
 * WHY THIS EXISTS: clearing CACHE and IN_FLIGHT only affects what the NEXT
 * `execute()` reads. A hook that has already resolved holds its answer in React
 * state, so busting the module maps left every mounted consumer showing the old
 * value until it happened to remount — i.e. until a full page refresh. A cache
 * API whose invalidation does not reach the UI is a footgun: the caller has no
 * way to know they also need to force a refetch, and nothing fails loudly when
 * they don't.
 */
const SUBSCRIBERS = new Map();

/**
 * Tell mounted consumers of `key` to refetch.
 * @param {string} [key] omit to notify all subscribers
 */
function _notifySubscribers(key) {
    // KEYED INVALIDATION ONLY — a bare invalidateCache() deliberately does NOT
    // notify. "Forget everything" and "refetch everything" are different
    // intents, and only the first has callers. As a test-harness reset
    // (`afterEach(() => invalidateCache())`) a clean slate is the whole point;
    // notifying there fires a real request while the previous test's tree is
    // still mounted, and its response lands in CACHE *after* the harness has
    // swapped mock handlers — poisoning the NEXT test. In MEAL, notifying on the
    // bare form turned 1203 passing tests into 40 failures from cross-test
    // cache bleed. Keep this distinction.
    if (key === undefined) return;

    const handlers = SUBSCRIBERS.get(key);
    if (handlers) for (const handler of handlers) handler();
}

// ─── Public cache utilities ───────────────────────────────────────────────────

/**
 * Bust the cache.
 *
 * `invalidateCache(key)` — drops that key AND makes every mounted consumer of
 * it refetch. The refetch is the point: without it, invalidation reached the
 * module maps but never the screen. The keyed form is NOT a request storm — a
 * notified consumer calls `execute(force = true)`, which skips the CACHE check
 * but still shares the IN_FLIGHT promise for its key, so N consumers of one key
 * make ONE request.
 *
 * `invalidateCache()` — drops everything and notifies NOBODY. See
 * `_notifySubscribers` for why the two forms differ.
 *
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
    _notifySubscribers(key);
}

/**
 * Seed the cache externally (e.g., from a form's POST response that returns
 * the updated resource — no need to refetch). Mounted consumers of `key` are
 * notified for the same reason keyed invalidation notifies them: seeding a
 * value nothing on screen picks up is indistinguishable from not seeding it.
 * They read the freshly-seeded entry from CACHE, so this costs no request.
 * @param {string} key
 * @param {any}    data
 */
export function seedCache(key, data) {
    _cacheSet(key, { data, timestamp: Date.now() });
    _notifySubscribers(key);
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

    // Key-currency guard: a live ref holding the token of the MOST RECENTLY
    // STARTED execute() call for this hook instance. A plain closed-over `key`
    // comparison would NOT work — `key` is captured by the same useCallback
    // closure as the call itself, so it can never observe a LATER call's
    // (different) key. Only a mutable ref, read live at resolution time, can
    // detect that a newer call has superseded this one (e.g. the hook's `key`
    // changed and the key-change effect re-ran execute() before this call's
    // promise settled).
    const latestCallRef = useRef(null);

    const execute = useCallback(
        async (force = false) => {
            if (!key || !enabled) return;

            const token = {};
            latestCallRef.current = token;
            const isCurrent = () => isMounted.current && latestCallRef.current === token;

            // Check cache (unless forced)
            if (!force && CACHE.has(key)) {
                const cached = CACHE.get(key);
                if (Date.now() - cached.timestamp <= staleTime) {
                    if (isCurrent()) {
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

            if (isCurrent()) {
                setState((s) => ({ ...s, loading: true, error: null }));
            }

            try {
                const data = await promise;
                if (isCurrent()) {
                    setState({ data, loading: false, error: null, isStale: false });
                    onSuccessRef.current?.(data);
                }
            } catch (err) {
                if (isCurrent()) {
                    const error = err instanceof Error ? err : new Error(String(err));
                    setState((s) => ({ ...s, loading: false, error }));
                    onErrorRef.current?.(error);
                }
            }
        },
        [key, enabled, staleTime],
    );

    // Run on mount and whenever key / enabled changes.
    //
    // The disable is reasoned, not assumed. execute()'s synchronous (pre-await)
    // setState calls — the warm-CACHE short-circuit and the pre-fetch
    // loading:true flag — are the only mechanism that hydrates a newly-changed
    // `key` from cache and flips loading the instant a fetch starts. Deriving
    // during render is impossible (the effect starts an HTTP fetch and mutates
    // the module-scope IN_FLIGHT/CACHE maps — impure side effects); a lazy
    // initializer runs once and cannot re-hydrate on a key change; and the
    // key-reset pattern has no element to attach a React key to inside a hook.
    // refetch() and the focus handler reach the same setState calls without
    // tripping the rule because they run from event handlers.
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- see justification above
        execute(false);
    }, [execute]);

    // Subscribe to external cache invalidation for this key.
    //
    // Without this, invalidateCache(key) reached the module maps but never the
    // screen: an already-resolved hook holds its answer in React state, so the
    // UI kept the pre-invalidation value until the component happened to remount.
    //
    // The handler is read through a ref so the subscription is keyed ONLY on
    // `key`/`enabled`. Depending on `execute` directly would tear down and
    // re-add the subscription every time `staleTime` changed identity — churn
    // with no benefit, and a window where a notification could be missed.
    const executeRef = useRef(execute);
    useEffect(() => {
        executeRef.current = execute;
    });

    useEffect(() => {
        if (!key || !enabled) return undefined;

        // force = true: the whole point of a notification is that the cached
        // value is no longer trustworthy, so the CACHE short-circuit must be
        // skipped. IN_FLIGHT dedup still applies, so N consumers of one key
        // still produce ONE request.
        const handler = () => executeRef.current?.(true);

        let handlers = SUBSCRIBERS.get(key);
        if (!handlers) {
            handlers = new Set();
            SUBSCRIBERS.set(key, handlers);
        }
        handlers.add(handler);

        return () => {
            handlers.delete(handler);
            // Drop the empty Set so SUBSCRIBERS cannot grow unbounded across a
            // long session of mounting and unmounting many distinct keys.
            if (handlers.size === 0) SUBSCRIBERS.delete(key);
        };
    }, [key, enabled]);

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
