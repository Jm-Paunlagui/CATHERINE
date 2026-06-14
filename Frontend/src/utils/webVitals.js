/**
 * @fileoverview Web Vitals collection using the browser's native PerformanceObserver API.
 * No npm packages — uses only platform APIs available in all modern browsers.
 *
 * Collected metrics:
 *   LCP  — Largest Contentful Paint         (type: largest-contentful-paint)
 *   CLS  — Cumulative Layout Shift          (type: layout-shift)
 *   FID  — First Input Delay                (type: first-input)
 *   INP  — Interaction to Next Paint        (type: event, approximated)
 *
 * Rating thresholds (Google Web Vitals 2024):
 *   LCP: good < 2500ms, needs-improvement < 4000ms, poor >= 4000ms
 *   CLS: good < 0.1,    needs-improvement < 0.25,   poor >= 0.25
 *   FID: good < 100ms,  needs-improvement < 300ms,  poor >= 300ms
 *   INP: good < 200ms,  needs-improvement < 500ms,  poor >= 500ms (approximated via event duration)
 *
 * Security note (CWE-20):
 *   This module emits only numeric metric values — no PII, no user identifiers,
 *   no page content. The onMetric callback receives { name, value, rating } only.
 */

// ─── Threshold maps ───────────────────────────────────────────────────────────

const THRESHOLDS = {
  LCP: [2500, 4000],
  CLS: [0.1, 0.25],
  FID: [100, 300],
  INP: [200, 500],
};

/**
 * Derive a rating string from a numeric value and threshold pair.
 *
 * @param {number}   value
 * @param {[number, number]} thresholds - [good_limit, poor_threshold]
 * @returns {"good"|"needs-improvement"|"poor"}
 */
function rate(value, [goodLimit, poorThreshold]) {
  if (value < goodLimit) return "good";
  if (value < poorThreshold) return "needs-improvement";
  return "poor";
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialize Web Vitals collection.
 * Registers PerformanceObserver listeners for all supported metric types.
 * Each metric fires `onMetric` once when first observed.
 *
 * Gracefully no-ops in environments where PerformanceObserver is unavailable
 * (SSR, old browsers, certain test environments).
 *
 * @param {(metric: { name: "LCP"|"CLS"|"FID"|"INP", value: number, rating: "good"|"needs-improvement"|"poor" }) => void} onMetric
 *   Callback invoked once per metric with the measured value and rating.
 *
 * @example
 * import { initWebVitals } from './webVitals';
 * initWebVitals(({ name, value, rating }) => {
 *   console.log(name, value, rating);
 * });
 */
export function initWebVitals(onMetric) {
  if (typeof PerformanceObserver === "undefined") return;

  // ── LCP ────────────────────────────────────────────────────────────────────
  // The last entry before the page becomes hidden is the definitive LCP.
  // We capture the running candidate and emit when the page is hidden or
  // when input occurs (which stops LCP observation per spec).
  try {
    let lcpCandidate = 0;

    const lcpObs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        lcpCandidate = entry.startTime;
      }
    });
    lcpObs.observe({ type: "largest-contentful-paint", buffered: true });

    const emitLcp = () => {
      if (lcpCandidate > 0) {
        onMetric({ name: "LCP", value: Math.round(lcpCandidate), rating: rate(lcpCandidate, THRESHOLDS.LCP) });
        lcpCandidate = 0; // emit once
      }
    };

    // Emit when page becomes hidden (tab switch, unload)
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") emitLcp();
    }, { once: true });

    // Emit on first user input (which stops LCP per spec)
    document.addEventListener("keydown", emitLcp, { once: true, capture: true });
    document.addEventListener("pointerdown", emitLcp, { once: true, capture: true });
  } catch {
    // largest-contentful-paint not supported — skip
  }

  // ── CLS ────────────────────────────────────────────────────────────────────
  // Accumulate layout-shift scores that occur without recent user input.
  // Report cumulative score once on page hide.
  try {
    let clsScore = 0;
    let sessionValue = 0;
    let sessionEntries = [];
    const GAP_MS = 1000;
    const MAX_SESSION_MS = 5000;

    const clsObs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // Only count shifts without recent user input (hadRecentInput === false)
        if (entry.hadRecentInput) continue;

        const firstEntry = sessionEntries[0];
        const lastEntry = sessionEntries[sessionEntries.length - 1];

        if (
          sessionValue &&
          entry.startTime - lastEntry.startTime < GAP_MS &&
          entry.startTime - firstEntry.startTime < MAX_SESSION_MS
        ) {
          sessionValue += entry.value;
          sessionEntries.push(entry);
        } else {
          sessionValue = entry.value;
          sessionEntries = [entry];
        }

        if (sessionValue > clsScore) clsScore = sessionValue;
      }
    });
    clsObs.observe({ type: "layout-shift", buffered: true });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" && clsScore > 0) {
        onMetric({
          name: "CLS",
          value: Math.round(clsScore * 10000) / 10000, // 4 decimal places
          rating: rate(clsScore, THRESHOLDS.CLS),
        });
      }
    }, { once: true });
  } catch {
    // layout-shift not supported — skip
  }

  // ── FID ────────────────────────────────────────────────────────────────────
  // First Input Delay: the delay from first user interaction to browser response.
  // Fires at most once per page.
  try {
    const fidObs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const delay = entry.processingStart - entry.startTime;
        onMetric({ name: "FID", value: Math.round(delay), rating: rate(delay, THRESHOLDS.FID) });
        fidObs.disconnect();
        break;
      }
    });
    fidObs.observe({ type: "first-input", buffered: true });
  } catch {
    // first-input not supported — skip
  }

  // ── INP ────────────────────────────────────────────────────────────────────
  // Interaction to Next Paint (approximated via event entries).
  // Tracks the worst-case interaction duration throughout the session.
  // Emits the worst observed value on page hide.
  try {
    let worstDuration = 0;

    const inpObs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.interactionId) continue; // skip non-interaction events
        const dur = entry.duration;
        if (dur > worstDuration) worstDuration = dur;
      }
    });
    inpObs.observe({ type: "event", buffered: true, durationThreshold: 16 });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" && worstDuration > 0) {
        onMetric({
          name: "INP",
          value: Math.round(worstDuration),
          rating: rate(worstDuration, THRESHOLDS.INP),
        });
      }
    }, { once: true });
  } catch {
    // event type INP not supported — skip
  }
}
