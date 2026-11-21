// @ts-nocheck -- TS migration: delete this line when the file is typed (bun run typecheck).


/**
 * @fileoverview Stateless helpers over the ambient ProgressScope.
 *
 * The scope rides on the request AsyncLocalStorage store under the `progress`
 * key (see TraceabilityMiddleware). Outside a watched context (supertest, cron,
 * scripts) there is no scope, so `touch()` and `throwIfAborted()` are no-ops —
 * call them freely from hot paths.
 *
 * Functions (not a class): pure wrappers, no state of their own.
 */

import { requestContext } from "../requestContext";
import { AppError, REQUEST_ERRORS } from "../../constants/errors";
import { HTTP_STATUS } from "../../constants";
import { ProgressScope } from "./ProgressScope";
import { defaultIdleWatchdog } from "./IdleWatchdog";

/**
 * @returns {ProgressScope|undefined} The scope of the current async context.
 */
function currentScope(): ProgressScope | undefined {
    return requestContext.getStore()?.progress;
}

/**
 * Record progress on the current scope (no-op when none).
 * @param {string} source - What made progress (shown in the stall log).
 */
function touch(source: string) {
    currentScope()?.touch(source);
}

/**
 * Throw the current scope's abort error, if aborted (no-op when none).
 * @throws {Error} The scope's `abortError`.
 */
function throwIfAborted() {
    currentScope()?.throwIfAborted();
}

/**
 * Run `fn` with `scope` as the ambient scope, keeping `requestId`.
 * @template T
 * @param {ProgressScope} scope
 * @param {() => T} fn
 * @returns {T}
 */
function runInScope<T>(scope: ProgressScope, fn: () => T): T {
    const store = { ...(requestContext.getStore() ?? {}), progress: scope };
    return requestContext.run(store, fn);
}

/**
 * Run `fn` OUTSIDE any progress scope. The ALS store keeps its other keys
 * (`requestId`, ...) but `progress` is undefined, so DB calls made by `fn` are
 * never refused because the request was cut by the watchdog. Use it for
 * compensations and cleanup writes that MUST run after a cut (release a
 * download slot, delete a RUNNING job row, re-arm a timer).
 *
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function runDetached<T>(fn: () => T): T {
    const store = { ...(requestContext.getStore() ?? {}), progress: undefined };
    return requestContext.run(store, fn);
}

/**
 * Run `fn` under a child scope watched by the default IdleWatchdog.
 *
 * If the child goes idle past `idleLimitMs` (or the parent request scope is
 * aborted) the scope is aborted and the returned promise REJECTS with the
 * abort error even if `fn` never settles — so callers' locks release. Cleanup
 * (unregister, detach) is idempotent and always runs.
 *
 * @template T
 * @param {object} options
 * @param {string} options.label
 * @param {number} options.idleLimitMs
 * @param {(scope: ProgressScope, idleMs: number) => (Error|void)} [options.onStall] - Called once on stall; may return the Error to reject with (default: 504 RequestStalledError).
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function runGuarded<T>({ label, idleLimitMs, onStall }: { label: string; idleLimitMs: number; onStall?: (scope: ProgressScope, idleMs: number) => (Error | void); }, fn: () => Promise<T>): Promise<T> {
    const scope = new ProgressScope({
        label,
        idleLimitMs,
        parent: currentScope() ?? null,
    });

    let disposed = false;
    let unregister = () => {};
    let offAbort = () => {};
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        unregister();
        offAbort();
        scope.dispose();
    };

    try {
        if (scope.aborted) throw scope.abortError;

        unregister = defaultIdleWatchdog.register(scope, (s, idleMs) => {
            let err;
            try {
                err = onStall?.(s, idleMs);
            } catch {
                /* a failing onStall must not prevent the abort */
            }
            s.abort(
                err instanceof Error
                    ? err
                    : new AppError(REQUEST_ERRORS.STALLED, HTTP_STATUS.GATEWAY_TIMEOUT, {
                          type: "RequestStalledError",
                          hint: REQUEST_ERRORS.STALLED_HINT,
                      }),
            );
        });

        const aborted = new Promise((_, reject) => {
            offAbort = scope.onAbort(reject);
        });
        const work = Promise.resolve().then(() => runInScope(scope, fn));
        // The losing side must never become an unhandled rejection.
        work.catch(() => {});
        aborted.catch(() => {});

        return await Promise.race([work, aborted]);
    } finally {
        dispose();
    }
}

export { currentScope, touch, throwIfAborted, runInScope, runDetached, runGuarded };
