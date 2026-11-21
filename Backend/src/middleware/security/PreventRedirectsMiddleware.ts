

/**
 * @fileoverview Prevent HTTP redirects on API routes.
 * Overrides res.redirect to return JSON — keeps API behaviour
 * predictable for SPA / mobile clients.
 */

import type { NextFunction, Request, Response } from "express";
import { getStatusTitle } from "../../constants/responses";

class PreventRedirectsMiddleware {
  declare _redirectStatusMessages: { 300: string; 301: string; 302: string; 303: string; 304: string; 307: string; 308: string; };
  constructor() {
    this._redirectStatusMessages = {
      300: "Multiple Choices",
      301: "Moved Permanently",
      302: "Found (Temporary Redirect)",
      303: "See Other",
      304: "Not Modified",
      307: "Temporary Redirect",
      308: "Permanent Redirect",
    };

    this.handle = this.handle.bind(this);
  }

  handle(req: Request, res: Response, next: NextFunction) {
    const messages = this._redirectStatusMessages;

    res.redirect = function (statusOrUrl: number | string, url?: string) {
      let status = 302;
      let redirectUrl: unknown = statusOrUrl;

      if (typeof statusOrUrl === "number") {
        status = statusOrUrl;
        redirectUrl = url;
      }

      const isRedirectStatus = status >= 300 && status < 400;

      return res.status(isRedirectStatus ? status : 302).json({
        status: "error",
        code: status,
        title: getStatusTitle(status),
        message: (messages as Record<number, string>)[status] || "Redirect prevented",
        error: {
          type: "RedirectPrevented",
          details: [{ field: "redirectTo", issue: redirectUrl }],
          hint: "API routes do not support redirects. Use the provided URL directly.",
        },
      });
    } as typeof res.redirect;

    next();
  }
}

const defaultPreventRedirects = new PreventRedirectsMiddleware();
export { PreventRedirectsMiddleware, defaultPreventRedirects };
