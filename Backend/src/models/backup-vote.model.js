"use strict";

/**
 * @fileoverview Backup delete vote model.
 *
 * WHAT THIS FILE DOES
 * --------------------
 * Owns all DB access for the `T_SERVER_BACKUP_DELETE_VOTE_DEV` table — the
 * majority-vote system that gates backup archive deletion. A backup can
 * only be deleted when a strict majority (>50%) of active SUPER_ADMINs
 * have voted to delete it.
 *
 * This table is deliberately NOT in `purgeTables.js` — it must survive a
 * data purge.
 *
 * HOW IT WORKS
 * ------------
 * `castVote(archiveId, votedBy, requestedBy)` inserts a vote row. The
 * UIX_SBDV_ARCHIVE_VOTER unique constraint prevents double-voting.
 * `findVotesByArchive(archiveId)` returns all votes for one archive.
 * `findAllPendingVotes()` returns all archives with at least one vote.
 * `cancelRequest(archiveId)` deletes all votes for one archive.
 *
 * EXAMPLE
 * -------
 *   const BackupVoteModel = require("./backup-vote.model");
 *   await BackupVoteModel.castVote("bk_2026...", 10234, 10234);
 *   const votes = await BackupVoteModel.findVotesByArchive("bk_2026...");
 */

const { createDb, OracleCollection } = require("../utils/oracle-mongo-wrapper");
const { isDemoMode } = require("../config/demoMode");
const demo = require("./demo/demoStore");

/** Table name (template `_DEV` convention; DDL in sql/01_schema.sql section 8). */
const TABLE = "T_SERVER_BACKUP_DELETE_VOTE_DEV";

// Explicit "appDb" pool — see data-purge.model.js's identical warning.
const _db = createDb("appDb");
const _votes = new OracleCollection(TABLE, _db);

/**
 * DEMO_MODE: vote rows sorted by VOTED_AT ascending (copy, never the live array).
 * @param {(row: object) => boolean} [pred]
 * @returns {object[]}
 */
function demoVotes(pred = () => true) {
    return demo
        .backupVotes()
        .filter(pred)
        .sort((a, b) => a.VOTED_AT - b.VOTED_AT || a.VOTE_ID - b.VOTE_ID);
}

class BackupVoteModel {
    /**
     * Returns all votes for a specific archive, sorted by vote time.
     *
     * @param {string} archiveId
     * @returns {Promise<Array<{ VOTE_ID: number, ARCHIVE_ID: string, REQUESTED_BY: number, VOTED_BY: number, VOTED_AT: string }>>}
     */
    static async findVotesByArchive(archiveId) {
        if (isDemoMode()) return demoVotes((r) => r.ARCHIVE_ID === archiveId);
        return _votes
            .find({ ARCHIVE_ID: archiveId })
            .sort({ VOTED_AT: 1 })
            .toArray();
    }

    /**
     * Returns all archives that have at least one pending delete vote,
     * grouped by ARCHIVE_ID. Used by the Backup tab listing to show
     * "Pending Delete" badges.
     *
     * @returns {Promise<Array<{ archiveId: string, requestedBy: number, votes: Array<{ votedBy: number, votedAt: string }> }>>}
     */
    static async findAllPendingVotes() {
        const rows = isDemoMode()
            ? demoVotes()
            : await _votes.find({}).sort({ VOTED_AT: 1 }).toArray();

        // Group by ARCHIVE_ID — O(n), n = total vote rows (small).
        const byArchive = new Map();
        for (const row of rows) {
            const id = row.ARCHIVE_ID;
            if (!byArchive.has(id)) {
                byArchive.set(id, {
                    archiveId: id,
                    requestedBy: row.REQUESTED_BY,
                    votes: [],
                });
            }
            byArchive.get(id).votes.push({
                votedBy: row.VOTED_BY,
                votedAt: row.VOTED_AT,
            });
        }
        return [...byArchive.values()];
    }

    /**
     * Casts a vote for deleting an archive. The UIX_SBDV_ARCHIVE_VOTER
     * unique constraint prevents double-voting — an ORA-00001 is caught
     * and returned as `{ inserted: false, reason: "already-voted" }`.
     *
     * @param {string} archiveId
     * @param {number|string} votedBy - Numeric admin id (T_ADMINS_DEV.ID) of the admin casting the vote.
     * @param {number|string} requestedBy - Numeric admin id (T_ADMINS_DEV.ID) of the admin who initiated the delete request.
     * @returns {Promise<{ inserted: boolean, reason?: string }>}
     */
    static async castVote(archiveId, votedBy, requestedBy) {
        if (isDemoMode()) {
            // Emulates UIX_SBDV_ARCHIVE_VOTER (ARCHIVE_ID, VOTED_BY).
            const rows = demo.backupVotes();
            const voter = Number(votedBy);
            if (rows.some((r) => r.ARCHIVE_ID === archiveId && r.VOTED_BY === voter)) {
                return { inserted: false, reason: "already-voted" };
            }
            rows.push({
                VOTE_ID: demo.nextBackupVoteId(),
                ARCHIVE_ID: archiveId,
                REQUESTED_BY: Number(requestedBy),
                VOTED_BY: voter,
                VOTED_AT: new Date(),
            });
            return { inserted: true };
        }
        try {
            await _votes.insertOne(
                {
                    ARCHIVE_ID: archiveId,
                    REQUESTED_BY: Number(requestedBy),
                    VOTED_BY: Number(votedBy),
                },
                // `returning` is MANDATORY here, not an optimisation. Without it
                // the wrapper appends `RETURNING "ID" INTO :out_id` — its default
                // assumption that every table's identity PK is named ID. This
                // table's PK is VOTE_ID, so the insert died with
                // ORA-00904: "ID": invalid identifier and NO vote was ever
                // recorded. Any OracleCollection.insertOne against a table whose
                // identity PK is not literally `ID` needs this option.
                { returning: ["VOTE_ID"] },
            );
            return { inserted: true };
        } catch (err) {
            if (/ORA-00001/.test(err?.message)) {
                return { inserted: false, reason: "already-voted" };
            }
            throw err;
        }
    }

    /**
     * Cancels a delete request by removing ALL votes for an archive.
     *
     * @param {string} archiveId
     * @returns {Promise<{ deletedCount: number }>}
     */
    static async cancelRequest(archiveId) {
        if (isDemoMode()) {
            const rows = demo.backupVotes();
            let deletedCount = 0;
            for (let i = rows.length - 1; i >= 0; i--) {
                if (rows[i].ARCHIVE_ID === archiveId) {
                    rows.splice(i, 1);
                    deletedCount++;
                }
            }
            return { deletedCount };
        }
        const result = await _votes.deleteMany({ ARCHIVE_ID: archiveId });
        return { deletedCount: result.deletedCount ?? 0 };
    }

    /**
     * Counts the number of votes cast for a specific archive.
     *
     * @param {string} archiveId
     * @returns {Promise<number>}
     */
    static async countVotesForArchive(archiveId) {
        if (isDemoMode()) {
            return demo.backupVotes().filter((r) => r.ARCHIVE_ID === archiveId).length;
        }
        return _votes.find({ ARCHIVE_ID: archiveId }).count();
    }
}

module.exports = BackupVoteModel;