// @ts-nocheck -- TS migration: delete this line when the file is typed (bun run typecheck).


/**
 * @fileoverview Gzip compression middleware.
 * Skips responses smaller than 1 KB to avoid overhead.
 */

import compression from "compression";

class CompressionMiddleware {
  constructor(options = {}) {
    this._compression = compression({
      level: options.level ?? 6,
      threshold: options.threshold ?? 1024,
      filter(req, res) {
        if (req.headers["x-no-compression"]) return false;
        return compression.filter(req, res);
      },
    });

    this.handle = this.handle.bind(this);
  }

  handle(req, res, next) {
    return this._compression(req, res, next);
  }
}

const defaultCompression = new CompressionMiddleware();
export { CompressionMiddleware, defaultCompression };
