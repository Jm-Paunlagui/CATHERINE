/**
 * CORSSetup.view.jsx — How to configure cross-origin access for CATHERINE.
 *
 * CATHERINE binds to all interfaces by default — backend HOST=0.0.0.0 and Vite
 * server.host=true — so you reach it at your machine's LAN IP, not localhost.
 * This page documents that, plus the real CorsMiddleware behaviour
 * (CORS_ORIGINS allow-list + dynamic patterns, dev vs production, CWE-942).
 *
 * Accessible at /about/cors-setup (public). Renders inside the app shell with a
 * right-hand "On this page" rail (shared DocShell). Verified against
 * src/middleware/security/CorsMiddleware.js, vite.config.js, and .env.example.
 */

import { faCircleCheck, faGlobe, faNetworkWired, faServer, faShieldHalved, faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ANIMATE_ENTER_UP, ANIMATE_FADE_IN_UP, ANIM_DELAY_0, BASE_COLOR_BG, BASE_COLOR_TEXT, GRADIENT_COLOR_TEXT, HOVER_LIFT, STANDARD_BORDER, TITLE_COLOR_TEXT, TRANSITION_SPRING, staggerDelay } from "../../../assets/styles/pre-set-styles";
import { Callout, CodeBlock, DefRow, DocShell, WhereToGoNext } from "../../../components/shared/DocsPage";
import { ErrorBoundary } from "../../../components/feedback/ErrorBoundary";
import { Badge } from "../../../components/ui/Badge";

// ── Section registry — drives the "On this page" rail + scroll spy ────────────
const SECTIONS = [
    { id: "overview", label: "Overview" },
    { id: "lan-ip", label: "Use Your LAN IP" },
    { id: "find-ip", label: "Find Your IP" },
    { id: "configure", label: "Configure CORS" },
    { id: "how-it-works", label: "How CORS Resolves" },
    { id: "allowed", label: "Methods & Headers" },
    { id: "production", label: "Production Hardening" },
    { id: "troubleshooting", label: "Troubleshooting" },
    { id: "next", label: "Where to Go Next" },
];

// ── Step / point card ─────────────────────────────────────────────────────────
function PointCard({ icon, title, children, color }) {
    return (
        <div className={`p-5 rounded-2xl ${BASE_COLOR_BG} ${STANDARD_BORDER} ${TRANSITION_SPRING} ${HOVER_LIFT}`}>
            <div className={`w-10 h-10 rounded-xl ${color} flex items-center justify-center mb-3`}>
                <FontAwesomeIcon icon={icon} className="text-(--accent-icon)" />
            </div>
            <h3 className={`font-bold text-sm ${TITLE_COLOR_TEXT}`}>{title}</h3>
            <p className={`text-xs mt-1.5 ${BASE_COLOR_TEXT} opacity-70 leading-relaxed`}>{children}</p>
        </div>
    );
}

// ── Main content ──────────────────────────────────────────────────────────────
function CORSSetupContent() {
    return (
        <DocShell sections={SECTIONS}>
            {/* ── Hero ──────────────────────────────────────────────────────────── */}
            <header id="overview" className={`mb-12 scroll-mt-24 ${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_0}`}>
                <p className="text-xs font-bold uppercase tracking-widest text-orange-400 mb-2">Getting Started</p>
                <h1 className={`text-4xl sm:text-5xl font-extrabold tracking-tight ${TITLE_COLOR_TEXT}`}>
                    <span className={GRADIENT_COLOR_TEXT}>CORS</span> Setup
                </h1>
                <p className={`mt-4 text-lg leading-relaxed ${BASE_COLOR_TEXT} opacity-80 max-w-2xl`}>
                    CATHERINE binds to <strong>all network interfaces</strong> by default — so you reach it at your machine's <strong>LAN IP</strong>, not <code className="font-mono text-base text-orange-400 bg-orange-400/10 px-1.5 py-0.5 rounded">localhost</code>. This page shows how to wire the frontend, the API base URL, and the backend's <code className="font-mono text-base">CORS_ORIGINS</code> so the browser is allowed to talk to the API.
                </p>
                <div className="flex flex-wrap gap-2 mt-5">
                    <Badge variant="cyan" size="sm">
                        HOST=0.0.0.0
                    </Badge>
                    <Badge variant="blue" size="sm">
                        Vite host: true
                    </Badge>
                    <Badge variant="green" size="sm">
                        Credentialed CORS
                    </Badge>
                    <Badge variant="amber" size="sm">
                        CWE-942 guarded
                    </Badge>
                </div>
            </header>

            {/* ── Use your LAN IP ───────────────────────────────────────────────── */}
            <section id="lan-ip" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Use Your LAN IP, Not localhost</h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>
                    Both servers bind to <code className="font-mono text-xs">0.0.0.0</code> (every interface), so the app is reachable from other devices on your network at your machine's IP — e.g. frontend <code className="font-mono text-xs text-orange-400 bg-orange-400/10 px-1.5 py-0.5 rounded">http://192.168.0.193:5173</code>, API <code className="font-mono text-xs text-orange-400 bg-orange-400/10 px-1.5 py-0.5 rounded">http://192.168.0.193:2108</code>. <code className="font-mono text-xs">localhost</code> only works on the host machine itself.
                </p>

                <div className="grid gap-4 sm:grid-cols-2 mb-6">
                    {[
                        { icon: faServer, title: "Backend — HOST=0.0.0.0", color: "bg-cyan-400/10 dark:bg-cyan-400/15", body: "Express listens on every interface (Backend/.env). Reachable at http://<your-lan-ip>:2108." },
                        { icon: faGlobe, title: "Frontend — Vite host: true", color: "bg-blue-400/10 dark:bg-blue-400/15", body: "Vite binds 0.0.0.0 and prints a Network URL. Reachable at http://<your-lan-ip>:5173." },
                    ].map((p, i) => (
                        <div key={p.title} className={`${ANIMATE_ENTER_UP} ${staggerDelay(i)}`}>
                            <PointCard icon={p.icon} title={p.title} color={p.color}>
                                {p.body}
                            </PointCard>
                        </div>
                    ))}
                </div>

                <CodeBlock title="Backend/.env">{`HOST=0.0.0.0   # bind all interfaces — reachable at your LAN IP
PORT=2108`}</CodeBlock>
                <div className="h-3" />
                <CodeBlock title="Frontend/vite.config.js" language="js">{`server: {
  host: true,   // bind 0.0.0.0 — expose the dev server on your LAN
  port: 5173,
},`}</CodeBlock>
            </section>

            {/* ── Find your IP ──────────────────────────────────────────────────── */}
            <section id="find-ip" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Find Your Machine's IP</h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>
                    Easiest: start the frontend — Vite prints the <strong>Network</strong> URL. Or look it up directly.
                </p>
                <CodeBlock title="npm run dev — Vite output">{`  VITE v7  ready

  ➜  Local:   http://localhost:5173/
  ➜  Network: http://192.168.0.193:5173/   ←  your LAN IP`}</CodeBlock>
                <div className="h-3" />
                <CodeBlock title="Look it up directly">{`# Windows — read the "IPv4 Address" line
ipconfig

# Linux / macOS
ip addr | grep "inet "`}</CodeBlock>
                <Callout tone="blue" icon={faNetworkWired} title="Your IP may change">
                    A DHCP-assigned LAN IP can change on reconnect. For a stable address, set a static IP or a DHCP reservation on your router, then use that everywhere below.
                </Callout>
            </section>

            {/* ── Configure CORS ────────────────────────────────────────────────── */}
            <section id="configure" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Configure CORS for Your IP</h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>
                    Two settings must point at your LAN IP. Replace <code className="font-mono text-xs">192.168.0.193</code> with <strong>your</strong> IP from the step above.
                </p>

                <h3 className={`text-lg font-bold mb-3 ${TITLE_COLOR_TEXT}`}>1 — Point the frontend at the API IP</h3>
                <CodeBlock title="Frontend/.env">{`VITE_API_BASE_URL=http://192.168.0.193:2108/api/v1/`}</CodeBlock>

                <h3 className={`text-lg font-bold mb-3 mt-8 ${TITLE_COLOR_TEXT}`}>2 — Allow the frontend origin on the backend</h3>
                <p className={`mb-4 text-sm ${BASE_COLOR_TEXT} opacity-75`}>
                    <code className="font-mono text-xs">CORS_ORIGINS</code> is a comma-separated allow-list of <strong>browser origins</strong> (scheme + host + port, no path). Add the IP origin you actually load the app from.
                </p>
                <CodeBlock title="Backend/.env">{`CORS_ORIGINS=http://192.168.0.193:5173,http://localhost:5173`}</CodeBlock>

                <Callout tone="warn" icon={faTriangleExclamation} title="Restart after editing .env">
                    Env vars are read at startup. Restart the backend (and the Vite dev server for <code className="font-mono text-xs">VITE_*</code> changes) after editing.
                </Callout>
            </section>

            {/* ── How CORS resolves ─────────────────────────────────────────────── */}
            <section id="how-it-works" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>How an Origin Is Resolved</h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>
                    <code className="font-mono text-xs">CorsMiddleware</code> checks each request's <code className="font-mono text-xs">Origin</code> header in order:
                </p>
                <ol className={`space-y-2 mb-6 text-sm ${BASE_COLOR_TEXT} opacity-85 list-decimal pl-5`}>
                    <li>No <code className="font-mono text-xs">Origin</code> header (same-origin requests, curl, server-to-server) → <strong>allowed</strong>.</li>
                    <li>Origin is listed in <code className="font-mono text-xs">CORS_ORIGINS</code> → <strong>allowed</strong>.</li>
                    <li>Origin matches a dynamic pattern (below) → <strong>allowed</strong>.</li>
                    <li>Otherwise → <strong>blocked</strong> and logged (<code className="font-mono text-xs">CORS: origin blocked — …</code>).</li>
                </ol>

                <h3 className={`text-lg font-bold mb-3 ${TITLE_COLOR_TEXT}`}>Dynamic patterns</h3>
                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <tbody>
                            <DefRow name="localhost · 127.0.0.1" value="Loopback — always allowed (any port), in every environment." />
                            <DefRow name="192.168.x.x · 10.x.x.x · 172.16–31.x.x" value="Private (RFC-1918) ranges — allowed in development, or when CORS_ALLOW_BROAD_PATTERNS=true. This is why your LAN IP works automatically in dev." />
                            <DefRow name="*.local · *.lan · *.corp · *.vpn · *.internal" value="Intranet TLDs — same rule: development or explicit opt-in only." />
                        </tbody>
                    </table>
                </div>
                <Callout tone="success" icon={faCircleCheck} title="In development, your LAN IP just works">
                    With <code className="font-mono text-xs">NODE_ENV=development</code>, the <code className="font-mono text-xs">192.168.x.x</code> pattern already allows <code className="font-mono text-xs">http://192.168.0.193:5173</code> without touching <code className="font-mono text-xs">CORS_ORIGINS</code>. You still add it explicitly for production (next section).
                </Callout>
            </section>

            {/* ── Methods & headers ─────────────────────────────────────────────── */}
            <section id="allowed" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Allowed Methods &amp; Headers</h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>The defaults baked into <code className="font-mono text-xs">CorsMiddleware</code> (override per-instance via constructor options):</p>
                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <tbody>
                            <DefRow name="credentials" value="true — cookies and the Authorization header are allowed (required for the HTTP-only JWT cookie)." />
                            <DefRow name="methods" value="GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD" />
                            <DefRow name="allowedHeaders" value="Content-Type, Authorization, X-CSRF-Token, X-Request-ID, X-Requested-With, X-Client-Username, X-Client-Id, Accept, Accept-Encoding, Accept-Language, Cache-Control" />
                            <DefRow name="exposedHeaders" value="X-Request-ID, X-Response-Time, X-CSRF-Token, Content-Disposition, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset" />
                            <DefRow name="maxAge" value="86400s — browsers cache the preflight (OPTIONS) result for 24h." />
                            <DefRow name="optionsSuccessStatus" value="200 — preflight responses return 200." />
                        </tbody>
                    </table>
                </div>
            </section>

            {/* ── Production hardening ───────────────────────────────────────────── */}
            <section id="production" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Production Hardening</h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>
                    In production the broad private-network patterns are a risk (<strong>CWE-942: Permissive Cross-domain Policy</strong>) — an attacker on the same network segment could otherwise be trusted. So:
                </p>
                <ul className={`space-y-2 mb-6 text-sm ${BASE_COLOR_TEXT} opacity-85`}>
                    {[
                        ["NODE_ENV=production disables broad patterns", "Only CORS_ORIGINS (explicit) + loopback are honoured. Every real frontend origin must be listed."],
                        ["List exact origins", "Add each scheme+host+port you serve the UI from, e.g. https://app.example.com or http://192.168.0.193:5173."],
                        ["CORS_ALLOW_BROAD_PATTERNS=true re-enables broad patterns", "Opt-in escape hatch for trusted intranets only — never for internet-facing deployments."],
                    ].map(([k, v]) => (
                        <li key={k} className="flex gap-2.5">
                            <FontAwesomeIcon icon={faShieldHalved} className="text-(--accent-icon) mt-1 w-3.5 h-3.5 shrink-0" />
                            <span>
                                <strong className={TITLE_COLOR_TEXT}>{k}</strong> — {v}
                            </span>
                        </li>
                    ))}
                </ul>
                <CodeBlock title="Backend/.env (production)">{`NODE_ENV=production
CORS_ORIGINS=https://app.example.com
CORS_ALLOW_BROAD_PATTERNS=false   # keep false for internet-facing deployments`}</CodeBlock>
                <Callout tone="danger" icon={faTriangleExclamation} title="Never use a wildcard with credentials">
                    Because <code className="font-mono text-xs">credentials: true</code>, the API echoes the specific allowed origin — it must never be <code className="font-mono text-xs">*</code>. Always allow-list exact origins in production.
                </Callout>
            </section>

            {/* ── Troubleshooting ───────────────────────────────────────────────── */}
            <section id="troubleshooting" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-6 ${TITLE_COLOR_TEXT}`}>Troubleshooting</h2>
                <div className="space-y-3">
                    {[
                        ["Browser console: \"Origin … not allowed by CORS\"", "The exact origin (scheme + host + port) isn't allowed. Add it to CORS_ORIGINS, or confirm you're on a private-network IP in development."],
                        ["UI loads but every API call fails", "VITE_API_BASE_URL points at the wrong host/port. It must be http://<your-lan-ip>:2108/api/v1/ (with the trailing slash)."],
                        ["Works on localhost, fails from another device", "You opened the UI at the LAN IP but CORS_ORIGINS only lists localhost. Add the http://<your-lan-ip>:5173 origin."],
                        ["Changed .env but nothing changed", "Restart the backend (and the Vite dev server for VITE_* changes) — env is read at startup."],
                        ["Login succeeds but session/cookie missing", "Credentialed CORS needs an exact origin (not *). CATHERINE sets credentials: true and echoes the matched origin — make sure the origin is allow-listed, not pattern-skipped in production."],
                    ].map(([symptom, fix]) => (
                        <div key={symptom} className={`p-4 rounded-xl ${BASE_COLOR_BG} ${STANDARD_BORDER}`}>
                            <p className={`text-sm font-semibold ${TITLE_COLOR_TEXT}`}>{symptom}</p>
                            <p className={`text-sm mt-1 ${BASE_COLOR_TEXT} opacity-75`}>{fix}</p>
                        </div>
                    ))}
                </div>
            </section>

            {/* ── Where to go next ──────────────────────────────────────────────── */}
            <section id="next" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-6 ${TITLE_COLOR_TEXT}`}>Where to Go Next</h2>
                <WhereToGoNext
                    items={[
                        { label: "Getting Started", to: "/about/getting-started", desc: "Full setup — prerequisites, secrets, and running the app." },
                        { label: "Database Connection", to: "/about/database-connection", desc: "Connection registry, pools, and the built-in ORM." },
                        { code: "Backend/.env.example", desc: "The CORS section — CORS_ORIGINS and CORS_ALLOW_BROAD_PATTERNS." },
                        { code: "Backend/src/middleware/security/CorsMiddleware.js", desc: "The network-aware CORS implementation." },
                    ]}
                />
            </section>

            {/* ── Footer ────────────────────────────────────────────────────────── */}
            <footer className="pt-8 border-t border-grey-200/30 dark:border-grey-700/30 text-center">
                <p className={`text-sm ${BASE_COLOR_TEXT} opacity-50`}>CATHERINE Template · Network-aware CORS · CWE-942 hardened</p>
            </footer>
        </DocShell>
    );
}

export default function CORSSetup() {
    return (
        <ErrorBoundary>
            <CORSSetupContent />
        </ErrorBoundary>
    );
}
