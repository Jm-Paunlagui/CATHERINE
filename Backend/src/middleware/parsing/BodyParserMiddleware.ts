

/**
 * @fileoverview Body parsing middleware — JSON + URL-encoded, plus the empty-body default.
 * Limits payload size to prevent abuse.
 */

import type { NextFunction, Request, Response } from "express";
import bodyParser from "body-parser";

/**
 * Wraps a body-parser handler so a `Content-Encoding: br` body is refused with
 * 415 before body-parser hands it to zlib's Brotli decoder (Node.js
 * CVE-2026-111497: malformed Brotli input can corrupt process memory). This
 * runs pre-auth at chain step 4, and no client of ours compresses request
 * bodies. gzip/deflate are unaffected by the advisory and stay accepted.
 *
 * @param {import("express").RequestHandler} parser
 * @returns {import("express").RequestHandler}
 */
function refuseBrotli(parser: import("express").RequestHandler): import("express").RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const encoding = String(req.headers["content-encoding"] ?? "").toLowerCase();
    if (encoding.split(",").some((c) => c.trim() === "br")) {
      const err = Object.assign(new Error("Unsupported content encoding \"br\"."), {
        status: 415,
        statusCode: 415,
        type: "encoding.unsupported",
      });
      return next(err);
    }
    return parser(req, res, next);
  };
}

class BodyParserMiddleware {
  declare _defaultBody: (req: any, _res: any, next: any) => void;
  declare _urlencodedParser: import("express").RequestHandler<import("express-serve-static-core").ParamsDictionary, any, any, import("qs").ParsedQs, Record<string, any>>;
  declare _jsonParser: import("express").RequestHandler<import("express-serve-static-core").ParamsDictionary, any, any, import("qs").ParsedQs, Record<string, any>>;
  declare _limit: any;
  constructor(options: Record<string, any> = {}) {
    this._limit = options.limit ?? process.env.BODY_LIMIT ?? "10mb";

    this._jsonParser = refuseBrotli(bodyParser.json({ limit: this._limit }));
    this._urlencodedParser = refuseBrotli(
      bodyParser.urlencoded({
        extended: true,
        limit: this._limit,
      }),
    );

    // Express 5 / body-parser 2 leave req.body UNDEFINED when no parser matched
    // the Content-Type (e.g. text/plain) or the request had no body. Restore the
    // Express 4 contract: req.body is always an object. Only fills the gap —
    // never overwrites a body a parser already produced.
    this._defaultBody = (req, _res, next) => {
      if (req.body === undefined) req.body = {};
      next();
    };
  }

  get jsonHandler() {
    return this._jsonParser;
  }

  get urlencodedHandler() {
    return this._urlencodedParser;
  }

  get defaultBodyHandler() {
    return this._defaultBody;
  }
}

const defaultBodyParser = new BodyParserMiddleware();
export { BodyParserMiddleware, defaultBodyParser };
