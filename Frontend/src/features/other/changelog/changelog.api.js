/**
 * changelog.api.js
 *
 * HTTP calls for the Version History / Changelog feature.
 * All requests are routed through HttpClient (CSRF auto-injected).
 */

import httpClient from "../../../middleware/HttpClient";

export const changelogApi = {
    /** @returns {Promise<import("axios").AxiosResponse>} */
    list: () => httpClient.get("changelog"),

    /**
     * @param {{ displayDate: string, version: string, title: string, message: string,
     *           whatChanged: Array<{ text: string, items?: string[] }>,
     *           type: string, authors: string[], coAuthors: string[] }} data
     * @returns {Promise<import("axios").AxiosResponse>}
     */
    create: (data) => httpClient.post("changelog", data),

    /**
     * @param {string} id
     * @param {object} data
     * @returns {Promise<import("axios").AxiosResponse>}
     */
    update: (id, data) => httpClient.put(`changelog/${id}`, data),

    /**
     * @param {string} id
     * @returns {Promise<import("axios").AxiosResponse>}
     */
    delete: (id) => httpClient.delete(`changelog/${id}`),

    /**
     * Release-train state (SUPER_ADMIN only). Read-only — returns the in-flight
     * target, allowed actions, and the `drafts` the create form is seeded with.
     * Transitions are written through `create` (single write path).
     * @returns {Promise<import("axios").AxiosResponse>}
     */
    release: {
        current: () => httpClient.get("changelog/release/current"),
    },
};
