import crypto from "crypto";
import JSZip from "jszip";

import { CryptoVault } from "../../../src/utils/encryption/CryptoVault";

/** Project-style registry used by the restore wave-2 tests (the template registry has no FKs / signed tables). */
export function makeRegistryMock(real: typeof import("../../../src/constants/purgeTables"), extra: Array<Record<string, unknown>> = []) {
    const base = {
        pool: real.PURGE_POOL,
        pk: "ID",
        isIdentity: true,
        virtualColumns: [] as string[],
        fkEdges: [] as { column: string; refTable: string; refColumn: string }[],
        deleteOrderTier: 1,
        restoreOrderTier: 1,
        rowHashDomain: null as string | null,
        canonicalTimestampColumns: [] as string[],
        identifierColumns: ["ID"],
    };
    const T = real.PURGE_GROUP_KEYS.T;
    const S = real.PURGE_GROUP_KEYS.SERVER;
    const PURGE_TABLES = [
        { ...base, table: "W2_PARENT", group: T, restoreOrderTier: 1 },
        {
            ...base, table: "W2_CHILD", group: T, restoreOrderTier: 2, rowHashDomain: "W2_CHILD",
            fkEdges: [{ column: "PARENT_ID", refTable: "W2_PARENT", refColumn: "ID" }],
            canonicalTimestampColumns: ["CREATED_TS"],
        },
        { ...base, table: "W2_NATURAL", group: S, pk: "KEY", isIdentity: false, restoreOrderTier: 2, rowHashDomain: "W2_NATURAL", virtualColumns: ["V"] },
        { ...base, table: "W2_EMPTY", group: S, restoreOrderTier: 3 },
        ...extra.map((e) => ({ ...base, ...e })),
    ] as Array<typeof base & { table: string; group: string }>;
    const byName = new Map(PURGE_TABLES.map((e) => [e.table, e]));
    const getEntry = (t: string) => byName.get(t) ?? null;
    const order = (key: "deleteOrderTier" | "restoreOrderTier") => (names?: string[]) => {
        const set = names ? new Set(names) : null;
        return PURGE_TABLES.filter((e) => !set || set.has(e.table)).sort((a, b) => a[key] - b[key]);
    };
    return {
        ...real,
        NEVER_PURGE: ["W2_PROTECTED"],
        PURGE_TABLES,
        getEntry,
        requireEntry: (t: string) => {
            const e = getEntry(t);
            if (!e) throw new Error(`not registered: ${t}`);
            return e;
        },
        getTablesByGroup: (g: string) => PURGE_TABLES.filter((e) => e.group === g),
        getAllTableNames: () => PURGE_TABLES.map((e) => e.table),
        getDeleteOrder: order("deleteOrderTier"),
        getRestoreOrder: order("restoreOrderTier"),
    };
}

const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

export interface ArchiveOpts {
    manifest?: Record<string, unknown>;
    /** table -> rows */
    data?: Record<string, Record<string, unknown>[]>;
    /** extra raw files to add AFTER signing (not in the signed set) or before (see `signExtra`). */
    extraFiles?: Record<string, string>;
    /** raw text for data files (overrides rows) */
    rawData?: Record<string, string>;
    signatureOverride?: (sig: { files: Record<string, string>; digest: string }) => unknown;
    omit?: Array<"manifest.json" | "signature.json">;
    rawManifest?: string;
    rawSignature?: string;
}

/** Builds a real, HMAC-signed archive zip (the layout DataRestoreService._verifyAndParseArchive expects). */
export async function buildSignedZip(schemaVersion: string, opts: ArchiveOpts = {}): Promise<Buffer> {
    const data = opts.data ?? {};
    const manifest = {
        archiveId: "a1",
        schemaVersion,
        mode: "FULL",
        kind: "FULL_SCOPE",
        scope: { tables: Object.keys(data) },
        scopeHash: "hash1",
        createdBy: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        requestId: "req1",
        appVersion: "1.0.0",
        ...opts.manifest,
    };
    const manifestBuf = Buffer.from(opts.rawManifest ?? JSON.stringify(manifest), "utf8");
    const files: Record<string, Buffer> = {};
    for (const [t, rows] of Object.entries(data)) {
        files[`data/${t}.jsonl`] = Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), "utf8");
    }
    for (const [name, text] of Object.entries(opts.rawData ?? {})) files[name] = Buffer.from(text, "utf8");
    const hashes: Record<string, string> = { "manifest.json": sha(manifestBuf) };
    for (const [n, b] of Object.entries(files)) hashes[n] = sha(b);
    const sig = { files: hashes, digest: await CryptoVault.signRecord("APP_BACKUP_ARCHIVE", hashes) };
    const sigOut = opts.signatureOverride ? opts.signatureOverride(sig) : sig;
    const zip = new JSZip();
    if (!opts.omit?.includes("manifest.json")) zip.file("manifest.json", manifestBuf);
    if (!opts.omit?.includes("signature.json")) zip.file("signature.json", opts.rawSignature ?? JSON.stringify(sigOut));
    for (const [n, b] of Object.entries(files)) zip.file(n, b);
    for (const [n, t] of Object.entries(opts.extraFiles ?? {})) zip.file(n, t);
    return zip.generateAsync({ type: "nodebuffer" });
}
