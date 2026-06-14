"use strict";

const { createDb, OracleCollection } = require('../utils/oracle-mongo-wrapper');

const _db        = createDb('Meal');
const _auditLogs = new OracleCollection('T_AUDIT_LOGS', _db);

class AuditLogModel {
  static async insert(record) {
    return _auditLogs.insertOne(record);
  }

  /**
   * Bulk-inserts buffered audit records in one Oracle executeMany round-trip.
   * All records must share the same column set (guaranteed by
   * AuditLogMiddleware._buildRecord, the single producer).
   *
   * @param {object[]} records
   * @returns {Promise<object>} insertMany result
   */
  static async insertBatch(records) {
    return _auditLogs.insertMany(records);
  }

  static async findPaginated(filter, page, pageSize) {
    return _auditLogs
      .find(filter)
      .sort({ CREATED_AT: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .toArray();
  }

  static async countTotal(filter) {
    return _auditLogs.find(filter).count();
    // .count() is the terminal method on QueryBuilder — NOT countDocuments()
  }

  /**
   * Permanently delete all audit log records matching the supplied filter.
   *
   * @param {object} filter - oracle-mongo-wrapper filter object.
   * @returns {Promise<object>} Raw oracle-mongo-wrapper deleteMany result.
   */
  static async deleteMany(filter) {
    return _auditLogs.deleteMany(filter);
  }

  /**
   * Returns the epoch-millisecond timestamp of the most recent audit log record.
   * Used by the SSE poller to detect new records without a full COUNT(*).
   * O(log n) via descending index scan on CREATED_AT.
   *
   * No user input flows into this query — the filter is a constant empty object,
   * so there are no bind variables and no injection surface.
   *
   * @returns {Promise<number>} Epoch ms of latest CREATED_AT, or 0 if table is empty.
   */
  static async getLatestCreatedAt() {
    const rows = await _auditLogs
      .find({})
      .sort({ CREATED_AT: -1 })
      .limit(1)
      .toArray();
    return rows.length > 0 ? new Date(rows[0].CREATED_AT).getTime() : 0;
  }

  static async aggregate(matchFilter) {
    // Total + per-category counts are derived from ONE GROUP BY STATUS_CATEGORY
    // pass so they always reconcile (total === sum of all category buckets).
    // The previous implementation used a separate total-aggregate plus four
    // independent STATUS_CATEGORY .find().count() queries; because the date
    // $match was evaluated independently per query, the buckets could fail to
    // sum to the total (e.g. Success + Redirect > Total). A single grouped pass
    // removes that drift and is 2 queries instead of 6.
    //
    // $addToSet is not supported by oracle-mongo-wrapper — distinct user count
    // is obtained via a separate GROUP BY USER_ID query run in parallel.
    //
    // FIX (perf/error-rate): strip $or from the uniqueUserRows match filter.
    // When AuditLogService.getList provides a search term, matchFilter contains
    // a $or clause with { USERNAME: { $regex } } and { CLIENT_IP: { $regex } }
    // (and optionally { USER_ID: numericId }). Spreading this $or into the
    // uniqueUserRows aggregate's WHERE clause causes oracle-mongo-wrapper to
    // generate malformed SQL when Oracle attempts to apply a LIKE/REGEX
    // predicate on the NUMBER column USER_ID in a GROUP BY context.
    //
    // The unique-user count is a date-range metric: "how many distinct users
    // made requests in this period?" — not "how many distinct users matched
    // the search term?". Text-search filtering on this aggregate is both
    // semantically incorrect and the source of the 2.6% error rate on GET /.
    //
    // Strip $or (text-search predicates) and preserve only the date-range
    // CREATED_AT filter for the uniqueUserRows aggregate. USER_ID: { $gt: 0 }
    // excludes anonymous/unauthenticated requests from the unique-user count.
    const { $or: _ignored, ...dateOnlyFilter } = matchFilter;
    const uniqueUserFilter = { ...dateOnlyFilter, USER_ID: { $gt: 0 } };

    const [byCategory, uniqueUserRows] = await Promise.all([
      _auditLogs.aggregate([
        { $match: matchFilter },
        {
          // _id: '$STATUS_CATEGORY' → group key returns as column STATUS_CATEGORY
          // (not _id); accumulator aliases return uppercased (CNT, RESPTIME).
          $group: {
            _id:      '$STATUS_CATEGORY',
            CNT:      { $sum: 1 },
            RESPTIME: { $sum: '$RESPONSE_TIME_MS' },
          },
        },
      ]),
      _auditLogs.aggregate([
        { $match: uniqueUserFilter },
        { $group: { _id: '$USER_ID', N: { $sum: 1 } } },
      ]),
    ]);

    const stats = AuditLogModel._reduceCategoryGroups(byCategory);

    return {
      total:           stats.total,
      success:         stats.buckets['2xx'],
      redirect:        stats.buckets['3xx'],
      clientError:     stats.buckets['4xx'],
      serverError:     stats.buckets['5xx'],
      uniqueUsers:     (uniqueUserRows ?? []).length,
      avgResponseTime: stats.total > 0
                         ? Math.round(stats.totalRespTime / stats.total)
                         : 0,
    };
  }

  /**
   * Reduce the rows of a `GROUP BY STATUS_CATEGORY` aggregate into a total,
   * total response time, and per-category counts. Pure function — no DB access,
   * so the reconciliation guarantee (total === Σ buckets + uncategorised) is
   * unit-testable in isolation.
   *
   * Rows whose STATUS_CATEGORY is null/blank or outside 2xx–5xx still count
   * toward `total` but match no bucket, so an inflated total (total > Σ known
   * buckets) is a visible signal of uncategorised audit rows rather than a
   * silently dropped request.
   *
   * @param {Array<{ STATUS_CATEGORY?: string, CNT?: number, RESPTIME?: number }>} rows
   * @returns {{ total: number, totalRespTime: number, buckets: { '2xx': number, '3xx': number, '4xx': number, '5xx': number } }}
   */
  static _reduceCategoryGroups(rows) {
    const buckets = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
    let total = 0;
    let totalRespTime = 0;

    for (const r of rows ?? []) {
      const count = Number(r.CNT) || 0;
      total += count;
      totalRespTime += Number(r.RESPTIME) || 0;

      // Trim guards against CHAR-padded columns ('4xx   ' !== '4xx').
      const cat = (r.STATUS_CATEGORY ?? '').trim();
      if (Object.prototype.hasOwnProperty.call(buckets, cat)) {
        buckets[cat] += count;
      }
    }

    return { total, totalRespTime, buckets };
  }
}

module.exports = AuditLogModel;
