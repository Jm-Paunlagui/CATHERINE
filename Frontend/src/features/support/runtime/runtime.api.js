/**
 * runtime.api.js — HTTP calls for Support → Runtime.
 *
 * Served by the API behind the same SUPER_ADMIN-only router as the
 * Architecture map, and never copied into this bundle: a static asset has no
 * auth check. The server sends `Cache-Control: private, no-store`.
 */

import httpClient from "../../../middleware/HttpClient";

export const runtimeApi = {
    /**
     * The server-runtime map: meta, layers, edgeKinds, nodes, edges, flows
     * (each tagged with its server-simulation stage in `ref`), layout.
     *
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    getMap: () => httpClient.get("architecture/runtime"),
};

export default runtimeApi;
