
/**
 * Throwaway diagnostic: decrypts data/changelog.enc and dumps the raw entries
 * (oldest → newest) to scripts/changelog-dump.json so we can resync the seed.
 *
 * Loads .env by ABSOLUTE path so it works from any cwd.
 * Safe to delete after use.
 */

import "../src/config/bootEnv"; // first: loads .env before any src module (TypeScript rule 7)
import path from "path";
import fs from "fs";


import ChangelogModel from "../src/models/changelog.model";

// listAll() returns newest-first; reverse to oldest-first to match SEED_ENTRIES order.
const entries = ChangelogModel.listAll().slice().reverse();

const outPath = path.resolve(import.meta.dir, "changelog-dump.json");
fs.writeFileSync(outPath, JSON.stringify(entries, null, 2), "utf8");

process.stdout.write(
    `\nDecrypted ${entries.length} entries → ${outPath}\n` +
        `Range: ${entries[0]?.version} (${entries[0]?.displayDate}) → ` +
        `${entries[entries.length - 1]?.version} (${entries[entries.length - 1]?.displayDate})\n\n`,
);