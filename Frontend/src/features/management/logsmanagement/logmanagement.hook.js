import { useCallback, useEffect, useRef, useState } from "react";
import { extractApiError, toast } from "../../../components/ui/toast.utils";
import { useRequest } from "../../../hooks/useRequest";
import { auditLogApi, systemLogApi } from "./logsmanagement.api";

/**
 * Format a Date object as a local YYYY-MM-DD string without UTC conversion.
 * Using toISOString() would apply a UTC offset that shifts the date back by one
 * day for users in UTC+ timezones.
 *
 * @param {Date} d
 * @returns {string}
 */
const _localDateStr = (d) => {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
};

const _thirtyDaysAgo = () => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return _localDateStr(d);
};

const _today = () => _localDateStr(new Date());

/** Max number of live traffic buckets retained in the rolling stacked-bar chart. */
const MAX_TRAFFIC_POINTS = 30;

// ─── System Logs sub-tab — level filter options + parsing ─────────────────────

/**
 * Single-Select options for the System sub-tab's Level filter. Values are
 * either a bare RFC 5424 maxPriority ceiling ("0".."7", "X and above") or an
 * exact single level prefixed "lvl:" (overrides the ceiling server-side).
 * Default is "5" — NOTICE and above (user decision, 2026-07-20).
 */
export const SYSTEM_LOG_LEVEL_OPTIONS = [
    { value: "5", label: "Notice & above" },
    { value: "3", label: "Error & above" },
    { value: "7", label: "All levels" },
    { value: "lvl:emergency", label: "Emergency" },
    { value: "lvl:alert", label: "Alert" },
    { value: "lvl:critical", label: "Critical" },
    { value: "lvl:error", label: "Error" },
    { value: "lvl:warning", label: "Warning" },
    { value: "lvl:notice", label: "Notice" },
    { value: "lvl:info", label: "Info" },
    { value: "lvl:debug", label: "Debug" },
];

/** RFC 5424 numeric priority per level name — mirrors AuditLogService's SYSTEM_LOG_PRIORITY. */
const SYSTEM_LOG_PRIORITY = { emergency: 0, alert: 1, critical: 2, error: 3, warning: 4, notice: 5, info: 6, debug: 7 };

/**
 * Parses one `SYSTEM_LOG_LEVEL_OPTIONS` value into `{ level, maxPriority }`
 * request params — exactly one of the two is defined.
 *
 * @param {string} raw
 * @returns {{ level: string|undefined, maxPriority: number|undefined }}
 */
function _parseSystemLevelFilter(raw) {
    if (typeof raw === "string" && raw.startsWith("lvl:")) {
        return { level: raw.slice(4), maxPriority: undefined };
    }
    const n = Number(raw);
    return { level: undefined, maxPriority: Number.isFinite(n) ? n : 5 };
}

/** Max live-tail rows retained client-side (oldest dropped once exceeded). */
const MAX_LIVE_SYSTEM_ROWS = 500;

/**
 * Format an ISO timestamp as a short HH:MM:SS axis label for the traffic chart.
 * Falls back to the current local time if the timestamp is missing/invalid.
 *
 * @param {string} [iso]
 * @returns {string}
 */
const _timeLabel = (iso) => {
    const d = iso ? new Date(iso) : new Date();
    const valid = !Number.isNaN(d.getTime()) ? d : new Date();
    return valid.toLocaleTimeString([], { hour12: false });
};

/**
 * Hook for the Logging & Observability feature.
 * Manages stats date range, table filters, pagination, and data fetching.
 *
 * @returns {object} All state and callbacks needed by LogsManagementView.
 */
const useLogsManagement = () => {
    const [statsDateRange, setStatsDateRange] = useState({
        fromDate: _thirtyDaysAgo(),
        toDate: _today(),
    });
    const [apiError, setApiError] = useState(null);

    const [filters, setFilters] = useState({
        fromDate: "",
        toDate: "",
        method: "",
        statusCategory: "",
        search: "",
    });

    const [page, setPage] = useState(1);
    const pageSize = 20;

    // ── Investigation modal state ──
    const [selectedRow, setSelectedRow] = useState(null);
    const [logsModalOpen, setLogsModalOpen] = useState(false);
    const [requestLogsData, setRequestLogsData] = useState(null);
    const [requestLogsLoading, setRequestLogsLoading] = useState(false);

    // ── Audit Logs top-level tab — nested sub-tab state (User Traffic | System) ──
    // Controlled so the System sub-tab's browse fetch (real file I/O — tail-window
    // reads across up to 8 level files) can be gated behind actual visibility
    // instead of firing on every mount of the page regardless of which sub-tab
    // is showing.
    const [activeAuditSubTab, setActiveAuditSubTab] = useState("user-traffic");

    // ── System Logs sub-tab — browse state ──
    const [sysDate, setSysDate] = useState(_today());
    const [sysLevelFilter, setSysLevelFilter] = useState("5"); // NOTICE and above
    const [sysSearch, setSysSearch] = useState("");
    const [sysPage, setSysPage] = useState(1);
    const sysPageSize = 50;

    // ── System Logs sub-tab — live tail state ──
    const [sysLive, setSysLive] = useState(false);
    const [sysLiveRows, setSysLiveRows] = useState([]);
    const [sysDropped, setSysDropped] = useState(0);
    const sysEsRef = useRef(null);

    // Keys must be stable primitive strings — arrays compare by reference in
    // useCallback deps and Map lookups, causing a cache miss and new API call
    // every render (infinite loop).
    const statsKey = `audit-logs/stats?from=${statsDateRange.fromDate}&to=${statsDateRange.toDate}`;
    const listKey = `audit-logs/list?page=${page}&from=${filters.fromDate}&to=${filters.toDate}&method=${filters.method}&status=${filters.statusCategory}&search=${filters.search}`;

    const {
        data: statsData,
        loading: statsLoading,
        error: statsError,
        refetch: refetchStats,
    } = useRequest(statsKey, () => auditLogApi.stats(statsDateRange), { staleTime: 60_000 });

    const {
        data: listData,
        loading: listLoading,
        error: listError,
        refetch: refetchList,
    } = useRequest(listKey, () => auditLogApi.list({ ...filters, page, pageSize }), { staleTime: 30_000 });

    // Both useRequest() calls above destructure `error` on purpose: without it
    // a fetch failure falls through to the audit-log table's generic "No audit
    // log records match the current filters." empty text, and the stats row's
    // cards silently show their zero defaults. Both are friendly-shaped here via
    // extractApiError for the components to render.
    const statsErrorMessage = statsError ? extractApiError(statsError, "Failed to load audit statistics.").message : null;
    const listErrorMessage = listError ? extractApiError(listError, "Failed to load audit log.").message : null;

    // ── System Logs sub-tab — browse fetch ──
    const { level: sysLevel, maxPriority: sysMaxPriority } = _parseSystemLevelFilter(sysLevelFilter);
    const systemLogsKey = `audit-logs/system-logs?date=${sysDate}&level=${sysLevel ?? ""}&maxPriority=${sysMaxPriority ?? ""}&page=${sysPage}&search=${sysSearch}`;
    const {
        data: systemLogsData,
        loading: systemLogsLoading,
        error: systemLogsError,
        refetch: refetchSystemLogs,
    } = useRequest(
        systemLogsKey,
        () =>
            systemLogApi.list({
                date: sysDate,
                level: sysLevel,
                maxPriority: sysMaxPriority,
                page: sysPage,
                pageSize: sysPageSize,
                search: sysSearch || undefined,
            }),
        { staleTime: 15_000, enabled: activeAuditSubTab === "system" },
    );
    const systemLogsErrorMessage = systemLogsError ? extractApiError(systemLogsError, "Failed to load system logs.").message : null;

    /**
     * Change the System sub-tab's date filter. Resets pagination; turning
     * away from today automatically stops the live tail (server only tails
     * TODAY's directory).
     *
     * @param {string} d - 'YYYY-MM-DD'
     */
    const handleSystemDateChange = useCallback((d) => {
        setSysDate(d);
        setSysPage(1);
        if (d !== _today()) setSysLive(false);
    }, []);

    /**
     * Change the System sub-tab's Level filter (one Select drives both an
     * exact level and a maxPriority ceiling — see SYSTEM_LOG_LEVEL_OPTIONS).
     * Resets pagination.
     *
     * @param {string} value - One of SYSTEM_LOG_LEVEL_OPTIONS' values.
     */
    const handleSystemLevelChange = useCallback((value) => {
        setSysLevelFilter(value);
        setSysPage(1);
    }, []);

    /**
     * Change the System sub-tab's search text. Resets pagination.
     * @param {string} value
     */
    const handleSystemSearchChange = useCallback((value) => {
        setSysSearch(value);
        setSysPage(1);
    }, []);

    /** Change the System sub-tab's page. @param {number} newPage */
    const handleSystemPageChange = useCallback((newPage) => {
        setSysPage(newPage);
    }, []);

    // ── System Logs sub-tab — live tail (SSE) ──
    // Opens a dedicated EventSource whenever sysLive is toggled on; closes it
    // on toggle-off, level/date change (deps below), or unmount. Separate
    // connection from the audit-traffic stream above (server tracks the two
    // independently — see SystemLogTailService).
    useEffect(() => {
        if (!sysLive) {
            sysEsRef.current?.close();
            sysEsRef.current = null;
            return undefined;
        }

        setSysLiveRows([]);
        setSysDropped(0);

        const es = systemLogApi.createStream({
            maxPriority: sysMaxPriority ?? (sysLevel ? SYSTEM_LOG_PRIORITY[sysLevel] : 5),
            // Same level/maxPriority translation the browse fetch above uses
            // (_parseSystemLevelFilter) — the server is now the primary
            // filter for an exact-level connection. The client-side refine
            // below stays as cheap defense-in-depth; it becomes a no-op in
            // the common case once the server is compliant.
            level: sysLevel,
            onLines: (data) => {
                const incoming = sysLevel ? (data.lines ?? []).filter((l) => String(l.level).toLowerCase() === sysLevel) : (data.lines ?? []);
                if (incoming.length === 0 && !data.dropped) return;
                setSysLiveRows((prev) => {
                    const next = [...incoming, ...prev];
                    return next.length > MAX_LIVE_SYSTEM_ROWS ? next.slice(0, MAX_LIVE_SYSTEM_ROWS) : next;
                });
                if (data.dropped) setSysDropped((d) => d + data.dropped);
            },
            onError: () => setSysLive(false),
        });
        sysEsRef.current = es;

        return () => {
            es.close();
            sysEsRef.current = null;
        };
        // Deliberately narrow deps: only a live-toggle or a level-filter change
        // should tear the stream down and reopen it. Including the setters or
        // sysDate would reconnect on every unrelated state change.
    }, [sysLive, sysLevel, sysMaxPriority]);

    /**
     * Toggle the System sub-tab's live-tail mode on/off.
     * @param {boolean} next
     */
    const handleToggleSystemLive = useCallback((next) => {
        setSysLive(next);
    }, []);

    /**
     * Opens the shared Trace modal for a System-log row. System log rows have
     * no DB audit record — a synthetic row carrying just REQUEST_ID/CREATED_AT
     * (and best-effort METHOD/ENDPOINT) is built so RequestLogsModal's
     * existing (requestId, date) lookup works unmodified.
     *
     * @param {object} row - A parsed system-log row (ts/level/requestId/method/location/…).
     */
    const handleViewSystemRow = useCallback(
        (row) => {
            const createdAt = row.ts ? row.ts.replace(" ", "T") : `${sysDate}T00:00:00`;
            handleViewRow({
                REQUEST_ID: row.requestId,
                CREATED_AT: createdAt,
                METHOD: row.method,
                STATUS_CODE: null,
                RESPONSE_TIME_MS: null,
                USERNAME: null,
                ENDPOINT: row.location,
                PARAMS: null,
            });
        },
        // handleViewRow is defined below with `const`, not memoised — safe to
        // omit from deps (module-stable function identity per render is not
        // required here since this handler is only invoked from a click).
        [sysDate],
    );

    // ── Live updates via SSE (replaces the old 30 s countdown polling) ───────────
    // The server pushes `update` events when new audit rows arrive and `heartbeat`
    // events on idle ticks; both carry a live traffic-metrics snapshot { red, totals }
    // sourced from MetricsStore (OPTIONS already excluded server-side).
    const [isLive, setIsLive] = useState(false);
    const [lastHeartbeat, setLastHeartbeat] = useState(null);
    const [trafficSnapshot, setTrafficSnapshot] = useState(null); // latest { red, totals, system, rates }
    const [trafficSeries, setTrafficSeries] = useState([]); // rolling per-tick deltas for the stacked bar
    const [isRefreshing, setIsRefreshing] = useState(false);

    const esRef = useRef(null); // open EventSource, or null when closed
    const isRefreshingRef = useRef(false); // guard against concurrent manual refreshes
    const prevTotalsRef = useRef(null); // previous cumulative totals — for delta-based traffic buckets

    /**
     * Manual refresh — fetches fresh stats + list independently of the SSE stream.
     * Wired to the header Refresh button and to tab-visibility restore.
     * Idempotent: concurrent calls collapse into one in-flight request.
     *
     * @returns {Promise<void>}
     */
    const triggerRefresh = useCallback(async () => {
        if (isRefreshingRef.current) return;
        isRefreshingRef.current = true;
        setIsRefreshing(true);
        try {
            await Promise.all([refetchStats(), refetchList()]);
        } finally {
            isRefreshingRef.current = false;
            setIsRefreshing(false);
        }
    }, [refetchStats, refetchList]);

    // ── SSE lifecycle (Page Visibility API aware, CWE-362 cancelled guard) ───────
    useEffect(() => {
        let cancelled = false;

        /**
         * Apply an incoming metrics payload: store the latest snapshot (tiles +
         * gauges + top-endpoint charts) and append a delta bucket to the rolling
         * traffic series (the live stacked bar). The first payload after a (re)open
         * only sets the baseline — no bucket — so returning to the tab never emits
         * a phantom spike from the cumulative counter gap.
         *
         * @param {object} metrics - { red, totals, system, rates }
         * @param {string} [iso]   - Event timestamp for the axis label
         */
        const applyMetrics = (metrics, iso) => {
            if (!metrics) return;
            setTrafficSnapshot(metrics);

            const cur = metrics.totals;
            if (!cur) return;
            const prev = prevTotalsRef.current;
            prevTotalsRef.current = cur;
            if (!prev) return; // baseline only

            const bucket = {
                label: _timeLabel(iso),
                success: Math.max(0, (cur.successTotal ?? 0) - (prev.successTotal ?? 0)),
                notModified: Math.max(0, (cur.notModifiedTotal ?? 0) - (prev.notModifiedTotal ?? 0)),
                redirect: Math.max(0, (cur.redirectsTotal ?? 0) - (prev.redirectsTotal ?? 0)),
                client: Math.max(0, (cur.clientErrorsTotal ?? 0) - (prev.clientErrorsTotal ?? 0)),
                server: Math.max(0, (cur.serverErrorsTotal ?? 0) - (prev.serverErrorsTotal ?? 0)),
            };
            setTrafficSeries((arr) => {
                const next = [...arr, bucket];
                return next.length > MAX_TRAFFIC_POINTS ? next.slice(next.length - MAX_TRAFFIC_POINTS) : next;
            });
        };

        const openStream = () => {
            if (esRef.current) return;
            const es = auditLogApi.createStream({
                onUpdate: (data) => {
                    if (cancelled) return;
                    applyMetrics(data.metrics, data.timestamp);
                    // New audit rows detected — silently refetch (no skeleton flash).
                    refetchStats();
                    refetchList();
                },
                onHeartbeat: (data) => {
                    if (cancelled) return;
                    applyMetrics(data.metrics, data.timestamp);
                    setLastHeartbeat({ timestamp: data.timestamp, pollCount: data.pollCount });
                },
                onError: () => {
                    if (!cancelled) setIsLive(false);
                },
            });
            es.onopen = () => {
                if (!cancelled) setIsLive(true);
            };
            esRef.current = es;
        };

        const closeStream = () => {
            esRef.current?.close();
            esRef.current = null;
            prevTotalsRef.current = null; // re-baseline deltas on next open
            if (!cancelled) setIsLive(false);
        };

        const handleVisibilityChange = () => {
            if (document.visibilityState === "visible") {
                openStream();
                // Catch up on anything missed while the tab was hidden.
                refetchStats();
                refetchList();
            } else {
                // Free the server connection while the tab is backgrounded.
                closeStream();
            }
        };

        document.addEventListener("visibilitychange", handleVisibilityChange);
        if (document.visibilityState === "visible") openStream();

        return () => {
            cancelled = true;
            document.removeEventListener("visibilitychange", handleVisibilityChange);
            closeStream();
        };
    }, [refetchStats, refetchList]);

    /**
     * Update a single filter field and reset pagination to page 1.
     *
     * @param {string} field - The filter key to update.
     * @param {string} value - The new value.
     */
    const handleFilterChange = (field, value) => {
        setFilters((prev) => {
            if (prev[field] === value) return prev;
            return { ...prev, [field]: value };
        });
        setPage(1);
    };

    /**
     * Navigate to a specific table page.
     *
     * @param {number} newPage
     */
    const handlePageChange = (newPage) => {
        setPage(newPage);
    };

    /**
     * Open the investigation modal for a specific audit log row.
     * Fetches correlated log lines by REQUEST_ID from the server.
     *
     * @param {object} row - Audit log row from the table.
     */
    const handleViewRow = async (row) => {
        setApiError(null);
        setSelectedRow(row);
        setLogsModalOpen(true);
        setRequestLogsData(null);
        setRequestLogsLoading(true);
        try {
            const date = _localDateStr(new Date(row.CREATED_AT));
            const data = await auditLogApi.requestLogs(row.REQUEST_ID, date);
            setRequestLogsData(data);
        } catch (err) {
            setRequestLogsData({ status: "error", data: { lines: [] } });
            setApiError(extractApiError(err, "Could not load log trace for this request."));
        } finally {
            setRequestLogsLoading(false);
        }
    };

    /** Close the investigation modal and reset its state. */
    const handleCloseLogsModal = () => {
        setApiError(null);
        setLogsModalOpen(false);
        setSelectedRow(null);
        setRequestLogsData(null);
    };

    /**
     * Export a single request trace as an Excel (.xlsx) file.
     * Downloads the workbook generated by the backend (Request Summary + Log Trace sheets).
     *
     * @param {object} row  - Audit log row (must have REQUEST_ID and CREATED_AT).
     * @param {string} date - ISO date string YYYY-MM-DD for the log file search.
     * @returns {Promise<void>}
     */
    const handleExportTrace = async (row, date) => {
        if (!row?.REQUEST_ID || !date) return;
        try {
            const buffer = await auditLogApi.traceExcel(row.REQUEST_ID, date);
            const url = URL.createObjectURL(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = `trace-${row.REQUEST_ID}-${date.replace(/-/g, "")}.xlsx`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (err) {
            setApiError(extractApiError(err, "Failed to export trace. Please try again."));
        }
    };

    // ── Delete Logging stepper state ──────────────────────────────────────────
    const [deleteStep, setDeleteStep] = useState(1);
    const [deleteFromDate, setDeleteFromDate] = useState("");
    const [deleteToDate, setDeleteToDate] = useState("");
    const [deleteConfirmed, setDeleteConfirmed] = useState(false);
    const [deleting, setDeleting] = useState(false);

    /**
     * Download Excel export of DB audit records for the selected delete range.
     * Triggers a browser download of the generated workbook.
     *
     * @returns {Promise<void>}
     */
    const handleExportDeleteExcel = async () => {
        if (!deleteFromDate || !deleteToDate) return;
        try {
            const res = await auditLogApi.exportExcel({ fromDate: deleteFromDate, toDate: deleteToDate });
            const url = URL.createObjectURL(new Blob([res], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = `audit-logs-${deleteFromDate}-to-${deleteToDate}.xlsx`;
            a.click();
            URL.revokeObjectURL(url);
            triggerRefresh();
        } catch (err) {
            setApiError(extractApiError(err, "Failed to generate Excel export."));
        }
    };

    /**
     * Download ZIP of server log files for the selected delete range.
     * Triggers a browser download of the generated archive.
     *
     * @returns {Promise<void>}
     */
    const handleExportDeleteLogs = async () => {
        if (!deleteFromDate || !deleteToDate) return;
        try {
            const res = await auditLogApi.exportLogs({ fromDate: deleteFromDate, toDate: deleteToDate });
            const url = URL.createObjectURL(new Blob([res], { type: "application/zip" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = `server-logs-${deleteFromDate}-to-${deleteToDate}.zip`;
            a.click();
            URL.revokeObjectURL(url);
            triggerRefresh();
        } catch (err) {
            setApiError(extractApiError(err, "Failed to generate log ZIP."));
        }
    };

    /**
     * Permanently delete all audit DB records and log files in the selected range.
     * Advances the stepper to step 3 on success.
     *
     * @returns {Promise<void>}
     */
    const handleConfirmDelete = async () => {
        if (!deleteConfirmed || !deleteFromDate || !deleteToDate) return;
        setDeleting(true);
        try {
            const res = await auditLogApi.deleteRange({ fromDate: deleteFromDate, toDate: deleteToDate });
            const failedDays = res?.data?.failedDays;
            if (failedDays?.length) {
                toast.error(
                    `${failedDays.length} day folder(s) could not be deleted — files may be locked: ${failedDays.join(", ")}`,
                );
            } else {
                toast.success("Audit records and log files permanently deleted.");
            }
            setDeleteStep(3);
            triggerRefresh();
        } catch (err) {
            setApiError(extractApiError(err, "Deletion failed. Please try again."));
        } finally {
            setDeleting(false);
        }
    };

    /**
     * Reset the Delete Logging stepper back to step 1, clearing all state.
     */
    const handleResetDeleteStepper = () => {
        setDeleteStep(1);
        setDeleteFromDate("");
        setDeleteToDate("");
        setDeleteConfirmed(false);
    };

    return {
        // Stats
        statsData,
        statsLoading,
        statsError,
        statsErrorMessage,
        statsDateRange,
        setStatsDateRange,
        // List
        listData,
        listLoading,
        listError,
        listErrorMessage,
        filters,
        page,
        pageSize,
        // Callbacks
        handleFilterChange,
        handlePageChange,
        refetchList,
        // Live updates (SSE)
        isLive,
        lastHeartbeat,
        trafficSnapshot,
        trafficSeries,
        isRefreshing,
        triggerRefresh,
        // Trace modal
        logsModalOpen,
        selectedRow,
        requestLogsData,
        requestLogsLoading,
        handleViewRow,
        handleCloseLogsModal,
        handleExportTrace,
        // Delete Logging stepper
        deleteStep,
        setDeleteStep,
        deleteFromDate,
        setDeleteFromDate,
        deleteToDate,
        setDeleteToDate,
        deleteConfirmed,
        setDeleteConfirmed,
        deleting,
        handleExportDeleteExcel,
        handleExportDeleteLogs,
        handleConfirmDelete,
        handleResetDeleteStepper,

        // Audit Logs top-level tab — nested sub-tab (User Traffic | System)
        activeAuditSubTab,
        setActiveAuditSubTab,

        // System Logs sub-tab — browse
        sysDate,
        sysLevelFilter,
        sysSearch,
        sysPage,
        sysPageSize,
        systemLogsData,
        systemLogsLoading,
        systemLogsError,
        systemLogsErrorMessage,
        refetchSystemLogs,
        handleSystemDateChange,
        handleSystemLevelChange,
        handleSystemSearchChange,
        handleSystemPageChange,
        // System Logs sub-tab — live tail
        sysLive,
        sysLiveRows,
        sysDropped,
        handleToggleSystemLive,
        handleViewSystemRow,

        // API error
        apiError,
        setApiError,
    };
};

export default useLogsManagement;
