import { faDownload } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import ApiErrorAlert from "../../../../components/feedback/ApiErrorAlert";
import Badge from "../../../../components/ui/Badge";
import Button from "../../../../components/ui/Button";
import { Modal } from "../../../../components/ui/Modal";
import Skeleton from "../../../../components/ui/Skeleton";

// ─── Log line parser ───────────────────────────────────────────────────────────

// Detect the phase of a log line by its content
function detectPhase(line) {
    if (line.includes("[Incoming Request]")) return "incoming";
    if (line.includes("[Request Complete]")) return "complete";
    if (line.includes("[Handling Request]")) return "handling";
    return "func";
}

// Extract the human-readable part after the last "] - " separator
function extractMessage(line) {
    const idx = line.lastIndexOf("] - ");
    return idx !== -1 ? line.slice(idx + 4) : line;
}

// Extract timestamp [YYYY-MM-DD HH:MM:SS]
function extractTimestamp(line) {
    const m = line.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?)\]/);
    return m ? m[1].split(" ")[1] : "";
}

// Extract function/location [fn @ file:line]
function extractLocation(line) {
    const m = line.match(/\[([^\]]+\s@\s[^\]]+:\d+)\]/);
    return m ? m[1] : "";
}

// ─── Phase styling ─────────────────────────────────────────────────────────────

const PHASE_CONFIG = {
    incoming: {
        label: "Incoming",
        badge: "blue",
        bar: "bg-blue-400",
        textColor: "text-(--blue-foreground)",
    },
    handling: {
        label: "Handling",
        badge: "cyan",
        bar: "bg-turquoise-400",
        textColor: "text-(--turquoise-foreground)",
    },
    func: {
        label: "Function",
        badge: "grey",
        bar: "bg-grey-300 dark:bg-white/20",
        textColor: "text-grey-600 dark:text-white/70",
    },
    complete: {
        label: "Complete",
        badge: "green",
        bar: "bg-success-400",
        textColor: "text-success-400 dark:text-success-300",
    },
};

// ─── Single log line ───────────────────────────────────────────────────────────

function LogEntry({ line, isLast }) {
    const phase = detectPhase(line);
    const cfg = PHASE_CONFIG[phase];
    const message = extractMessage(line);
    const time = extractTimestamp(line);
    const location = extractLocation(line);

    return (
        <div className="flex gap-3">
            {/* Timeline connector */}
            <div className="flex flex-col items-center">
                <div className={`w-2.5 h-2.5 rounded-full mt-1 shrink-0 ${cfg.bar}`} />
                {!isLast && <div className="w-px flex-1 bg-grey-200 dark:bg-white/10 mt-1" />}
            </div>

            {/* Content */}
            <div className="pb-4 min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-0.5">
                    <Badge variant={cfg.badge} size="xs">
                        {cfg.label}
                    </Badge>
                    {time && <span className="text-xs text-grey-400 dark:text-white/40 font-mono">{time}</span>}
                </div>
                <p className={`text-sm font-mono break-all ${cfg.textColor}`}>{message}</p>
                {location && <p className="text-xs text-grey-400 dark:text-white/30 font-mono mt-0.5 truncate">{location}</p>}
            </div>
        </div>
    );
}

// ─── Params display ────────────────────────────────────────────────────────────

function ParamsSection({ params }) {
    if (!params) return null;
    let parsed;
    try {
        parsed = JSON.parse(params);
    } catch {
        parsed = params;
    }

    return (
        <div className="mb-4 rounded-lg border border-(--color-card-surface-border) dark:border-white/10 overflow-hidden">
            <div className="bg-grey-50 dark:bg-white/5 px-3 py-1.5 text-xs font-semibold text-grey-500 dark:text-white/50 border-b border-grey-100 dark:border-white/10">Query Parameters</div>
            <pre className="p-3 text-xs font-mono text-grey-700 dark:text-white/70 overflow-x-auto whitespace-pre-wrap break-all">{typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2)}</pre>
        </div>
    );
}

// ─── Trace date helper ─────────────────────────────────────────────────────────

function _traceDate(row) {
    if (!row?.CREATED_AT) return "";
    const d = new Date(row.CREATED_AT);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

// ─── Component ─────────────────────────────────────────────────────────────────

/**
 * Trace modal — shows the audit log row's params and correlated
 * log-file lines (Incoming → Function functions → Request Complete).
 *
 * @param {{ hook: object }} props
 */
export default function RequestLogsModal({ hook }) {
    const { logsModalOpen, handleCloseLogsModal, selectedRow, requestLogsData, requestLogsLoading, handleExportTrace, apiError, setApiError } = hook;

    const lines = requestLogsData?.data?.lines ?? [];
    const date = _traceDate(selectedRow);

    const canExport = !!selectedRow && !requestLogsLoading && lines.length > 0;

    return (
        <Modal
            open={logsModalOpen}
            onClose={handleCloseLogsModal}
            title={selectedRow ? `Trace — ${selectedRow.REQUEST_ID ?? "—"}` : "Trace"}
            size="xl"
            footer={
                <div className="flex justify-end">
                    <Button variant="ghost" size="sm" disabled={!canExport} onClick={() => handleExportTrace(selectedRow, date)}>
                        <FontAwesomeIcon icon={faDownload} className="w-4 h-4 mr-1.5" />
                        Export Trace
                    </Button>
                </div>
            }
        >
            {/* Inline error — a view-level alert would sit behind the modal overlay */}
            <ApiErrorAlert error={apiError} onDismiss={() => setApiError(null)} className="mb-4" />
            {selectedRow && (
                <>
                    {/* Request summary */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4 text-sm">
                        {[
                            { label: "Method", value: selectedRow.METHOD },
                            { label: "Status", value: selectedRow.STATUS_CODE },
                            { label: "Duration", value: selectedRow.RESPONSE_TIME_MS != null ? `${selectedRow.RESPONSE_TIME_MS} ms` : "—" },
                            { label: "User", value: selectedRow.USERNAME || "—" },
                        ].map(({ label, value }) => (
                            <div key={label} className="rounded-lg border border-(--color-card-surface-border) dark:border-white/10 p-2.5">
                                <p className="text-xs text-grey-400 dark:text-white/40 mb-0.5">{label}</p>
                                <p className="font-mono text-grey-700 dark:text-white/85 truncate">{value ?? "—"}</p>
                            </div>
                        ))}
                    </div>

                    {/* Endpoint */}
                    <div className="mb-4 rounded-lg border border-(--color-card-surface-border) dark:border-white/10 p-2.5">
                        <p className="text-xs text-grey-400 dark:text-white/40 mb-0.5">Endpoint</p>
                        <p className="font-mono text-xs text-grey-700 dark:text-white/85 break-all">{selectedRow.ENDPOINT ?? "—"}</p>
                    </div>

                    {/* Params */}
                    <ParamsSection params={selectedRow.PARAMS} />

                    {/* Log timeline */}
                    <div className="rounded-lg border border-(--color-card-surface-border) dark:border-white/10 overflow-hidden">
                        <div className="bg-grey-50 dark:bg-white/5 px-3 py-1.5 text-xs font-semibold text-grey-500 dark:text-white/50 border-b border-grey-100 dark:border-white/10">Request Log Trace</div>
                        <div className="p-4">
                            {requestLogsLoading ? (
                                <div className="space-y-3">
                                    {Array.from({ length: 3 }).map((_, i) => (
                                        <Skeleton key={i} className="h-10 w-full" />
                                    ))}
                                </div>
                            ) : lines.length === 0 ? (
                                <p className="text-sm text-grey-400 dark:text-white/40 text-center py-4">
                                    No log lines found for this request ID.
                                    {!selectedRow.REQUEST_ID && " (No REQUEST_ID on this record — was the logger updated before this request?)"}
                                </p>
                            ) : (
                                <div>
                                    {lines.map((line, i) => (
                                        <LogEntry key={i} line={line} isLast={i === lines.length - 1} />
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </>
            )}
        </Modal>
    );
}
