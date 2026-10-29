/**
 * Runtime.view.jsx — Support → Runtime: how the server runs — boot, cluster
 * roles, schedulers and the seed chain, backups, watchdogs, rate limits,
 * alerting, crash handling and graceful shutdown. Each flow is tagged with the
 * server-simulation stage (`npm run sim:server`) that exercises it.
 *
 * SUPER_ADMIN only; the control is `requireSuperAdmin` on
 * GET /api/v1/architecture/runtime. The page body is the shared SystemMapView.
 */

import { SystemMapView } from "../../../components/shared/systemMap";
import { useRuntime } from "./runtime.hook";

export default function RuntimeView() {
    const hook = useRuntime();
    return <SystemMapView hook={hook} title="Runtime" subtitle="How the server schedules, backs up, protects itself and shuts down — mirrored by the server simulation. Super Admins only." noun="runtime map" />;
}
