/**
 * devdocs.api.js — HTTP calls for the developer documentation viewer.
 *
 * Every call goes through `httpClient`, which carries the session. That is not
 * incidental: the corpus is ADMIN / SUPER_ADMIN only and the server is the
 * thing enforcing it. There is no static copy of these documents anywhere in
 * this bundle, and adding one would defeat the gate — a file in `public/` is
 * served with no auth check at all.
 *
 * The server sends `Cache-Control: private, no-store` on all three responses,
 * so nothing here should add its own caching beyond the in-memory `useRequest`
 * entry that lives for the session.
 */

import httpClient from "../../../middleware/HttpClient";

export const devDocsApi = {
    /**
     * Fetch the section index. Metadata only — no document bodies, so this
     * stays small regardless of how large the corpus grows.
     *
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    getTree: () => httpClient.get("dev-docs/tree"),

    /**
     * Fetch one document's raw markdown.
     *
     * The id is `section/name` and is split across two path segments because
     * that is the shape the route takes. It is a server-side manifest key, not
     * a path — an unknown id is a 404 before the server touches its filesystem.
     *
     * @param {string} id - e.g. "System Admin/data-purge-documentation"
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    getDoc: (id) => {
        const [section, name] = String(id ?? "").split("/");
        return httpClient.get(`dev-docs/doc/${encodeURIComponent(section)}/${encodeURIComponent(name)}`);
    },

    /**
     * Literal substring search across the corpus. Server-side by design: the
     * alternative is shipping 1.3 MB of admin-only text to the browser to grep
     * it there, which would put the whole corpus in every admin's memory and
     * cache regardless of what they opened.
     *
     * @param {string} q - at least 2 characters, or the server returns 400
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    search: (q) => httpClient.get("dev-docs/search", { params: { q } }),
};

export default devDocsApi;
