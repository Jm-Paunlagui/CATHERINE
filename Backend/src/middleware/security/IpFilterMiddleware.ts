

/**
 * @fileoverview CIDR-aware IP allowlist middleware.
 * Restricts access to trusted IP addresses or CIDR ranges.
 */

import type { NextFunction, Request, Response } from "express";
import { logger } from "../../utils/logger";
import { getStatusTitle } from "../../constants/responses";

class IpFilterMiddleware {
  declare _allowedIps: any;
  declare _enabled: any;
  constructor(options: Record<string, any> = {}) {
    this._enabled = options.enabled ?? process.env.ENABLE_IP_FILTER === "true";
    this._allowedIps =
      options.allowedIps ??
      (process.env.ALLOWED_IPS
        ? process.env.ALLOWED_IPS.split(",").map((s) => s.trim())
        : []);

    this.handle = this.handle.bind(this);
  }

  handle(req: Request, res: Response, next: NextFunction) {
    if (!this._enabled || this._allowedIps.length === 0) return next();

    const clientIp = IpFilterMiddleware.extractClientIp(req);
    const allowed = this._allowedIps.some((entry: any) =>
      entry.includes("/")
        ? IpFilterMiddleware.ipInCidr(clientIp, entry)
        : clientIp === entry,
    );

    if (!allowed) {
      logger.warning("IP blocked by filter", {
        ip: clientIp,
        path: req.path,
        operation: "IP_FILTER_BLOCKED",
      });
      return res.status(403).json({
        status: "error",
        code: 403,
        title: getStatusTitle(403),
        message: "Access denied",
        error: { type: "ForbiddenError" },
      });
    }

    next();
  }

  static ipInCidr(ip: unknown, cidr: any) {
    const [range, bits] = cidr.split("/");
    const mask = bits ? ~((1 << (32 - parseInt(bits, 10))) - 1) : 0xffffffff;
    const ipNum = IpFilterMiddleware.ipToNum(ip);
    const rangeNum = IpFilterMiddleware.ipToNum(range);
    return (ipNum & mask) === (rangeNum & mask);
  }

  static ipToNum(ip: any) {
    return (
      ip
        .split(".")
        .reduce((acc: any, octet: any) => (acc << 8) + parseInt(octet, 10), 0) >>> 0
    );
  }

  static extractClientIp(req: any) {
    let ip = req.ip || req.socket?.remoteAddress || "unknown";
    if (ip.startsWith("::ffff:")) ip = ip.slice(7);
    return ip;
  }
}

const defaultIpFilter = new IpFilterMiddleware();
export { IpFilterMiddleware, defaultIpFilter };
