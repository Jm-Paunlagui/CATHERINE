"use strict";

/**
 * @fileoverview Scheduler job keys tracked by `SchedulerStateService`. Lives in
 * constants so the cluster IPC validators can check a job name without
 * importing the service (and its logger).
 */

/**
 * Valid job keys. Extending to a new job: add the key here and call
 * `SchedulerStateService.record()` at the job site. Projects register their
 * own scheduled jobs here.
 * @type {readonly string[]}
 */
const KNOWN_JOBS = Object.freeze([
    // Scheduled DB Backup - recorded after every BackupScheduleService.triggerScheduledBackup().
    "dbBackup",
]);

module.exports = { KNOWN_JOBS };
