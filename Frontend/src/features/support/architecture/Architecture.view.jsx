/**
 * Architecture.view.jsx — Support → Architecture: an interactive map of the
 * whole system plus step-through request flows.
 *
 * SUPER_ADMIN only. The route guard in App.jsx and the nav entry existing only
 * in the SUPER_ADMIN block are conveniences that keep other roles off a page
 * of 403s. The control is `requireSuperAdmin` on GET /api/v1/architecture.
 *
 * The page body is the shared SystemMapView (components/shared/systemMap).
 */

import { SystemMapView } from "../../../components/shared/systemMap";
import { useArchitecture } from "./architecture.hook";

export default function ArchitectureView() {
    const hook = useArchitecture();
    return <SystemMapView hook={hook} title="Architecture" subtitle="Interactive system map and request flows. Super Admins only." noun="architecture map" />;
}
