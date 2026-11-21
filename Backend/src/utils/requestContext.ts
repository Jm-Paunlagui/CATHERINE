

import { AsyncLocalStorage } from "async_hooks";

// Singleton AsyncLocalStorage that carries the current request ID
// through the entire async call chain. Set by TraceabilityMiddleware,
// read by logger so every log line in a request includes [req_xxx].
const requestContext = new AsyncLocalStorage<Record<string, any>>();

export { requestContext };
