

/**
 * @fileoverview Row-level tamper detection (ROW_HASH verification).
 *
 * A signed table stores `ROW_HASH = CryptoVault.signRecord(domain, fields)` on
 * every write. This service owns the ONE definition of each domain's signed
 * field set (`buildSignedFields`) — the writer, the Integrity Center verifier
 * and DataRestoreService's post-restore re-signing all call it, so signer and
 * verifier can never drift (a drift reads every row as TAMPERED).
 *
 * The template signs T_SYSTEM_CONFIG only. A project registers each of its
 * signed tables in `_FIELD_BUILDERS` (and in IntegrityModel.TABLE_REGISTRY to
 * appear in the Integrity Center).
 */

import { createDb, OracleCollection } from "../utils/oracle-mongo-wrapper";
import { CryptoVault } from "../utils/encryption/CryptoVault";
import { logger } from "../utils/logger";

/** Pool the scan helpers read from. */
const _db = createDb("appDb");

const _str = (v: unknown) => (v == null ? "" : String(v));

/**
 * T_SYSTEM_CONFIG — the key/value application config store. CONFIG_KEY is the
 * caller-supplied PK, known at sign time, so it is INCLUDED. DESCRIPTION /
 * UPDATED_BY / UPDATED_AT are administrative metadata and excluded.
 *
 * @param {object} row
 * @returns {{ CONFIG_KEY: string, CONFIG_VALUE: string }}
 */
function _fieldsSystemConfig(row: Record<string, unknown>): { CONFIG_KEY: string; CONFIG_VALUE: string; } {
    return {
        CONFIG_KEY: _str(row.CONFIG_KEY),
        CONFIG_VALUE: _str(row.CONFIG_VALUE),
    };
}

/**
 * ROW_HASH domain → signed-field builder. Keys are the exact domain strings
 * passed to CryptoVault.signRecord / verifyRecord. Projects add their signed
 * tables here.
 */
const _FIELD_BUILDERS = Object.freeze({
    T_SYSTEM_CONFIG: _fieldsSystemConfig,
});

class TamperDetectionService {
    /**
     * The exact signed-field object for a ROW_HASH domain. Never reimplement a
     * field list anywhere else.
     *
     * @param {string} domain - a registered ROW_HASH domain
     * @param {object} row - the row (for a restored row: the post-remap projection with the NEW PK)
     * @returns {Record<string, number|string>}
     * @throws {Error} When `domain` is not registered.
     *
     * @example
     * const fields = TamperDetectionService.buildSignedFields("T_SYSTEM_CONFIG", row);
     * const rowHash = await CryptoVault.signRecord("T_SYSTEM_CONFIG", fields);
     */
    static buildSignedFields(domain: string, row: Record<string, unknown>): Record<string, number | string> {
        const builder = _FIELD_BUILDERS[domain as keyof typeof _FIELD_BUILDERS];
        if (!builder) {
            throw new Error(`TamperDetectionService.buildSignedFields: unknown ROW_HASH domain "${domain}".`);
        }
        return builder(row);
    }

    /** @returns {string[]} every registered ROW_HASH domain */
    static listDomains(): string[] {
        return Object.keys(_FIELD_BUILDERS);
    }

    /**
     * Verifies one row's ROW_HASH against its domain.
     *
     * @param {string} domain
     * @param {object} row - must carry ROW_HASH and every signed column
     * @returns {Promise<boolean>} true = intact, false = tampered
     */
    static verifyRow(domain: string, row: object): Promise<boolean> {
        // Any signed row type (SystemConfigRow, a domain row); fields are read by column name.
        const r = row as Record<string, unknown>;
        return CryptoVault.verifyRecord(
            domain,
            TamperDetectionService.buildSignedFields(domain, r),
            r.ROW_HASH as string | null | undefined,
        );
    }

    /**
     * Verifies a T_SYSTEM_CONFIG row — the check SystemConfigService runs
     * before trusting a config value (a failed check falls back to the safe
     * default, never to the stored value).
     *
     * @param {object} row
     * @returns {Promise<boolean>}
     */
    static verifySystemConfigRow(row: object): Promise<boolean> {
        return TamperDetectionService.verifyRow("T_SYSTEM_CONFIG", row);
    }

    /**
     * Full-table scan of a signed table — `{ intact, tampered }`. For audit
     * reporting / incident investigation, not hot paths (the Integrity Center
     * uses IntegrityModel's paged sweep instead).
     *
     * @param {string} tableName - physical table (registered by the caller; never request input)
     * @param {string} domain - its ROW_HASH domain
     * @param {Record<string, 1>} projection - must include ROW_HASH and every signed column
     * @returns {Promise<{ intact: object[], tampered: object[] }>}
     */
    static async scanTable(tableName: string, domain: string, projection: Record<string, 1>): Promise<{ intact: Record<string, unknown>[]; tampered: Record<string, unknown>[]; }> {
        const col = new OracleCollection(tableName, _db);
        const rows = await col
            .find({ ROW_HASH: { $exists: true } })
            .project(projection)
            .toArray();
        const results = await Promise.all(rows.map((r) => TamperDetectionService.verifyRow(domain, r)));
        const intact = rows.filter((_, i) => results[i]);
        const tampered = rows.filter((_, i) => !results[i]);
        if (tampered.length > 0) {
            logger.security("TAMPER_DETECTED", {
                table: tableName,
                count: tampered.length,
            });
        }
        return { intact, tampered };
    }
}

export default TamperDetectionService;
