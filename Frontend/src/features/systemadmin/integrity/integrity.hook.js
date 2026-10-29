/**
 * @fileoverview Hook for the Integrity Center feature (SUPER_ADMIN only).
 * Owns: the active table, scope filters, mode (tampered-only|all), pagination,
 * the cache-aside fetch, the rescan mutation, the Excel/CSV export and the SSE
 * live-tail.
 *
 * IntegrityCenter.view.jsx imports this hook — never integrity.api.js directly.
 *
 * Tabs come from the backend catalog (models/integrity.model.js registry), so a
 * project that registers a table gets a tab, its filters and its live-tail with
 * no FE wiring. Switching tab resets filters + page. Tampered-only is the default.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { extractApiError, toast } from "../../../components/ui/toast.utils";
import { invalidateCache, useRequest } from "../../../hooks/useRequest";
import { exportRowsToFile } from "../../../utils/excelUtils";
import { getColumns } from "./components/shared/integrityColumns";
import { integrityApi } from "./integrity.api";

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

/** Date-range params; the `date` catalog filter maps onto these. */
const EMPTY_FILTERS = { from: "", to: "" };

/**
 * Builds the useRequest cache key from the active query shape.
 * @returns {string}
 */
function buildKey(table, mode, filters, page, limit) {
    const f =
        Object.entries(filters)
            .filter(([, v]) => v != null && v !== "")
            .map(([k, v]) => `${k}=${v}`)
            .sort()
            .join("&") || "none";
    return `integrity/${table}?mode=${mode}&${f}&page=${page}&limit=${limit}`;
}

/**
 * @returns {object} the Integrity Center hook
 */
export const useIntegrity = () => {
    // ── Tables catalog (static — drives tabs + filter visibility) ──
    const { data: catalog, loading: catalogLoading } = useRequest("integrity/tables", () => integrityApi.getTables().then((r) => r.data?.data?.tables ?? []), { staleTime: 600_000 });
    const tables = useMemo(() => catalog ?? [], [catalog]);
    const tablesByKey = useMemo(() => Object.fromEntries(tables.map((t) => [t.key, t])), [tables]);

    const [apiError, setApiError] = useState(null);
    const [selectedTab, setSelectedTab] = useState(null);
    // Until the operator picks a tab, the first catalog table is active.
    const activeTab = selectedTab && tablesByKey[selectedTab] ? selectedTab : (tables[0]?.key ?? null);

    // ── Scope filters + mode + pagination ──
    const [filters, setFilters] = useState(EMPTY_FILTERS);
    const [mode, setModeRaw] = useState("tamper");
    const [exporting, setExporting] = useState(false);
    const [page, setPage] = useState(1);
    const [limit, setLimitRaw] = useState(50);
    const [rescanning, setRescanning] = useState(false);

    const tabs = useMemo(() => tables.map((t) => ({ id: t.key, label: t.label })), [tables]);
    const activeConfig = activeTab ? (tablesByKey[activeTab] ?? null) : null;
    const activeFilterKeys = useMemo(() => activeConfig?.filters ?? [], [activeConfig]);
    const enumKeys = useMemo(() => activeConfig?.enums ?? [], [activeConfig]);
    // Free-text filters: every registered key that is neither the date range nor a dropdown.
    const textFilterKeys = useMemo(() => activeFilterKeys.filter((k) => k !== "date" && !enumKeys.includes(k)), [activeFilterKeys, enumKeys]);
    const hasDateFilter = activeFilterKeys.includes("date");
    const activeIsLive = activeConfig?.live ?? false;

    // ── Enum dropdown options — DB-sourced, cached ──
    const { data: enumData } = useRequest(activeTab && enumKeys.length > 0 ? `integrity/${activeTab}/filter-options` : null, () => integrityApi.getFilterOptions(activeTab).then((r) => r.data?.data?.options ?? {}), { staleTime: 300_000 });
    const enumOptions = enumData ?? {};

    // ── Setters that reset pagination ──
    const setFilter = useCallback((name, value) => {
        setFilters((f) => ({ ...f, [name]: value }));
        setPage(1);
    }, []);
    const setMode = useCallback((m) => {
        setModeRaw(m);
        setPage(1);
    }, []);
    const setLimit = useCallback((n) => {
        setLimitRaw(Number(n) || 50);
        setPage(1);
    }, []);

    const handleTabChange = useCallback((tabId) => {
        setSelectedTab(tabId);
        setFilters(EMPTY_FILTERS);
        setModeRaw("tamper");
        setPage(1);
    }, []);

    // ── Data fetch (tamper feed or browse) ──
    const cacheKey = activeTab ? buildKey(activeTab, mode, filters, page, limit) : null;
    const {
        data,
        loading,
        error: dataFetchError,
        refetch,
    } = useRequest(
        cacheKey,
        () => {
            const params = { ...filters, page, limit };
            const call = mode === "tamper" ? integrityApi.getTamper : integrityApi.browse;
            return call(activeTab, params).then((r) => r.data?.data ?? {});
        },
        { staleTime: 0 },
    );
    // A fetch failure must never fall through to the "all verified" empty text.
    const dataError = dataFetchError ? extractApiError(dataFetchError, "Failed to load integrity data.") : null;

    const rows = useMemo(() => data?.rows ?? [], [data]);
    const total = data?.total ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const rowsScanned = data?.rowsScanned ?? 0;
    const truncated = data?.truncated ?? false;
    const scannedAt = data?.scannedAt ?? null;
    // Browse mode only: scope-wide tampered count from the backend's cached sweep.
    // In tamper mode `total` already IS the scope-wide count.
    const tamperedInScope = data?.tamperedInScope ?? null;
    const columns = useMemo(() => getColumns(activeTab, rows[0]), [activeTab, rows]);

    // ── Rescan mutation ──
    const rescan = useCallback(async () => {
        if (!activeTab) return;
        setRescanning(true);
        try {
            await integrityApi.rescan(activeTab, { ...filters, limit });
            invalidateCache(cacheKey);
            await refetch();
            toast.success("Re-scan complete.");
        } catch (err) {
            setApiError(extractApiError(err, "Re-scan failed."));
        } finally {
            setRescanning(false);
        }
    }, [activeTab, filters, limit, cacheKey, refetch]);

    // ── SSE live-tail (tables registered with `live: true`) ──
    const esRef = useRef(null);
    const [isLive, setIsLive] = useState(false);
    const [liveNewCount, setLiveNewCount] = useState(0);

    const loadLiveUpdates = useCallback(() => {
        setLiveNewCount(0);
        invalidateCache(cacheKey);
        refetch();
    }, [cacheKey, refetch]);

    // Stream scope = the text/enum filters (the date range bounds the sweep, not the tail).
    const streamScope = useMemo(() => {
        const scope = {};
        for (const k of [...textFilterKeys, ...enumKeys]) if (filters[k]) scope[k] = filters[k];
        return JSON.stringify(scope);
    }, [filters, textFilterKeys, enumKeys]);

    useEffect(() => {
        setLiveNewCount(0);
        if (!activeIsLive || !activeTab) {
            esRef.current?.close();
            esRef.current = null;
            setIsLive(false);
            return undefined;
        }

        let cancelled = false;

        const open = () => {
            if (esRef.current) return;
            const es = integrityApi.createStream(activeTab, {
                params: JSON.parse(streamScope),
                onConnected: () => !cancelled && setIsLive(true),
                onUpdate: (d) => !cancelled && setLiveNewCount((c) => c + (d?.newCount ?? 0)),
                onError: () => !cancelled && setIsLive(false),
            });
            esRef.current = es;
            es.onopen = () => !cancelled && setIsLive(true);
        };
        const close = () => {
            esRef.current?.close();
            esRef.current = null;
            if (!cancelled) setIsLive(false);
        };
        const onVisibility = () => {
            if (document.visibilityState === "visible") open();
            else close();
        };

        document.addEventListener("visibilitychange", onVisibility);
        if (document.visibilityState === "visible") open();

        return () => {
            cancelled = true;
            document.removeEventListener("visibilitychange", onVisibility);
            close();
        };
    }, [activeTab, activeIsLive, streamScope]);

    // ── Export (Excel / CSV) ──────────────────────────────────────────────────

    /**
     * Exports every row in scope for the ACTIVE table. `mode` follows the
     * "Show all rows" toggle so the file matches the screen.
     *
     * @param {'xlsx'|'csv'} format
     * @returns {Promise<void>}
     */
    const handleExportRows = useCallback(
        async (format) => {
            if (!activeTab) return;
            setExporting(true);
            try {
                const res = await integrityApi.exportRows(activeTab, { ...filters, mode });
                const payload = res.data?.data ?? {};
                const exportRows = payload.rows ?? [];

                if (!exportRows.length) {
                    toast.warning(mode === "tamper" ? "No tampered rows to export in the current scope." : "No rows to export in the current scope.");
                    return;
                }

                const header = [...getColumns(activeTab, exportRows[0]).map((c) => c.key), "integrity"];

                await exportRowsToFile({
                    format,
                    header,
                    rows: exportRows,
                    filenameBase: `integrity_${activeTab}_${mode}`,
                    sheetName: `Integrity ${activeTab}`,
                });

                if (payload.truncated) {
                    toast.warning(`Export capped at ${exportRows.length.toLocaleString()} of ${Number(payload.total).toLocaleString()} rows. Narrow the scope to export the rest.`);
                } else if (payload.sweepTruncated) {
                    toast.warning("The tamper sweep was truncated — rows beyond the scan limit are not represented in this file.");
                } else {
                    toast.success(`Integrity rows exported as ${format === "csv" ? "CSV" : "Excel"}.`);
                }
            } catch (err) {
                // `.message`: toast.error renders its argument as a React child.
                toast.error(extractApiError(err, "Failed to export the integrity rows.").message);
            } finally {
                setExporting(false);
            }
        },
        [activeTab, filters, mode],
    );

    return {
        // Tabs
        tabs,
        catalogLoading,
        activeTab,
        handleTabChange,

        // Active table meta
        activeTableKey: activeTab,
        activeConfig,
        activeFilterKeys,
        textFilterKeys,
        hasDateFilter,
        activeIsLive,
        enumKeys,
        enumOptions,

        // Export
        exporting,
        handleExportRows,

        // Filters
        filters,
        setFilter,

        // Mode
        mode,
        setMode,

        // Data
        columns,
        rows,
        total,
        tamperedInScope,
        totalPages,
        rowsScanned,
        truncated,
        scannedAt,
        loading,
        dataError,
        refetch,

        // Pagination
        page,
        setPage,
        limit,
        setLimit,
        pageSizeOptions: PAGE_SIZE_OPTIONS,

        // Rescan
        rescan,
        rescanning,

        // Live
        isLive,
        liveNewCount,
        loadLiveUpdates,

        // API error
        apiError,
        setApiError,
    };
};

export default useIntegrity;
