"use strict";

/**
 * @fileoverview Log message templates for process-level server lifecycle
 * events in `server.js` and `src/utils/shutdown/*` — shutdown budget,
 * request grace and exit codes.
 */

const serverMessages = {
  SHUTDOWN_EXITING: (signal, code) =>
    `Shutdown (${signal}) complete — exiting with code ${code}.`,
  SHUTDOWN_BUDGET: (phaseMs, graceMs, pendingTasks) =>
    `Shutdown budget: ${phaseMs}ms before teardown; in-flight requests may finish for up to ${graceMs}ms (${pendingTasks} tracked background task(s) pending).`,
  SHUTDOWN_REQUEST_GRACE: (count, ms) =>
    `Shutdown: waiting up to ${ms}ms for ${count} in-flight request(s) to finish — new connections are refused.`,
  SHUTDOWN_REQUESTS_FINISHED: (ms) =>
    `Shutdown: every in-flight request finished after ${ms}ms.`,
  SHUTDOWN_REQUESTS_CUT: (count, ms) =>
    `Shutdown: ${count} in-flight request(s) still running after the ${ms}ms grace — connections force-closed.`,
  SHUTDOWN_CUT_HOOK_FAILED: (err) =>
    `Shutdown: the requests-cut hook failed: ${err}.`,
  SHUTDOWN_FORCED_EXIT: (ms) =>
    `Forced shutdown after timeout (${ms}ms) — exiting with code 1.`,
  SHUTDOWN_CRASH_FAILSAFE: (signal, ms) =>
    `Shutdown: ${signal} is a crash — failsafe armed at ${ms}ms (crash schedule), not the full forced-exit budget.`,
  SHUTDOWN_NOTIFIER_STEP_FAILED: (step, err) =>
    `Shutdown: alert notifier ${step} failed — ${err}`,
  /** A non-notifier shutdown step failed (lifecycle emails, data-teardown hook); the sequence continues. */
  SHUTDOWN_STEP_FAILED: (step, err) =>
    `Shutdown: ${step} failed — ${err}`,
  SHUTDOWN_NOTIFY_FAILED: (event, err) =>
    `Shutdown alert email (${event}) failed: ${err}.`,
  SHUTDOWN_EARLY_AUDIT_FLUSH_FAILED: (err) =>
    `Shutdown: early (non-final) audit flush failed: ${err}. The final flush still runs at teardown.`,
  SHUTDOWN_WAITING: (count, elapsedMs, capMs, top) =>
    `Shutdown: still waiting for ${count} in-flight request(s) after ${Math.round(elapsedMs / 1000)}s (cap ${Math.round(capMs / 1000)}s). Oldest: ${
      top.length
        ? top
            .map(
              (r) =>
                `${r.method} ${r.path} (age ${Math.round(r.ageMs / 1000)}s, idle ${r.idleMs == null ? "n/a" : `${Math.round(r.idleMs / 1000)}s`})`,
            )
            .join("; ")
        : "none"
    }.`,
  SHUTDOWN_GRACE_SHORTENED_CRASH: (signal, ms) =>
    `Shutdown: ${signal} crash arrived during a graceful stop — in-flight request grace shortened to ${ms}ms.`,
  SHUTDOWN_IDLE_CUTS: (count) =>
    `Shutdown: ${count} in-flight request(s) were cut by the idle watchdog (stopped making progress).`,
  SHUTDOWN_SHORTEN_FAILED: (err) =>
    `Shutdown: shortening the grace after a crash failed: ${err}.`,
  NOTIFY_DRAIN_MS_CLAMPED: (raw, max, clamped) =>
    `NOTIFY_DRAIN_MS="${raw}" invalid or out of [0, ${max}] — clamped to ${clamped}ms.`,
  FORCED_EXIT_MS_CLAMPED: (raw, clamped, min, max) =>
    `SHUTDOWN_FORCED_EXIT_MS="${raw}" invalid or out of [${min}, ${max}] — using ${clamped}ms.`,

  // ── Restart detection: src/utils/lifecycle/ServerRunMarker + StartupNotifier
  RUN_MARKER_FIRST_BOOT: (filePath) =>
    `[RunMarker] RUN_MARKER_FIRST_BOOT no previous run record at ${filePath} - first start with restart tracking.`,
  RUN_MARKER_PREVIOUS_CLEAN: (pid, exitCode, reason, stoppedAtIso) =>
    `[RunMarker] RUN_MARKER_PREVIOUS_CLEAN previous process (PID ${pid}) stopped at ${stoppedAtIso} with exit code ${exitCode} (${reason}).`,
  RUN_MARKER_UNCLEAN: (pid, state, lastHeartbeatIso, downSec) =>
    `[RunMarker] RUN_MARKER_UNCLEAN previous process (PID ${pid}) ended without its shutdown sequence: last state ${state}, last alive ${lastHeartbeatIso}, down about ${downSec}s.`,
  RUN_MARKER_UNREADABLE: (filePath, cause) =>
    `[RunMarker] RUN_MARKER_UNREADABLE previous run record ${filePath} could not be read: ${cause}.`,
  RUN_MARKER_HANDOVER: (pid) =>
    `[RunMarker] RUN_MARKER_HANDOVER the previous cron-leader worker (PID ${pid}) belonged to this cluster run - taking over the record, no restart email.`,
  BOOT_ANNOUNCE_POOLS_PENDING: (ms) =>
    `[RunMarker] BOOT_ANNOUNCE_POOLS_PENDING Boot email sent before the database pools settled (waited ${ms} ms); recipients may fall back to SERVER_NOTIFY_TO; a still-settling pool can delay delivery.`,
  RUN_MARKER_WRITE_FAILED: (filePath, cause) =>
    `[RunMarker] RUN_MARKER_WRITE_FAILED could not write ${filePath}: ${cause}. Restart detection is degraded until a write succeeds (reported once per process).`,
  RUN_MARKER_PATH_OVERRIDE_IGNORED: (value) =>
    `[RunMarker] SERVER_RUN_MARKER_PATH="${value}" is not an absolute path - ignored.`,
  RUN_MARKER_PATH_OVERRIDE_REFUSED: (value) =>
    `[RunMarker] SERVER_RUN_MARKER_PATH="${value}" ignored: the override is for tests only and is refused when NODE_ENV=production.`,
  RUN_MARKER_FOREIGN_HOST: (filePath) =>
    `[RunMarker] RUN_MARKER_FOREIGN_HOST the record at ${filePath} was written by another host (e.g. a build-machine smoke run packaged by mistake) - treating this as a first start, no unclean-restart alarm.`,
  STARTUP_NOTICE_THROTTLED: (lastIso) =>
    `Server started notice skipped: the last one was sent at ${lastIso} (under 15 minutes ago).`,
  STARTUP_NOTIFY_FAILED: (event, err) =>
    `Startup alert email (${event}) failed: ${err}.`,
  SCHEDULER_ACTIVITY_RECORDED: (job, status) =>
    `[SchedulerState] Activity recorded — job=${job} status=${status}.`,
  SCHEDULER_UNKNOWN_JOB: (job) =>
    `[SchedulerState] Unknown job key '${job}' — ignored.`,
  DEMO_MODE_POOLS_SKIPPED:
    "DEMO_MODE=true — Oracle pools not opened; models use the in-memory demo store and DB-backed jobs are not scheduled.",
};

module.exports = { serverMessages };
