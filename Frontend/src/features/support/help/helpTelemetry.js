/**
 * helpTelemetry.js — fire-and-forget "zero-result search" reporter for Help.
 *
 * WHAT THIS FILE DOES
 * ───────────────────
 * When a Help search (in either the full Help Center or the Help Assistant
 * launcher) returns NOTHING, this reports the query to the backend telemetry
 * endpoint `POST /client/help-miss`. Those misses are mined periodically to
 * grow the curated SYNONYMS table in helpSearch.js — a query users type but the
 * corpus cannot answer is either a missing alias or a genuine content gap. This
 * is the data-driven feedback loop that keeps the deterministic engine getting
 * smarter WITHOUT adding a model: real user language in, hand-curated aliases
 * out.
 *
 * NOTE: the backend `client/help-miss` route is intentionally not shipped with
 * this template. Telemetry therefore degrades silently — every send is
 * swallowed (see below), so the Help surfaces work identically with or without
 * a backend collector. A downstream project can add the route to start mining.
 *
 * WHY FIRE-AND-FORGET
 * ───────────────────
 * The user's search already failed; telemetry must never turn that into a
 * second, visible failure. Every network/CSRF/auth error is swallowed — this
 * module NEVER throws and NEVER rejects to the caller.
 *
 * DEDUPE (Performance + log hygiene)
 * ──────────────────────────────────
 * A user typing "ballanse" produces a zero-result on every intermediate
 * keystroke ("b", "ba", "bal", …). Reporting each would flood the log with
 * noise and burn the endpoint's rate limit. A per-session Set records every
 * query already reported so each distinct miss is sent AT MOST ONCE per page
 * load. Callers additionally debounce (only report the settled query), so in
 * practice one miss = one line.
 *
 * SECURITY (Cybersecurity)
 * ────────────────────────
 * The query is public help-topic vocabulary — no secrets, tokens, or PII. It
 * is bounded client-side before send. No DOM sink here.
 *
 * @module helpTelemetry
 */

import httpClient from "../../../middleware/HttpClient";

/** Longest query worth reporting; anything past this is bounded before send. */
const MAX_QUERY_LEN = 120;

/**
 * Per-page-load memory of queries already reported, so a repeated miss (user
 * re-typing the same failing term, or two surfaces missing the same query) is
 * sent only once. Cleared naturally on full page reload. A Set keeps membership
 * O(1); the size is bounded by the number of DISTINCT failing queries in one
 * session, which is tiny.
 * @type {Set<string>}
 */
const reported = new Set();

/**
 * Report a zero-result Help search, at most once per distinct query per session.
 * Safe to call on every zero-match render — the dedupe guard makes repeats free.
 *
 * @param {string} query - the normalised (trimmed, lowercased) query that missed
 * @param {"assistant"|"center"} surface - which Help surface produced the miss
 * @returns {void}
 */
export function reportHelpMiss(query, surface) {
    const q = typeof query === "string" ? query.trim().slice(0, MAX_QUERY_LEN) : "";
    if (!q) return; // nothing to learn from an empty query

    const key = `${surface}::${q}`;
    if (reported.has(key)) return; // already reported this miss this session
    reported.add(key);

    // Fire-and-forget: never await, never surface a failure to the caller. The
    // user's search already failed; a telemetry error must stay invisible.
    httpClient.post("client/help-miss", { query: q, surface }).catch(() => {
        // Swallow — telemetry must never throw. Roll back the dedupe entry so a
        // transient failure can be retried on the user's next identical miss.
        reported.delete(key);
    });
}

/**
 * Test-only hook to clear the per-session dedupe memory between cases.
 * Not used in production code.
 * @returns {void}
 */
export function __resetHelpTelemetry() {
    reported.clear();
}
