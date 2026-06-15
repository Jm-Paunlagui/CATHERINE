// Apply encoding polyfills first (mirrors server.js startup order)
require("../src/utils/encodingPolyfill");

"use strict";

/**
 * Throwaway diagnostic: decrypts data/changelog.enc and dumps the raw entries
 * (oldest → newest) to scripts/changelog-dump.json so we can resync the seed.
 *
 * Loads .env by ABSOLUTE path so it works from any cwd.
 * Safe to delete after use.
 */

const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const ChangelogModel = require("../src/models/changelog.model");

// listAll() returns newest-first; reverse to oldest-first to match SEED_ENTRIES order.
const entries = ChangelogModel.listAll().slice().reverse();

const outPath = path.resolve(__dirname, "changelog-dump.json");
fs.writeFileSync(outPath, JSON.stringify(entries, null, 2), "utf8");

process.stdout.write(
    `\nDecrypted ${entries.length} entries → ${outPath}\n` +
        `Range: ${entries[0]?.version} (${entries[0]?.displayDate}) → ` +
        `${entries[entries.length - 1]?.version} (${entries[entries.length - 1]?.displayDate})\n\n`,
);