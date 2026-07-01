/**
 * LiveDemoPanel.jsx — Interactive live security demo.
 *
 * Fires real HTTP requests against the running backend and displays the
 * actual response — status code, headers, body, and response time.
 * No fabricated data — everything shown is the real middleware response.
 *
 * Receives all state via props from the parent (SecurityDemoSection),
 * which owns the useSecurityDemo hook.
 */

import { faCircleCheck, faPlay, faShieldHalved } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useMemo, useState } from "react";
import { ANIMATE_FADE_IN_UP, BASE_COLOR_BG, BASE_COLOR_TEXT, STANDARD_BORDER, TITLE_COLOR_TEXT, TRANSITION_SMOOTH } from "../../../assets/styles/pre-set-styles";
import { Badge } from "../../../components/ui/Badge";
import Button from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";

/** Category badge colour map */
const CAT_COLORS = {
    Baseline: "green",
    Headers: "blue",
    Injection: "red",
    XSS: "red",
    Traversal: "warning",
    Scanner: "amber",
    Method: "purple",
    Auth: "orange",
    CSRF: "cyan",
    Payload: "warning",
    RCE: "red",
};

// ── Scenario selector pill ────────────────────────────────────────────────────

function ScenarioPill({ scenario, isActive, onClick }) {
    return (
        <button
            onClick={onClick}
            className={`px-3 py-1.5 rounded-lg text-xs font-aumovio-bold whitespace-nowrap
                border ${TRANSITION_SMOOTH}
                ${
                    isActive
                        ? "bg-orange-400 text-white border-orange-400 shadow-md shadow-orange-400/25"
                        : `${BASE_COLOR_BG} ${STANDARD_BORDER} text-grey-500 dark:text-grey-400
                           hover:border-orange-400/30 hover:text-orange-400`
                }`}
        >
            {scenario.label}
        </button>
    );
}

// ── Grouped scenario selector ─────────────────────────────────────────────────

function ScenarioSelector({ scenarios, activeId, setActiveId }) {
    // Group scenarios by category — O(n), stable order
    const groups = useMemo(() => {
        const map = new Map();
        for (const s of scenarios) {
            if (!map.has(s.category)) map.set(s.category, []);
            map.get(s.category).push(s);
        }
        return [...map.entries()]; // [[category, scenarios[]], ...]
    }, [scenarios]);

    return (
        <div className="space-y-3 mb-6">
            {groups.map(([category, items]) => (
                <div key={category}>
                    <div className="flex items-center gap-2 mb-1.5">
                        <Badge variant={CAT_COLORS[category] ?? "grey"} size="xs">
                            {category}
                        </Badge>
                        <span className="text-[10px] text-grey-400">
                            {items.length} test{items.length > 1 ? "s" : ""}
                        </span>
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                        {items.map((s) => (
                            <ScenarioPill key={s.id} scenario={s} isActive={s.id === activeId} onClick={() => setActiveId(s.id)} />
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}

// ── Request preview ───────────────────────────────────────────────────────────

function RequestPreview({ scenario }) {
    const METHOD_COLORS = {
        GET: "text-success-400",
        POST: "text-blue-400",
        PUT: "text-warn-400",
        DELETE: "text-danger-400",
        TRACE: "text-danger-400",
        TRACK: "text-danger-400",
        PROPFIND: "text-danger-400",
        SEARCH: "text-warn-400",
    };

    const hasHeaders = scenario.headers && Object.keys(scenario.headers).length > 0;
    const hasBody = scenario.body !== undefined && scenario.body !== null;
    const bodyPreview = hasBody ? (typeof scenario.body === "string" && scenario.body.length > 200 ? `"${scenario.body.slice(0, 80)}..." (${(scenario.body.length / 1024 / 1024).toFixed(1)} MB)` : JSON.stringify(scenario.body, null, 2)) : null;

    return (
        <div className="rounded-xl overflow-hidden border border-grey-700/50 bg-[#0d1117] shadow-lg">
            <div className="flex items-center justify-between px-4 py-2 bg-[#161b22] border-b border-grey-700/40">
                <span className="text-xs text-grey-400 font-mono">Request Preview</span>
                {scenario.cwe && <span className="text-[10px] font-mono text-purple-400 bg-purple-400/10 px-2 py-0.5 rounded-md border border-purple-400/20">{scenario.cwe}</span>}
            </div>

            <div className="p-4 font-mono text-sm leading-relaxed space-y-1">
                <div>
                    <span className={`font-bold ${METHOD_COLORS[scenario.method] ?? "text-grey-300"}`}>{scenario.method}</span>
                    <span className="text-grey-400 ml-2 break-all">{scenario.path}</span>
                </div>

                {hasHeaders &&
                    Object.entries(scenario.headers).map(([k, v]) => (
                        <div key={k} className="text-xs">
                            <span className="text-purple-400">{k}</span>
                            <span className="text-grey-500">: </span>
                            <span className="text-grey-300 break-all">{v.length > 60 ? `${v.slice(0, 60)}…` : v}</span>
                        </div>
                    ))}

                {bodyPreview && (
                    <div className="text-xs mt-2 pt-2 border-t border-grey-700/30">
                        <span className="text-grey-500">Body: </span>
                        <span className="text-warn-400 break-all">{bodyPreview}</span>
                    </div>
                )}
            </div>
        </div>
    );
}

// ── Response display ──────────────────────────────────────────────────────────

function ResponseDisplay({ result, scenario }) {
    const isBlocked = result.blocked;
    const isExpected = (scenario.expect === "block" && isBlocked) || (scenario.expect === "pass" && !isBlocked);

    return (
        <div className={`${ANIMATE_FADE_IN_UP} space-y-4`}>
            {/* Verdict banner */}
            <div className={`flex items-center gap-3 p-4 rounded-xl border ${isBlocked ? "bg-danger-400/5 dark:bg-danger-400/8 border-danger-400/20" : "bg-success-400/5 dark:bg-success-400/8 border-success-400/20"}`}>
                <FontAwesomeIcon icon={isBlocked ? faShieldHalved : faCircleCheck} className={`w-5 h-5 ${isBlocked ? "text-danger-400" : "text-success-400"}`} />

                <div className="flex-1">
                    <p className={`text-sm font-aumovio-bold ${isBlocked ? "text-danger-400" : "text-success-400"}`}>{isBlocked ? "🛡️ Request Blocked by Middleware" : "✅ Request Passed Through"}</p>
                    <p className="text-xs text-grey-500 dark:text-grey-400 mt-0.5">{isExpected ? "This is the expected behavior." : "⚠️ Unexpected result — check backend configuration."}</p>
                </div>

                <div className="text-right shrink-0">
                    <Badge variant={isBlocked ? "red" : "green"} size="sm">
                        {result.status} {result.statusText}
                    </Badge>
                    <p className="text-[10px] text-grey-400 mt-1">{result.responseTime}ms</p>
                </div>
            </div>

            {/* Response headers */}
            <div className="rounded-xl overflow-hidden border border-grey-700/50 bg-[#0d1117] shadow-lg">
                <div className="px-4 py-2 bg-[#161b22] border-b border-grey-700/40">
                    <span className="text-xs text-grey-400 font-mono">Response Headers</span>
                </div>

                <div className="p-4 font-mono text-xs leading-loose text-grey-300 overflow-x-auto">
                    {Object.entries(result.headers)
                        .filter(([, v]) => v)
                        .map(([key, value]) => (
                            <div key={key}>
                                <span className="text-purple-400">{key}</span>
                                <span className="text-grey-500">: </span>
                                <span className="text-grey-200">{value}</span>
                            </div>
                        ))}
                </div>
            </div>

            {/* Response body */}
            <div className="rounded-xl overflow-hidden border border-grey-700/50 bg-[#0d1117] shadow-lg">
                <div className="flex items-center justify-between px-4 py-2 bg-[#161b22] border-b border-grey-700/40">
                    <span className="text-xs text-grey-400 font-mono">Response Body</span>
                    <Badge variant={isBlocked ? "red" : "green"} size="xs">
                        {isBlocked ? "BLOCKED" : "PASSED"}
                    </Badge>
                </div>

                <pre className="p-4 overflow-x-auto text-sm leading-relaxed font-mono">
                    <code className="text-grey-200">{JSON.stringify(result.body, null, 2)}</code>
                </pre>
            </div>
        </div>
    );
}

// ── Main panel ────────────────────────────────────────────────────────────────

/**
 * @param {object}   props
 * @param {object[]} props.scenarios       All demo scenarios.
 * @param {string}   props.activeId        Currently selected scenario id.
 * @param {Function} props.setActiveId     Setter for active scenario.
 * @param {object}   props.activeScenario  The full active scenario object.
 * @param {object|null} props.result       Probe result (null if not yet run).
 * @param {boolean}  props.loading         Whether a probe is in flight.
 * @param {Function} props.runProbe        Fires the active scenario probe.
 */
export default function LiveDemoPanel({ scenarios, activeId, setActiveId, activeScenario, result, loading, runProbe }) {
    const [shakeKey, setShakeKey] = useState(0);

    const handleRun = async () => {
        await runProbe();
        if (activeScenario.expect === "block") {
            setShakeKey((k) => k + 1);
        }
    };

    return (
        <Card variant="default" padding="lg" className={`mt-10 ${ANIMATE_FADE_IN_UP}`}>
            {/* Header */}
            <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-lg bg-purple-400/10 dark:bg-purple-400/15 border border-purple-400/20 flex items-center justify-center">
                    <FontAwesomeIcon icon={faShieldHalved} className="w-4 h-4 text-purple-400" />
                </div>

                <div>
                    <h3 className={`text-base font-aumovio-bold ${TITLE_COLOR_TEXT}`}>Live Security Demo</h3>
                    <p className="text-xs text-grey-500 dark:text-grey-400">Fire real requests against the running backend — see actual middleware responses.</p>
                </div>

                <Badge variant="purple" size="xs" dot pill className="ml-auto">
                    Live
                </Badge>
            </div>

            {/* Scenario selector — grouped by category */}
            <ScenarioSelector scenarios={scenarios} activeId={activeId} setActiveId={setActiveId} />

            {/* Active scenario description */}
            <div className={`p-4 rounded-xl mb-6 ${BASE_COLOR_BG} ${STANDARD_BORDER}`}>
                <div className="flex items-center gap-2 mb-2">
                    <span className={`text-sm font-aumovio-bold ${TITLE_COLOR_TEXT}`}>{activeScenario.label}</span>
                    <Badge variant="grey" size="xs">
                        {activeScenario.category}
                    </Badge>
                    {activeScenario.cwe && (
                        <Badge variant="purple" size="xs">
                            {activeScenario.cwe}
                        </Badge>
                    )}
                </div>
                <p className={`text-xs ${BASE_COLOR_TEXT} opacity-80`}>{activeScenario.description}</p>
            </div>

            {/* Request preview */}
            <RequestPreview scenario={activeScenario} />

            {/* Fire button */}
            <div className="flex items-center gap-4 mt-6">
                <Button variant={activeScenario.expect === "block" ? "danger" : "primary"} size="md" loading={loading} onClick={handleRun}>
                    {!loading && <FontAwesomeIcon icon={faPlay} className="w-3 h-3" />}
                    {loading ? "Sending…" : "Fire Request"}
                </Button>

                <p className="text-xs text-grey-400">{activeScenario.expect === "block" ? "⚠️ This request will be blocked by the middleware." : "✅ This request should pass through normally."}</p>
            </div>

            {/* Response */}
            {result && (
                <div className="mt-6" key={shakeKey}>
                    <ResponseDisplay result={result} scenario={activeScenario} />
                </div>
            )}
        </Card>
    );
}
