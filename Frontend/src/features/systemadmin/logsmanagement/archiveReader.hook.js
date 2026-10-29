/**
 * @fileoverview useArchiveReader — hook for the "Archive Reader" tab.
 *
 * DELIBERATE DEVIATION from the three-layer api/hook/view pattern: this feature
 * has NO .api.js file because it makes ZERO HTTP calls. It reads previously
 * exported artifacts (the audit Excel from GET /audit-logs/export/excel and the
 * log ZIP from GET /audit-logs/export/logs) entirely in the browser, so the
 * hook owns only local parsing, search/pagination state, and the trace modal.
 */

import { useMemo, useState } from "react";
import JSZip from "jszip";
import { toast } from "../../../components/ui/toast.utils";

// ─── Guards (zip-bomb / wrong-file protection) ─────────────────────────────────

const MAX_ZIP_ENTRIES = 2000;
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024; // 200 MB
const DEFAULT_PAGE_SIZE = 20;

/** Column headers exactly as written by AuditLogService.exportToExcel. */
const EXCEL_HEADER_TO_KEY = {
    "Date": "CREATED_AT",
    "Request ID": "REQUEST_ID",
    "Username": "USERNAME",
    "Method": "METHOD",
    "Endpoint": "ENDPOINT",
    "Status Code": "STATUS_CODE",
    "Response Time (ms)": "RESPONSE_TIME_MS",
    "Client IP": "CLIENT_IP",
};

/**
 * True when the buffer starts with the ZIP local-file-header magic (PK\x03\x04).
 * Both .xlsx and .zip share this signature — callers must additionally inspect
 * the archive structure to tell them apart.
 * @param {ArrayBuffer} buf
 * @returns {boolean}
 */
export function hasZipMagic(buf) {
    const b = new Uint8Array(buf.slice(0, 4));
    return b.length === 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

/**
 * Mirror of Backend AuditLogService.getRequestLogs phase ranking:
 * Incoming Request = 0, everything else = 1, Request Complete = 2.
 * @param {string} line
 * @returns {number}
 */
export function phaseRank(line) {
    if (line.includes("[Incoming Request]")) return 0;
    if (line.includes("[Request Complete]")) return 2;
    return 1;
}

const TS_RE = /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?)\]/;

/**
 * Extract the `[requestId]`-tagged lines from the loaded log corpus and sort
 * them exactly like Backend AuditLogService.getRequestLogs: chronologically by
 * embedded timestamp padded to millisecond precision, phase-rank tiebreak.
 * @param {string[]} allLines - every log line loaded from the ZIP
 * @param {string} requestId
 * @returns {string[]}
 */
export function buildTrace(allLines, requestId) {
    if (!requestId) return [];
    const token = `[${requestId}]`;
    const matched = allLines.filter((l) => l.includes(token));
    matched.sort((a, b) => {
        const ta = (a.match(TS_RE)?.[1] ?? "").padEnd(23, ".000");
        const tb = (b.match(TS_RE)?.[1] ?? "").padEnd(23, ".000");
        const cmp = ta.localeCompare(tb);
        return cmp !== 0 ? cmp : phaseRank(a) - phaseRank(b);
    });
    return matched;
}

// ─── Hook ──────────────────────────────────────────────────────────────────────

/**
 * State + parsing logic for the Archive Reader tab (fully offline).
 *
 * @returns {object} hook surface — Excel slot state, ZIP slot state, filtered
 * paginated rows, and a RequestLogsModal-compatible sub-object (`modalHook`).
 */
export default function useArchiveReader() {
    // Excel slot
    const [excelFileName, setExcelFileName] = useState("");
    const [excelRows, setExcelRows] = useState([]);
    const [excelLoading, setExcelLoading] = useState(false);
    const [excelError, setExcelError] = useState("");

    // ZIP slot
    const [zipFileName, setZipFileName] = useState("");
    const [logLines, setLogLines] = useState([]);
    const [zipFileCount, setZipFileCount] = useState(0);
    const [zipLoading, setZipLoading] = useState(false);
    const [zipError, setZipError] = useState("");

    // Table state (client-side)
    const [search, setSearch] = useState("");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSizeState] = useState(DEFAULT_PAGE_SIZE);

    // Trace modal state
    const [logsModalOpen, setLogsModalOpen] = useState(false);
    const [selectedRow, setSelectedRow] = useState(null);
    const [traceLines, setTraceLines] = useState([]);

    /**
     * Parse the audit Excel export (sheet "Audit Records") in the browser.
     * @param {File} file
     */
    const handleExcelFile = async (file) => {
        if (!file) return;
        setExcelLoading(true);
        setExcelError("");
        setExcelRows([]);
        try {
            const buf = await file.arrayBuffer();
            if (!hasZipMagic(buf)) throw new Error("Not a valid .xlsx file (bad file signature).");

            const ExcelJS = await import("exceljs");
            const workbook = new (ExcelJS.Workbook ?? ExcelJS.default.Workbook)();
            await workbook.xlsx.load(buf);

            const sheet = workbook.getWorksheet("Audit Records");
            if (!sheet) throw new Error('Workbook has no "Audit Records" sheet — is this the audit Excel export?');

            // Map header row → column keys
            const headerRow = sheet.getRow(1);
            const colKeys = {};
            headerRow.eachCell((cell, colNumber) => {
                const key = EXCEL_HEADER_TO_KEY[String(cell.value ?? "").trim()];
                if (key) colKeys[colNumber] = key;
            });
            if (Object.keys(colKeys).length === 0) {
                throw new Error("No recognised audit columns found in the first row.");
            }

            const rows = [];
            sheet.eachRow((row, rowNumber) => {
                if (rowNumber === 1) return; // header
                const obj = {};
                row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                    const key = colKeys[colNumber];
                    if (!key) return;
                    let v = cell.value;
                    if (v instanceof Date) v = v.toISOString();
                    else if (v && typeof v === "object" && "text" in v) v = v.text;
                    obj[key] = v ?? "";
                });
                rows.push(obj);
            });

            setExcelRows(rows);
            setExcelFileName(file.name);
            setPage(1);
            toast.success(`Loaded ${rows.length} audit record(s) from ${file.name}.`);
        } catch (err) {
            const msg = err?.message || "Failed to read the Excel file.";
            setExcelError(msg);
            setExcelFileName("");
            toast.error(msg);
        } finally {
            setExcelLoading(false);
        }
    };

    /**
     * Parse the log ZIP export (entries named YYYY/MM/DD/<level>.log) in the
     * browser with zip-bomb guards: entry-count cap, uncompressed-size cap,
     * and .log-only reads. Rejects Office documents (contain [Content_Types].xml).
     * @param {File} file
     */
    const handleZipFile = async (file) => {
        if (!file) return;
        setZipLoading(true);
        setZipError("");
        setLogLines([]);
        setZipFileCount(0);
        try {
            const buf = await file.arrayBuffer();
            if (!hasZipMagic(buf)) throw new Error("Not a valid .zip file (bad file signature).");

            const zip = await JSZip.loadAsync(buf);

            // XLSX/DOCX are also ZIPs — an Office container is the wrong artifact here.
            if (zip.file("[Content_Types].xml")) {
                throw new Error("This looks like an Office document (.xlsx?), not the log ZIP export.");
            }

            const entries = Object.values(zip.files).filter((e) => !e.dir);
            if (entries.length > MAX_ZIP_ENTRIES) {
                throw new Error(`ZIP has ${entries.length} entries — exceeds the ${MAX_ZIP_ENTRIES}-entry safety cap.`);
            }

            // Only log entries in the exporter's YYYY/MM/DD/<name>.log layout are read.
            const logEntries = entries.filter((e) => /^\d{4}\/\d{2}\/\d{2}\/[^/]+\.log$/.test(e.name));
            if (logEntries.length === 0) {
                throw new Error("No YYYY/MM/DD/<level>.log entries found — is this the server-logs ZIP export?");
            }

            const lines = [];
            let totalBytes = 0;
            for (const entry of logEntries) {
                const text = await entry.async("string");
                totalBytes += text.length;
                if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
                    throw new Error("Uncompressed log content exceeds the 200 MB safety cap.");
                }
                for (const line of text.split("\n")) {
                    const trimmed = line.trim();
                    if (trimmed) lines.push(trimmed);
                }
            }

            setLogLines(lines);
            setZipFileCount(logEntries.length);
            setZipFileName(file.name);
            toast.success(`Loaded ${lines.length} log line(s) from ${logEntries.length} file(s).`);
        } catch (err) {
            const msg = err?.message || "Failed to read the ZIP file.";
            setZipError(msg);
            setZipFileName("");
            toast.error(msg);
        } finally {
            setZipLoading(false);
        }
    };

    /** Clear the Excel slot. */
    const clearExcel = () => {
        setExcelRows([]);
        setExcelFileName("");
        setExcelError("");
        setPage(1);
    };

    /** Clear the ZIP slot. */
    const clearZip = () => {
        setLogLines([]);
        setZipFileName("");
        setZipError("");
        setZipFileCount(0);
    };

    // ── Client-side search + pagination ──
    const filteredRows = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return excelRows;
        // STATUS_CODE is left unwrapped on purpose: the `?? ""` below is what
        // keeps a missing column from searching as the text "undefined". A
        // workbook without a Status Code column used to match every row on
        // "un", "def", "fine"… because String(undefined) ran first.
        return excelRows.filter((r) =>
            [r.REQUEST_ID, r.USERNAME, r.METHOD, r.ENDPOINT, r.CLIENT_IP, r.STATUS_CODE]
                .some((v) => String(v ?? "").toLowerCase().includes(q)),
        );
    }, [excelRows, search]);

    const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
    const pageRows = useMemo(
        () => filteredRows.slice((page - 1) * pageSize, page * pageSize),
        [filteredRows, page, pageSize],
    );

    /**
     * Change the archive table's per-page row count. Resets pagination to
     * page 1. Purely client-side (all rows already loaded in memory) — no
     * server clamp applies.
     * @param {number} size
     */
    const setPageSize = (size) => {
        setPageSizeState(size);
        setPage(1);
    };

    /** Open the trace modal for an audit row — scans the loaded log lines. */
    const handleViewRow = (row) => {
        setSelectedRow(row);
        setTraceLines(buildTrace(logLines, row?.REQUEST_ID));
        setLogsModalOpen(true);
    };

    const handleCloseLogsModal = () => {
        setLogsModalOpen(false);
        setSelectedRow(null);
        setTraceLines([]);
    };

    /** Update the search box and reset pagination. */
    const handleSearchChange = (v) => {
        setSearch(v);
        setPage(1);
    };

    // RequestLogsModal-compatible hook-shaped object (offline: no export, no API).
    const modalHook = {
        logsModalOpen,
        handleCloseLogsModal,
        selectedRow,
        requestLogsData: { data: { lines: traceLines } },
        requestLogsLoading: false,
        handleExportTrace: () => {},
        apiError: null,
        setApiError: () => {},
    };

    return {
        // Excel slot
        excelFileName,
        excelRows,
        excelLoading,
        excelError,
        handleExcelFile,
        clearExcel,
        // ZIP slot
        zipFileName,
        logLines,
        zipFileCount,
        zipLoading,
        zipError,
        handleZipFile,
        clearZip,
        // Table
        search,
        handleSearchChange,
        page,
        setPage,
        pageSize,
        setPageSize,
        totalPages,
        pageRows,
        filteredCount: filteredRows.length,
        handleViewRow,
        // Modal
        modalHook,
    };
}
