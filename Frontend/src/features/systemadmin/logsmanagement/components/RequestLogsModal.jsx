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
                {location && <p className="text-xs text-grey-400 dark:text-white/30 font-mono mt-1 truncate">{location}</p>}
            </div>
        </div>
    );
}

// ─── Request-detail extraction from the trace lines ────────────────────────────

/**
 * Lift a `[MARKER @ …]` segment out of a log line.
 *
 * The backend writes these markers deliberately so the frontend does not have to
 * parse prose: `[PARAMS @ …]` / `[BODY @ …]` come from
 * TraceabilityMiddleware.createRequestMessage, `[AUTH @ …]` from
 * AuthMiddleware._traceAuth. Bracket-counting rather than a lazy regex because a
 * JSON body legitimately contains `]`.
 *
 * @param {string} line
 * @param {string} marker - e.g. "BODY"
 * @returns {string|null}
 */
function extractMarker(line, marker) {
    const open = line.indexOf(`[${marker} @ `);
    if (open === -1) return null;
    const start = open + marker.length + 4;
    let depth = 1;
    for (let i = start; i < line.length; i++) {
        if (line[i] === "[") depth++;
        else if (line[i] === "]") {
            depth--;
            if (depth === 0) return line.slice(start, i);
        }
    }
    return line.slice(start);
}

/** First non-null marker value across all trace lines. */
function findMarker(lines, marker) {
    for (const line of lines) {
        const value = extractMarker(line, marker);
        if (value) return value;
    }
    return null;
}

/**
 * The request body, taken from the `[BODY @ …]` segment of the trace.
 *
 * The body is NOT a column on the audit row — `T_AUDIT_LOGS` stores `PARAMS`
 * (req.query) only, deliberately, since bodies carry passwords. The log line is
 * already redacted field-by-field by TraceabilityMiddleware's SENSITIVE_PATTERNS,
 * so reading it from there adds no exposure and needs no schema change.
 *
 * Sentinel strings the backend emits for "there was nothing to show" are treated
 * as empty rather than printed as pseudo-values.
 * @param {string[]} lines
 * @returns {string|null}
 */
function extractBody(lines) {
    const body = findMarker(lines, "BODY");
    if (!body) return null;
    const sentinels = ["req.body is undefined", "req.body is empty object"];
    return sentinels.includes(body.trim()) ? null : body;
}

/**
 * Parse `[AUTH @ key=value key=value]` into ordered pairs for display.
 * @param {string[]} lines
 * @returns {{ key: string, value: string }[]|null}
 */
function extractAuth(lines) {
    const raw = findMarker(lines, "AUTH");
    if (!raw) return null;
    return raw
        .split(" ")
        .filter(Boolean)
        .map((pair) => {
            const eq = pair.indexOf("=");
            return eq === -1 ? { key: pair, value: "" } : { key: pair.slice(0, eq), value: pair.slice(eq + 1) };
        });
}

/** Outcome → Badge variant. `result=verified` is the only success. */
const AUTH_RESULT_VARIANT = {
    verified: "green",
    expired: "warning",
    "not-before": "warning",
    missing: "grey",
    tampered: "red",
    invalid: "red",
};

// ─── Request-detail sections ───────────────────────────────────────────────────

/**
 * Shared panel chrome for the three request-detail blocks.
 *
 * `data-detail` is a stable hook (same convention as the upload stepper's
 * `data-upload-*`). It matters for more than automation: the raw trace lines
 * below print the SAME text these panels extract, so any assertion — or any
 * operator's Ctrl-F — needs a way to say "the Body panel" rather than "somewhere
 * in this modal".
 *
 * @param {{ id: string, title: string, right?: React.ReactNode, children: React.ReactNode }} props
 */
function DetailPanel({ id, title, right, children }) {
    return (
        <div data-detail={id} className="mb-4 rounded-lg border border-(--color-card-surface-border) dark:border-white/10 overflow-hidden">
            <div className="bg-grey-50 dark:bg-white/5 p-3 border-b border-grey-100 dark:border-white/10 flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-grey-500 dark:text-white/50">{title}</span>
                {right}
            </div>
            {children}
        </div>
    );
}

/** Empty-state copy — every panel renders even when empty (see ParamsSection). */
function EmptyNote({ children }) {
    return <p className="p-3 text-xs text-grey-400 dark:text-white/40">{children}</p>;
}

function ParamsSection({ params }) {
    let parsed;
    if (params) {
        try {
            parsed = JSON.parse(params);
        } catch {
            parsed = params;
        }
    }

    const isEmpty = !params || (parsed && typeof parsed === "object" && Object.keys(parsed).length === 0);

    return (
        // Rendered even when empty, on purpose. This is now the ONLY place params
        // appear (the audit table's snippet was removed), so a silently absent
        // panel would be indistinguishable from "this request had no query string".
        <DetailPanel id="query-params" title="Query Parameters">
            {isEmpty ? (
                <EmptyNote>No query string on this request.</EmptyNote>
            ) : (
                <pre className="p-3 text-xs font-mono text-grey-700 dark:text-white/70 overflow-x-auto whitespace-pre-wrap break-all">{typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2)}</pre>
            )}
        </DetailPanel>
    );
}

function BodySection({ body, method, loading }) {
    // GET/DELETE/HEAD never carry a body — say so rather than showing an empty
    // panel that reads as missing data.
    const bodyless = ["GET", "HEAD", "DELETE", "OPTIONS"].includes(String(method ?? "").toUpperCase());

    return (
        <DetailPanel id="body" title="Body Parameters">
            {loading ? (
                <div className="p-3">
                    <Skeleton className="h-4 w-2/3" />
                </div>
            ) : body ? (
                <pre className="p-3 text-xs font-mono text-grey-700 dark:text-white/70 overflow-x-auto whitespace-pre-wrap break-all">{body}</pre>
            ) : bodyless ? (
                <EmptyNote>A {String(method).toUpperCase()} request carries no body.</EmptyNote>
            ) : (
                <EmptyNote>No body recorded for this request. Sensitive fields are redacted at write time, so a value shown as [REDACTED] is intentional.</EmptyNote>
            )}
        </DetailPanel>
    );
}

/**
 * Cookie / token-verification panel.
 *
 * ⚠ Shows only what the backend chose to record: presence, cookie NAMES, the
 * signed-cookie HMAC result, and the verification outcome. Cookie VALUES and the
 * JWT itself are never logged (AuthMiddleware._describeCredential) because these
 * lines are rendered here to any admin and shipped out by Export Trace — a token
 * on screen is a replayable session. Do not "improve" this panel by adding the
 * raw cookie.
 */
function AuthSection({ pairs, loading }) {
    const result = pairs?.find((p) => p.key === "result")?.value;
    const status = pairs?.find((p) => p.key === "status")?.value;

    return (
        <DetailPanel
            id="auth"
            title="Cookie & Token Verification"
            right={
                result ? (
                    <span className="flex items-center gap-2">
                        <Badge variant={AUTH_RESULT_VARIANT[result] ?? "grey"} size="xs">
                            {result}
                        </Badge>
                        {status && <span className="text-xs font-mono text-grey-400 dark:text-white/40">→ {status}</span>}
                    </span>
                ) : null
            }
        >
            {loading ? (
                <div className="p-3">
                    <Skeleton className="h-4 w-1/2" />
                </div>
            ) : !pairs ? (
                <EmptyNote>No authentication step recorded — this route is public, or it authenticates by a path other than AuthMiddleware.</EmptyNote>
            ) : (
                <>
                    <dl className="p-3 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
                        {pairs.map(({ key, value }) => (
                            <div key={key} className="flex gap-2 min-w-0">
                                <dt className="text-xs text-grey-400 dark:text-white/40 shrink-0">{key}</dt>
                                <dd className="text-xs font-mono text-grey-700 dark:text-white/70 break-all" title={value}>
                                    {value || "—"}
                                </dd>
                            </div>
                        ))}
                    </dl>
                    <p className="px-3 pb-3 text-[11px] text-grey-400 dark:text-white/30">Cookie names only — values and tokens are never written to the log.</p>
                </>
            )}
        </DetailPanel>
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
 * @param {{ hook: object, offline?: boolean }} props - `offline` hides the
 * Export Trace footer (used by the Archive Reader tab, which has no backend).
 */
export default function RequestLogsModal({ hook, offline = false }) {
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
                offline ? null : (
                    <div className="flex justify-end">
                        <Button variant="ghost" size="sm" disabled={!canExport} onClick={() => handleExportTrace(selectedRow, date)}>
                            <FontAwesomeIcon icon={faDownload} className="w-4 h-4 mr-1.5" />
                            Export Trace
                        </Button>
                    </div>
                )
            }
        >
            {/* Inline error — the view-level alert is hidden behind the modal overlay */}
            <ApiErrorAlert error={apiError} onDismiss={() => setApiError(null)} className="mb-4" />
            {selectedRow && (
                <>
                    {/* Request summary.
                        Client IP / Server IP live HERE rather than in the audit
                        table: they are per-request forensics you want after
                        picking a row, not something you scan a page of rows for.
                        Six cells at sm:grid-cols-3 = two even rows of three; a
                        4-column grid would leave a ragged 4+2. `title` carries the
                        full value because these cells truncate and an IP is the
                        one field here that is useless when clipped. */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4 text-sm">
                        {[
                            { label: "Method", value: selectedRow.METHOD },
                            { label: "Status", value: selectedRow.STATUS_CODE },
                            { label: "Duration", value: selectedRow.RESPONSE_TIME_MS != null ? `${selectedRow.RESPONSE_TIME_MS} ms` : "—" },
                            { label: "User", value: selectedRow.USERNAME || "—" },
                            { label: "Client IP", value: selectedRow.CLIENT_IP || "—" },
                            { label: "Server IP", value: selectedRow.SERVER_IP || "—" },
                        ].map(({ label, value }) => (
                            <div key={label} className="rounded-lg border border-(--color-card-surface-border) dark:border-white/10 p-3">
                                <p className="text-xs text-grey-400 dark:text-white/40 mb-0.5">{label}</p>
                                <p className="font-mono text-grey-700 dark:text-white/85 truncate" title={value != null ? String(value) : "—"}>
                                    {value ?? "—"}
                                </p>
                            </div>
                        ))}
                    </div>

                    {/* Endpoint */}
                    <div className="mb-4 rounded-lg border border-(--color-card-surface-border) dark:border-white/10 p-3">
                        <p className="text-xs text-grey-400 dark:text-white/40 mb-0.5">Endpoint</p>
                        <p className="font-mono text-xs text-grey-700 dark:text-white/85 break-all">{selectedRow.ENDPOINT ?? "—"}</p>
                    </div>

                    {/* Request detail — query string, body, credential.
                        Query params come from the audit ROW; body and auth are
                        lifted out of the log LINES, which is why they wait on
                        `requestLogsLoading` while this panel does not. */}
                    <ParamsSection params={selectedRow.PARAMS} />
                    <BodySection body={extractBody(lines)} method={selectedRow.METHOD} loading={requestLogsLoading} />
                    <AuthSection pairs={extractAuth(lines)} loading={requestLogsLoading} />

                    {/* Log timeline */}
                    <div className="rounded-lg border border-(--color-card-surface-border) dark:border-white/10 overflow-hidden">
                        <div className="bg-grey-50 dark:bg-white/5 p-3 text-xs font-semibold text-grey-500 dark:text-white/50 border-b border-grey-100 dark:border-white/10">Request Log Trace</div>
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
