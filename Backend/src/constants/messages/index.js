"use strict";

/**
 * @fileoverview Re-exports all message namespaces.
 * Messages are used ONLY in logger calls — never thrown or sent to clients.
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
  ...require("./resilience.messages"),
};
