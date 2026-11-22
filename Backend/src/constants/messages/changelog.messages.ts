

/**
 * @fileoverview Logger message templates for the Changelog module.
 * Used ONLY in logger.* calls — never thrown or sent to clients.
 */

const changelogMessages = {
    /** @param {number} count */
    STORE_READ: (count: number) => `Changelog store read: ${count} entr${count === 1 ? "y" : "ies"}.`,
    /** @param {number} count */
    STORE_WRITTEN: (count: number) => `Changelog store written: ${count} entr${count === 1 ? "y" : "ies"}.`,
    /** @param {string} id */
    ENTRY_CREATED: (id: string) => `Changelog entry created: ${id}`,
    /** @param {string} id */
    ENTRY_UPDATED: (id: string) => `Changelog entry updated: ${id}`,
    /** @param {string} id */
    ENTRY_DELETED: (id: string) => `Changelog entry deleted: ${id}`,
    /** @param {string} msg */
    STORE_DECRYPT_FAILED: (msg: string) => `Changelog store decryption failed: ${msg}`,
    /** @param {string} msg */
    STORE_ENCRYPT_FAILED: (msg: string) => `Changelog store encryption failed: ${msg}`,
    STORE_INITIALIZED: () => "Changelog data store initialised with seed data.",
};

export { changelogMessages };
