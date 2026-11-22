/**
 * Process environment bootstrap (side-effect module) — the FIRST import in server.ts.
 *
 * ES modules evaluate every import before the importing module's body, so these
 * steps cannot sit in server.ts's body: every other module would already have
 * been evaluated (and may have read process.env or built a Date) by then.
 * server.ts imports this module first; ESM evaluates imports in source order.
 */
import dotenv from "dotenv";
import { IS_COMPILED, appPath } from "../utils/runtimePaths";

// ─── libuv thread pool sizing (must run before any async I/O) ────────────────
// node-oracledb (Thick mode) executes EVERY database call on a libuv worker
// thread. The default pool of 4 threads serialises concurrent Oracle work:
// only 4 queries actually execute at once and the rest queue — under a burst of
// N concurrent requests this inflates P95 by roughly N/4 × query-time
// regardless of how large the connection pool is. So the thread pool must cover
// the SUM of every connection pool's poolMax, plus headroom for non-DB worker
// use (fs / crypto / dns).
//
// DERIVATION — re-derive this if any poolMax in src/config/database.ts changes:
//     SUM(poolMax)  = appDb 20 + appDbBulk 6 = 26
//     + headroom    = 22  (fs / crypto / dns worker-thread work)
//     ────────────────────────────────────────────────────────
//     UV_THREADPOOL_SIZE = 48
//
// This is a STATIC literal on purpose: it must be set before the thread pool is
// created (first async I/O), so it cannot be computed from the pool registry at
// runtime and cannot live in .env. If you change a poolMax, recompute the sum
// above and update this literal by hand. Override with a real OS environment
// variable when needed. See .env.example for documentation.
if (!process.env.UV_THREADPOOL_SIZE) {
    process.env.UV_THREADPOOL_SIZE = "48";
}


// In the compiled exe resolve .env NEXT TO THE EXE, not the working
// directory — a service/scheduled-task can start the exe with cwd anywhere
// (e.g. System32), and bootGuard reads process.env immediately below.
dotenv.config({
    path: IS_COMPILED ? appPath(".env") : ".env",
});

// ─── Process timezone (must run before ANYTHING constructs a Date) ───────────
// node-oracledb converts DATE / TIMESTAMP columns to JS Dates using the
// PROCESS timezone, and converts them back the same way on write. The schema
// stores LOCAL wall-clock in the deployment's zone, so a process running in
// any other zone reads and writes every timestamp shifted: API dates are off
// by the offset, exact-time scheduler timers (`ev.at.getTime() - Date.now()`)
// fire hours out, and every `new Date()` write lands shifted.
//
// Pinning it here rather than relying on the launch environment means the app
// is correct however it is started — a service, a scheduled task, a bare
// `bun server.ts`, or the compiled exe on a machine whose clock is set to anything.
// Set APP_TZ to the zone the database's wall-clock values are written in.
//
// Order matters twice over. dotenv runs FIRST so an APP_TZ written in the
// repo/cwd `.env` is honoured (a real OS environment APP_TZ still wins —
// dotenv never overrides). TZ is then assigned before the first Date is
// constructed: neither the polyfill nor dotenv builds one, and Node (>= 13)
// honours a runtime assignment to process.env.TZ, so it takes effect for
// every Date created afterwards.
process.env.TZ = process.env.APP_TZ || "Asia/Manila";
