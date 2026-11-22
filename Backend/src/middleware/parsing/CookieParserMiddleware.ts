

/**
 * @fileoverview Cookie parsing middleware.
 * Uses COOKIE_SECRET env var for signed cookies when available.
 */

import type { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";

class CookieParserMiddleware {
  declare _parser: import("express").RequestHandler<import("express-serve-static-core").ParamsDictionary, unknown, unknown, import("qs").ParsedQs, Record<string, unknown>>;
  declare _secret: string | undefined;
  constructor(options: { secret?: string } = {}) {
    this._secret = options.secret ?? process.env.COOKIE_SECRET ?? undefined;
    this._parser = cookieParser(this._secret); // lgtm[js/missing-csrf-middleware] CSRF is enforced by CsrfMiddleware (csrf-csrf) in the app middleware stack

    this.handle = this.handle.bind(this);
  }

  handle(req: Request, res: Response, next: NextFunction) {
    return this._parser(req, res, next);
  }
}

const defaultCookieParser = new CookieParserMiddleware();
export { CookieParserMiddleware, defaultCookieParser };
