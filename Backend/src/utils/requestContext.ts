

import { AsyncLocalStorage } from "async_hooks";

// Singleton AsyncLocalStorage that carries the current request ID
// through the entire async call chain. Set by TraceabilityMiddleware,
// read by logger so every log line in a request includes [req_xxx].
/** What one request carries through its async chain. */
type RequestStore = {
    requestId?: string;
    progress?: import("./progress/ProgressScope").ProgressScope;
};

const requestContext = new AsyncLocalStorage<RequestStore>();

export { requestContext };
export type { RequestStore };
