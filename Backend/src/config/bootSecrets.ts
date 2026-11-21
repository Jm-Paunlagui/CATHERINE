/**
 * Boot guard (side-effect module) — the SECOND import in server.ts, right after
 * ./bootEnv: fail fast on placeholder secrets / unsafe config before any
 * app/db module is evaluated. Also runs validateMoneyConfig.
 */
import { validateSecrets } from "./bootGuard";

validateSecrets();
