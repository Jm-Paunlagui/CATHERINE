import { promises as fsp } from "fs";
import crypto from "crypto";
import path from "path";
import JSZip from "jszip";

import { CryptoVault } from "../../../src/utils/encryption/CryptoVault";

export type FixtureTable = { state: "INCLUDED"; rows: Record<string, unknown>[] } | { state: "UNCHANGED"; rows: number; sourceArchiveId: string; sha256: string };

export interface FixtureSpec {
    archiveId: string;
    filename?: string;
    createdAt?: string;
    trigger?: string;
    mode?: string;
    chain?: { baseArchiveId: string | null; generation: number } | null;
    tables: Record<string, FixtureTable>;
    /** Tamper switches */
    tamper?: "none" | "data" | "no-signature" | "extra-file" | "bad-digest" | "no-manifest" | "bad-json" | "signature-garbage";
}

const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
export const jsonl = (rows: Record<string, unknown>[]) => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");

/** Writes a real, HMAC-signed backup zip into `dir` (the same layout _verifyZipBuffer expects). */
export async function writeArchive(dir: string, spec: FixtureSpec): Promise<{ path: string; filename: string; zip: Buffer }> {
    const zip = new JSZip();
    const data: Record<string, Buffer> = {};
    const tables: Record<string, unknown> = {};
    for (const [name, t] of Object.entries(spec.tables)) {
        if (t.state === "INCLUDED") {
            const buf = Buffer.from(jsonl(t.rows), "utf8");
            data[`data/${name}.jsonl`] = buf;
            tables[name] = { state: "INCLUDED", rows: t.rows.length, sha256: sha(buf) };
        } else {
            tables[name] = { state: "UNCHANGED", rows: t.rows, sha256: t.sha256, sourceArchiveId: t.sourceArchiveId };
        }
    }
    const manifest = {
        archiveId: spec.archiveId,
        createdAt: spec.createdAt ?? "2026-01-01T00:00:00.000Z",
        trigger: spec.trigger ?? "SCHEDULED",
        event: "NIGHTLY",
        eventId: 1,
        mode: spec.mode ?? "FULL",
        chain: spec.chain === undefined ? { baseArchiveId: spec.archiveId, generation: 0 } : spec.chain,
        tables,
        schemaVersion: 3,
        scopeHash: "h",
        readConsistent: true,
        createdBy: 1,
        requestId: "r",
        appVersion: "1.0.0",
    };
    const manifestBuf = Buffer.from(JSON.stringify(manifest), "utf8");
    const hashes: Record<string, string> = { "manifest.json": sha(manifestBuf) };
    for (const [n, b] of Object.entries(data)) hashes[n] = sha(b);
    const digest = spec.tamper === "bad-digest" ? "0".repeat(64) : await CryptoVault.signRecord("APP_BACKUP_ARCHIVE", hashes);
    const signedFiles = spec.tamper === "extra-file" ? { ...hashes, "data/ghost.jsonl": sha("g") } : hashes;
    if (spec.tamper !== "no-manifest") zip.file("manifest.json", spec.tamper === "bad-json" ? "{not json" : manifestBuf);
    if (spec.tamper !== "no-signature") {
        zip.file("signature.json", spec.tamper === "signature-garbage" ? "null" : JSON.stringify({ files: signedFiles, digest }));
    }
    for (const [n, b] of Object.entries(data)) zip.file(n, spec.tamper === "data" ? Buffer.from("tampered\n") : b);
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    const filename = spec.filename ?? `${spec.archiveId}.zip`;
    const p = path.join(dir, filename);
    await fsp.writeFile(p, buf);
    return { path: p, filename, zip: buf };
}
