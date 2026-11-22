

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

export * from "./oracle.messages";
export * from "./oracleWrapper.messages";
export * from "./auth.messages";
export * from "./middleware.messages";
export * from "./database.messages";
export * from "./admin.messages";
export * from "./auditLog.messages";
export * from "./metrics.messages";
export * from "./notification.messages";
export * from "./client.messages";
export * from "./cache.messages";
export * from "./changelog.messages";
export * from "./integrity.messages";
export * from "./resilience.messages";
export * from "./upload.messages";
export * from "./dataPurge.messages";
export * from "./dataBackup.messages";
export * from "./backupEmail.messages";
export * from "./sse.messages";
export * from "./logRetention.messages";
export * from "./inFlight.messages";
export * from "./server.messages";
export * from "./watchdog.messages";
export * from "./cluster.messages";
