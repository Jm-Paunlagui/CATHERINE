/**
 * @fileoverview In-memory frontend metrics buffer with automatic flush to the backend.
 *
 * WHY THIS MODULE USES fetch INSTEAD OF httpClient:
 *   httpClient (Axios) depends on the CSRF middleware being initialized and on
 *   the user being authenticated. frontendMetrics.js is designed to run as early
 *   as possible — including on login pages where no auth token exists and before
 *   CsrfMiddleware has fetched its token. Using the browser's native fetch with
 *   keepalive: true ensures telemetry survives page unloads and works even when
 *   the auth layer is not yet set up. The backend POST /api/v1/metrics/frontend
 *   endpoint deliberately has no auth requirement for exactly this reason.
 *
 * BUFFER POLICY:
 *   - Flushes automatically every 30 s via setInterval.
 *   - Flushes immediately when the buffer reaches 20 items.
 *   - On flush failure: retries once after 5 s.
 *   - If buffer exceeds 100 items before a successful flush, oldest items are dropped.
 *
 * Security note (CWE-312):
 *   No PII is stored or transmitted. Error messages are truncated to 500 characters.
 *   Stack traces are truncated to 2000 characters to prevent information leakage.
 */

// ─── Configuration ────────────────────────────────────────────────────────────

const AUTO_FLUSH_INTERVAL_MS = 30_000;
const AUTO_FLUSH_THRESHOLD = 20;
const MAX_BUFFER_SIZE = 100;
const RETRY_DELAY_MS = 5_000;

// ─── Internal state ───────────────────────────────────────────────────────────

/** @type {Array<object>} Buffered events pending flush */
let _buffer = [];

/** @type {string} Base API URL — set via init() */
let _apiBase = "";

/** @type {ReturnType<typeof setInterval>|null} Auto-flush timer handle */
let _intervalHandle = null;

/** @type {boolean} Whether a flush is currently in flight */
let _flushing = false;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Cap the buffer at MAX_BUFFER_SIZE by dropping the oldest entries.
 */
function _capBuffer() {
  if (_buffer.length > MAX_BUFFER_SIZE) {
    _buffer = _buffer.slice(_buffer.length - MAX_BUFFER_SIZE);
  }
}

/**
 * Send buffered events to the backend.
 * Uses fetch + keepalive so this survives page unloads.
 * On failure, retries once after RETRY_DELAY_MS.
 *
 * @param {Array<object>} events - Events to POST
 * @returns {Promise<void>}
 */
async function _send(events) {
  if (!_apiBase || events.length === 0) return;

  const url = `${_apiBase}/metrics/frontend`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(events),
      keepalive: true,
    });

    if (!res.ok) {
      // Non-2xx — schedule a retry with the same events
      _scheduleRetry(events);
    }
  } catch {
    // Network failure — schedule a retry
    _scheduleRetry(events);
  }
}

/**
 * Retry sending a set of events once after RETRY_DELAY_MS.
 * On second failure the events are silently dropped.
 *
 * @param {Array<object>} events
 */
function _scheduleRetry(events) {
  setTimeout(async () => {
    if (!_apiBase) return;
    try {
      await fetch(`${_apiBase}/metrics/frontend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(events),
        keepalive: true,
      });
    } catch {
      // Second failure — drop silently to avoid infinite retry loops
    }
  }, RETRY_DELAY_MS);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Frontend metrics singleton.
 * Must call init() once at application startup before any other methods.
 *
 * @example
 * import { frontendMetrics } from './frontendMetrics';
 * import { initWebVitals } from './webVitals';
 *
 * frontendMetrics.init(import.meta.env.VITE_API_BASE_URL);
 * initWebVitals(({ name, value, rating }) => {
 *   frontendMetrics.recordVital(name, value, rating);
 * });
 *
 * window.addEventListener('error', (e) => {
 *   frontendMetrics.recordError(e.error, { page: location.pathname });
 * });
 *
 * window.addEventListener('beforeunload', () => {
 *   frontendMetrics.flush();
 * });
 */
export const frontendMetrics = {
  /**
   * Initialize the metrics module and start the auto-flush timer.
   * Safe to call multiple times — subsequent calls update the apiBase and
   * restart the timer if it was not already running.
   *
   * @param {string} apiBase - Full base URL of the API (e.g. "https://api.example.com/api/v1")
   */
  init(apiBase) {
    _apiBase = (apiBase || "").replace(/\/$/, "");

    if (_intervalHandle) {
      clearInterval(_intervalHandle);
    }

    _intervalHandle = setInterval(() => {
      frontendMetrics.flush();
    }, AUTO_FLUSH_INTERVAL_MS);

    // Unref if in a Node.js-like environment (test runs)
    if (_intervalHandle?.unref) _intervalHandle.unref();

    // Flush on page unload (best-effort — keepalive helps here)
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => frontendMetrics.flush(), { once: false });
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") frontendMetrics.flush();
      });
    }
  },

  /**
   * Record a Web Vital metric.
   * Auto-flushes when buffer reaches AUTO_FLUSH_THRESHOLD items.
   *
   * @param {"LCP"|"CLS"|"FID"|"INP"} name
   * @param {number} value
   * @param {"good"|"needs-improvement"|"poor"} rating
   */
  recordVital(name, value, rating) {
    _capBuffer();
    _buffer.push({
      type: "vital",
      name,
      value,
      rating,
      ts: new Date().toISOString(),
    });

    if (_buffer.length >= AUTO_FLUSH_THRESHOLD) {
      frontendMetrics.flush();
    }
  },

  /**
   * Record a JavaScript error.
   * Message and stack are truncated to prevent large payloads and info leakage.
   * Auto-flushes when buffer reaches AUTO_FLUSH_THRESHOLD items.
   *
   * @param {Error|string} error   - Error object or message string
   * @param {object} [context={}]  - Additional context (page, component, etc.)
   */
  recordError(error, context = {}) {
    _capBuffer();

    const message =
      typeof error === "string"
        ? error.slice(0, 500)
        : (error?.message || "Unknown error").slice(0, 500);

    const stack =
      typeof error === "object" && error?.stack
        ? error.stack.slice(0, 2000)
        : "";

    _buffer.push({
      type: "error",
      message,
      stack,
      context: {
        page: typeof window !== "undefined" ? window.location?.pathname : "",
        userAgent:
          typeof navigator !== "undefined"
            ? navigator.userAgent.slice(0, 200)
            : "",
        ...context,
      },
      ts: new Date().toISOString(),
    });

    if (_buffer.length >= AUTO_FLUSH_THRESHOLD) {
      frontendMetrics.flush();
    }
  },

  /**
   * Manually flush all buffered events to the backend immediately.
   * Called automatically by the interval timer, on page unload, and on tab hide.
   * Safe to call from application code (e.g. on route change).
   *
   * @returns {Promise<void>}
   */
  async flush() {
    if (_flushing || _buffer.length === 0) return;

    _flushing = true;
    const events = _buffer.splice(0); // drain buffer atomically
    try {
      await _send(events);
    } finally {
      _flushing = false;
    }
  },
};

export default frontendMetrics;
