"use strict";

/**
 * @fileoverview Re-exports all message namespaces.
 *
 * Messages are the LOG-MESSAGE bucket: a string used in `logger.*` belongs
 * here, a string used in `throw new AppError(...)` belongs in
 * `constants/errors/`, and a string used in `sendSuccess(...)` belongs in
 * `constants/responses/`.
 *
 * Some templates here ARE thrown (e.g. `MSG.wrapError(...)` in the
 * oracle-mongo-wrapper), so check call sites before interpolating anything
 * sensitive.
 */

module.exports = {
  ...require("./oracle.messages"),
  ...require("./oracleWrapper.messages"),
  ...require("./auth.messages"),
  ...require("./middleware.messages"),
  ...require("./database.messages"),
  ...require("./admin.messages"),
  ...require("./auditLog.messages"),
  ...require("./metrics.messages"),
  ...require("./notification.messages"),
  ...require("./client.messages"),
  ...require("./cache.messages"),
  ...require("./changelog.messages"),
  ...require("./integrity.messages"),
  ...require("./resilience.messages"),
  ...require("./upload.messages"),
  ...require("./dataPurge.messages"),
  ...require("./dataBackup.messages"),
  ...require("./backupEmail.messages"),
  ...require("./sse.messages"),
  ...require("./logRetention.messages"),
  ...require("./inFlight.messages"),
  ...require("./server.messages"),
  ...require("./watchdog.messages"),
  ...require("./cluster.messages"),
};
