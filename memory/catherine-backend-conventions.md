---
name: catherine-backend-conventions
description: Non-obvious backend rules for the CATHERINE template (class OOP, constants buckets, logger, middleware order, Oracle)
metadata:
  type: reference
---

CATHERINE backend hard rules (full detail in `Backend/CLAUDE.md`):

- **Class-based OOP.** Stateful/resource/lifecycle modules = classes; pure in→out = functions. Every middleware exports an instantiated class; `.handle()` bound in `app.js`. Controllers = thin classes, `catchAsync`-wrapped, zero DB/logic. Services own logic, `throw new AppError(...)`, never `res.json()`.
- **Three constants buckets, routed by use site:** `throw` strings → `constants/errors/`; `res.json(sendSuccess())` strings → `constants/responses/`; `logger.*` strings → `constants/messages/<namespace>.messages.js`. No inline strings.
- **Logger:** RFC 5424 8-level (`emerg`…`debug`). `console.*` banned. **`logger.warn` renamed to `logger.warning` in v5** — `warn` is a deprecated alias (removed in v6). Logs never truncate by default (`LOG_MAX_SAFESTR_LENGTH=Infinity`). Files `logs/YYYY/MM/DD/level.log`.
- **Middleware chain order is immutable** (app.js): helmet → securityFilter (BEFORE body parse) → requestId → json/urlencoded → requestLogger → responseTime → compression → cors → cookieParser → captureResponseBody → ipFilter → rateLimiter → preventRedirects (`/api` only). Skill counts this as a 14-step chain.
- **Auth is data-driven:** `AuthMiddleware.authenticate` then `requireAccess(predicate)` where predicate is `(user) => boolean`. NO hardcoded AREAS/ROLES in template.
- **Oracle = `oracle-mongo-wrapper`** (`src/utils/oracle-mongo-wrapper/`) — MongoDB-style API over Oracle SQL. Bind variables always via `parseFilter`/`parseUpdate` (per-call counters). Only documented raw-interpolation exception: `PIVOT IN (...)` uses `.replace(/'/g,"''")`. Never `oracledb` outside `src/config/adapters/oracle.js`. Dual-pool + `PoolHealthMonitor` (30s, 3-strike), exp backoff `min(1000*2^n,10000)ms`. Adding a pool = new `.env` entry + key in `database.js` only.
- **Cache** (`src/middleware/cache/`): `CacheKeyBuilder.build()` (params sorted alphabetically, hashes >200 chars), registry-registered stores, `read()` caches only 2xx JSON, invalidation runs in `setImmediate`.
- **PKG quirks:** `encodingPolyfill.js` must be first require in `server.js`; `nanoidLoader.js` for nanoid ESM; Oracle Thick mode in `oracle.js`.
- **Response shape:** `{ status, code, message, data }` (success) / `{ status, code, message, error:{type,details,hint,stack?} }` (error). All routes `/api/v1/`. `X-Request-Id` on every response.

See [[catherine-template-overview]], [[catherine-frontend-conventions]].
