

/**
 * @fileoverview Gzip compression middleware.
 * Skips responses smaller than 1 KB to avoid overhead.
 */

import type { NextFunction, Request, Response } from "express";
import compression from "compression";

class CompressionMiddleware {
  declare _compression: import("express").RequestHandler<import("express-serve-static-core").ParamsDictionary, unknown, unknown, import("qs").ParsedQs, Record<string, unknown>>;
  constructor(options: { level?: number; threshold?: number } = {}) {
    this._compression = compression({
      level: options.level ?? 6,
      threshold: options.threshold ?? 1024,
      filter(req: Request, res: Response) {
        if (req.headers["x-no-compression"]) return false;
        return compression.filter(req, res);
      },
    });

    this.handle = this.handle.bind(this);
  }

  handle(req: Request, res: Response, next: NextFunction) {
    return this._compression(req, res, next);
  }
}

const defaultCompression = new CompressionMiddleware();
export { CompressionMiddleware, defaultCompression };
