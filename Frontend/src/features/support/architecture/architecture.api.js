/**
 * architecture.api.js — HTTP calls for Support → Architecture.
 *
 * The map is served by the API behind a SUPER_ADMIN-only route and is NEVER
 * copied into this bundle or `public/`: a static asset has no auth check, so a
 * bundled copy would hand every visitor the map the route exists to protect.
 * The server sends `Cache-Control: private, no-store`; the only cache is the
 * in-memory `useRequest` entry for the session.
 */

import httpClient from "../../../middleware/HttpClient";

export const architectureApi = {
    /**
     * The whole map: meta, layers, edgeKinds, nodes, edges, flows, layout.
     *
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    getMap: () => httpClient.get("architecture"),
};

export default architectureApi;
