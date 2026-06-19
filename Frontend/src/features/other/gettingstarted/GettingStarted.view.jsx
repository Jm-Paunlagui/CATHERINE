/**
 * GettingStarted.view.jsx — Developer-friendly onboarding page.
 *
 * Styled like the Tailwind CSS docs: left sidebar table-of-contents,
 * numbered step cards with code blocks (copy-to-clipboard), and a clean
 * documentation layout using the Aumovio design system.
 *
 * Accessible at /about/getting-started (public — no auth required so new
 * developers can read it before setting up the database).
 */

import { faArrowRight, faChartBar, faCircleCheck, faShieldHalved, faUserShield } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ANIMATE_ENTER_UP, ANIMATE_FADE_IN_UP, ANIM_DELAY_0, ANIM_DELAY_100, BASE_COLOR_BG, BASE_COLOR_TEXT, GRADIENT_COLOR_TEXT, HOVER_LIFT, STANDARD_BORDER, TITLE_COLOR_TEXT, TRANSITION_SPRING, staggerDelay } from "../../../assets/styles/pre-set-styles";
import { ErrorBoundary } from "../../../components/feedback/ErrorBoundary";
import { CodeBlock, DocShell, WhereToGoNext } from "../../../components/shared/DocsPage";
import { Badge } from "../../../components/ui/Badge";
import { Tabs } from "../../../components/ui/Tabs";

// ── Section registry — drives the "On this page" rail + scroll spy ────────────
const SECTIONS = [
    { id: "overview", label: "Overview" },
    { id: "prerequisites", label: "Prerequisites" },
    { id: "quick-start", label: "Quick Start (Demo)" },
    { id: "backend-setup", label: "Backend Setup" },
    { id: "secrets", label: "Generate Secrets" },
    { id: "database", label: "Database Setup" },
    { id: "frontend-setup", label: "Frontend Setup" },
    { id: "running", label: "Running the App" },
    { id: "demo-accounts", label: "Demo Accounts" },
    { id: "features", label: "Features to Explore" },
    { id: "troubleshooting", label: "Troubleshooting" },
];

// ── Numbered step card ────────────────────────────────────────────────────────
function StepCard({ number, title, children, className = "" }) {
    return (
        <div className={`flex gap-4 ${className}`}>
            <div className="shrink-0 flex flex-col items-center">
                <div className="w-8 h-8 rounded-full bg-orange-400 text-white flex items-center justify-center text-sm font-bold shadow-md shadow-orange-400/25">{number}</div>
                <div className="flex-1 w-px bg-grey-300/30 dark:bg-grey-600/30 mt-2" />
            </div>
            <div className="pb-8 min-w-0 flex-1">
                <h3 className={`text-lg font-bold mb-3 ${TITLE_COLOR_TEXT}`}>{title}</h3>
                <div className="space-y-4">{children}</div>
            </div>
        </div>
    );
}

// ── Prerequisite row ──────────────────────────────────────────────────────────
function PrereqRow({ name, version, note, required = true }) {
    return (
        <div className={`flex items-start gap-3 p-3 rounded-lg ${BASE_COLOR_BG} ${STANDARD_BORDER}`}>
            <FontAwesomeIcon icon={faCircleCheck} className={`mt-0.5 ${required ? "text-success-400" : "text-grey-400"}`} />
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                    <span className={`font-semibold text-sm ${TITLE_COLOR_TEXT}`}>{name}</span>
                    {version && (
                        <Badge variant="blue" size="xs">
                            {version}
                        </Badge>
                    )}
                    {!required && (
                        <Badge variant="grey" size="xs">
                            Optional
                        </Badge>
                    )}
                </div>
                {note && <p className={`text-xs mt-0.5 ${BASE_COLOR_TEXT} opacity-70`}>{note}</p>}
            </div>
        </div>
    );
}

// ── Env var table row ─────────────────────────────────────────────────────────
function EnvRow({ name, purpose }) {
    return (
        <tr className="border-b border-grey-200/30 dark:border-grey-700/30">
            <td className="py-2.5 pr-4">
                <code className="text-xs font-mono px-1.5 py-0.5 rounded bg-orange-400/10 text-orange-400 dark:text-orange-300">{name}</code>
            </td>
            <td className={`py-2.5 text-sm ${BASE_COLOR_TEXT} opacity-80`}>{purpose}</td>
        </tr>
    );
}

// ── Troubleshooting row ───────────────────────────────────────────────────────
function TroubleRow({ symptom, fix }) {
    return (
        <div className={`p-4 rounded-xl ${BASE_COLOR_BG} ${STANDARD_BORDER}`}>
            <p className={`text-sm font-semibold ${TITLE_COLOR_TEXT}`}>{symptom}</p>
            <p className={`text-sm mt-1 ${BASE_COLOR_TEXT} opacity-75`}>{fix}</p>
        </div>
    );
}

// ── Main content ──────────────────────────────────────────────────────────────
function GettingStartedContent() {
    return (
        <DocShell sections={SECTIONS}>
                    {/* ── Hero ──────────────────────────────────────────────────── */}
                    <header id="overview" className={`mb-12 scroll-mt-24 ${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_0}`}>
                        <p className="text-xs font-bold uppercase tracking-widest text-orange-400 mb-2">Getting Started</p>
                        <h1 className={`text-4xl sm:text-5xl font-extrabold tracking-tight ${TITLE_COLOR_TEXT}`}>
                            Set up the <span className={GRADIENT_COLOR_TEXT}>CATHERINE</span> Template
                        </h1>
                        <p className={`mt-4 text-lg leading-relaxed ${BASE_COLOR_TEXT} opacity-80 max-w-2xl`}>
                            A production-grade full-stack starter with <strong>React 19 + Vite + Tailwind v4</strong> on the frontend and <strong>Node.js + Express 5 + OracleDB</strong> on the backend — complete with JWT auth, RBAC, audit logging, an observability dashboard, admin management, and version history.
                        </p>
                        <div className="flex flex-wrap gap-2 mt-5">
                            <Badge variant="orange" size="sm">
                                Express 5
                            </Badge>
                            <Badge variant="blue" size="sm">
                                React 19
                            </Badge>
                            <Badge variant="purple" size="sm">
                                Tailwind v4
                            </Badge>
                            <Badge variant="green" size="sm">
                                Argon2id
                            </Badge>
                            <Badge variant="cyan" size="sm">
                                OracleDB
                            </Badge>
                            <Badge variant="amber" size="sm">
                                JWT + RBAC
                            </Badge>
                        </div>
                    </header>

                    {/* ── Prerequisites ─────────────────────────────────────────── */}
                    <section id="prerequisites" className={`mb-14 scroll-mt-24 ${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_100}`}>
                        <h2 className={`text-2xl font-extrabold mb-6 ${TITLE_COLOR_TEXT}`}>Prerequisites</h2>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <PrereqRow name="Node.js" version="18+" note="LTS recommended. The backend builds a node18 pkg target." />
                            <PrereqRow name="npm" version="Ships with Node" note="Package manager for both frontend and backend." />
                            <PrereqRow name="Oracle Database" version="12c+" note="Oracle XE 21c is ideal for local dev. Not needed in Demo Mode." />
                            <PrereqRow name="Oracle Instant Client" version="23.x" note="Required for node-oracledb Thick mode. Not needed in Demo Mode." required={false} />
                            <PrereqRow name="Git" version="Any" note="To clone the repository." />
                            <PrereqRow name="SQL Client" version="Any" note="SQL Developer or SQLcl to run the schema scripts." required={false} />
                        </div>
                    </section>

                    {/* ── Quick Start (Demo Mode) ──────────────────────────────── */}
                    <section id="quick-start" className="mb-14 scroll-mt-24">
                        <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Quick Start — Demo Mode</h2>
                        <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>
                            Want to see the template in action <strong>without setting up a database</strong>? Demo Mode runs the entire app with in-memory fixtures — same auth flow, same audit logs, same UI.
                        </p>

                        <StepCard number={1} title="Clone & install">
                            <CodeBlock title="Terminal">{`git clone https://github.com/Jm-Paunlagui/CATHERINE.git
cd CATHERINE`}</CodeBlock>
                            <CodeBlock title="Terminal — Backend">{`cd Backend
npm install`}</CodeBlock>
                            <CodeBlock title="Terminal — Frontend">{`cd ../Frontend
npm install`}</CodeBlock>
                        </StepCard>

                        <StepCard number={2} title="Create .env files">
                            <p className={`text-sm ${BASE_COLOR_TEXT} opacity-75`}>Copy the example files and generate the required secrets.</p>
                            <CodeBlock title="Terminal — Backend">{`cd Backend
cp .env.example .env`}</CodeBlock>
                            <p className={`text-sm ${BASE_COLOR_TEXT} opacity-75`}>Generate each secret (run this command once per secret):</p>
                            <CodeBlock title="Terminal">{`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`}</CodeBlock>
                            <p className={`text-sm ${BASE_COLOR_TEXT} opacity-75`}>
                                Set these in <code className="text-orange-400 bg-orange-400/10 px-1.5 py-0.5 rounded text-xs font-mono">Backend/.env</code>:
                            </p>
                            <div className="overflow-x-auto">
                                <table className="w-full text-left">
                                    <thead>
                                        <tr className="border-b border-grey-300/30 dark:border-grey-700/30">
                                            <th className={`py-2 pr-4 text-xs font-bold uppercase tracking-wider ${TITLE_COLOR_TEXT}`}>Variable</th>
                                            <th className={`py-2 text-xs font-bold uppercase tracking-wider ${TITLE_COLOR_TEXT}`}>Purpose</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <EnvRow name="JWT_SECRET" purpose="Signs/verifies access + refresh JWTs." />
                                        <EnvRow name="CSRF_SECRET" purpose="Double-submit CSRF token secret." />
                                        <EnvRow name="COOKIE_SECRET" purpose="Signs HTTP-only cookies (≥32 chars)." />
                                        <EnvRow name="ARGON2_PEPPER" purpose="Server-side pepper for password hashes (≥32 chars)." />
                                        <EnvRow name="DATA_SIGNING_SECRET" purpose="HMAC key for tamper-evident admin row signatures." />
                                        <EnvRow name="CHANGELOG_ENCRYPTION_KEY" purpose="AES-256-GCM key for encrypted changelog (64-hex)." />
                                    </tbody>
                                </table>
                            </div>
                        </StepCard>

                        <StepCard number={3} title="Enable Demo Mode">
                            <p className={`text-sm ${BASE_COLOR_TEXT} opacity-75`}>
                                Add this line to <code className="text-orange-400 bg-orange-400/10 px-1.5 py-0.5 rounded text-xs font-mono">Backend/.env</code>:
                            </p>
                            <CodeBlock title="Backend/.env">{`DEMO_MODE=true`}</CodeBlock>
                        </StepCard>

                        <StepCard number={4} title="Start both servers">
                            <Tabs
                                variant="pill"
                                size="sm"
                                tabs={[
                                    {
                                        id: "two-terminals",
                                        label: "Two terminals",
                                        content: (
                                            <div className="space-y-3 mt-4">
                                                <CodeBlock title="Terminal 1 — Backend">{`cd Backend && npm start`}</CodeBlock>
                                                <CodeBlock title="Terminal 2 — Frontend">{`cd Frontend && npm run dev`}</CodeBlock>
                                            </div>
                                        ),
                                    },
                                    {
                                        id: "concurrently",
                                        label: "Concurrently",
                                        content: (
                                            <div className="mt-4">
                                                <CodeBlock title="Terminal (from root)">{`# Install concurrently globally first:
npm i -g concurrently

concurrently "cd Backend && npm start" "cd Frontend && npm run dev"`}</CodeBlock>
                                            </div>
                                        ),
                                    },
                                ]}
                            />
                        </StepCard>

                        <StepCard number={5} title="Open the app">
                            <p className={`text-sm ${BASE_COLOR_TEXT} opacity-75`}>
                                Open <code className="text-orange-400 bg-orange-400/10 px-1.5 py-0.5 rounded text-xs font-mono">http://192.168.0.193:5173</code> — your machine's LAN IP. CATHERINE binds to <code className="font-mono text-xs">0.0.0.0</code>, so use the IP, not localhost (see the <strong>CORS Setup</strong> guide). Log in with the demo credentials below to see the full observability dashboard, admin management, and changelog — all running without a database.
                            </p>
                        </StepCard>
                    </section>

                    {/* ── Backend Setup (Full) ─────────────────────────────────── */}
                    <section id="backend-setup" className="mb-14 scroll-mt-24">
                        <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Backend Setup</h2>
                        <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>For production or when you need a real database, follow these steps instead of Demo Mode.</p>

                        <StepCard number={1} title="Install dependencies">
                            <CodeBlock title="Terminal">{`cd Backend
npm install`}</CodeBlock>
                        </StepCard>

                        <StepCard number={2} title="Create your .env">
                            <CodeBlock title="Terminal">{`cp .env.example .env
# Windows PowerShell:
# Copy-Item .env.example .env`}</CodeBlock>
                        </StepCard>

                        <StepCard number={3} title="Configure the database connection">
                            <p className={`text-sm ${BASE_COLOR_TEXT} opacity-75`}>
                                Set these in <code className="text-orange-400 bg-orange-400/10 px-1.5 py-0.5 rounded text-xs font-mono">Backend/.env</code>:
                            </p>
                            <CodeBlock title="Backend/.env">{`DB_TYPE=oracle
DB_HOST=localhost
DB_PORT=1521
DB_APP_SERVICE_NAME=XEPDB1
ORACLE_INSTANT_CLIENT=C:\\oracle\\instantclient_23_8

APP_DB_USERNAME=your_schema_user
APP_DB_PASSWORD=your_schema_password

PASSWORD_HASH_MODE=argon2
PORT=2108
HOST=0.0.0.0`}</CodeBlock>
                        </StepCard>
                    </section>

                    {/* ── Generate Secrets ──────────────────────────────────────── */}
                    <section id="secrets" className="mb-14 scroll-mt-24">
                        <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Generate Secrets</h2>
                        <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>
                            Several secrets must be <strong>≥ 32 characters</strong> and unique. Generate each with:
                        </p>
                        <CodeBlock title="Terminal">{`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`}</CodeBlock>

                        <div className="mt-6 overflow-x-auto">
                            <table className="w-full text-left">
                                <thead>
                                    <tr className="border-b border-grey-300/30 dark:border-grey-700/30">
                                        <th className={`py-2 pr-4 text-xs font-bold uppercase tracking-wider ${TITLE_COLOR_TEXT}`}>Variable</th>
                                        <th className={`py-2 text-xs font-bold uppercase tracking-wider ${TITLE_COLOR_TEXT}`}>Purpose</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <EnvRow name="JWT_SECRET" purpose="Signs/verifies access + refresh JWTs." />
                                    <EnvRow name="CSRF_SECRET" purpose="Double-submit CSRF token secret." />
                                    <EnvRow name="COOKIE_SECRET" purpose="Signs HTTP-only cookies (≥32 chars)." />
                                    <EnvRow name="ARGON2_PEPPER" purpose="Server-side pepper mixed into every password hash (≥32 chars). Rotating this invalidates all hashes." />
                                    <EnvRow name="DATA_SIGNING_SECRET" purpose="HMAC key for tamper-evident SYSSIGNATURE on admin rows. Rotating invalidates all signatures." />
                                    <EnvRow name="CHANGELOG_ENCRYPTION_KEY" purpose="AES-256-GCM key for the encrypted changelog file (64-hex chars)." />
                                </tbody>
                            </table>
                        </div>

                        <div className={`mt-6 p-4 rounded-xl border border-warn-400/30 bg-warn-400/5`}>
                            <p className={`text-sm font-semibold text-warn-500 dark:text-warn-300`}>⚠ Important</p>
                            <p className={`text-sm mt-1 ${BASE_COLOR_TEXT} opacity-75`}>
                                Rotating <code className="font-mono text-xs">ARGON2_PEPPER</code> invalidates all password hashes. Rotating <code className="font-mono text-xs">DATA_SIGNING_SECRET</code> invalidates all admin row signatures. Treat them like encryption keys.
                            </p>
                        </div>
                    </section>

                    {/* ── Database Setup ────────────────────────────────────────── */}
                    <section id="database" className="mb-14 scroll-mt-24">
                        <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Database Setup</h2>
                        <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>The template ships with a self-contained SQL schema — three tables, no external dependencies. Skip this section if you're using Demo Mode.</p>

                        <h3 className={`text-lg font-bold mb-3 ${TITLE_COLOR_TEXT}`}>Schema at a glance</h3>
                        <div className="grid gap-3 sm:grid-cols-3 mb-8">
                            {[
                                { table: "T_USERS_DEV", desc: "Regular end-user accounts with Argon2id password hashes.", color: "blue" },
                                { table: "T_ADMINS_DEV", desc: "Privileged accounts with RBAC (SUPER_ADMIN / ADMIN / USER) + tamper-evident SYSSIGNATURE.", color: "purple" },
                                { table: "T_AUDIT_LOGS_DEV", desc: "Per-request audit trail powering the Logging & Observability dashboard.", color: "orange" },
                            ].map((t) => (
                                <div key={t.table} className={`p-4 rounded-xl ${BASE_COLOR_BG} ${STANDARD_BORDER}`}>
                                    <Badge variant={t.color} size="xs" className="mb-2">
                                        {t.table}
                                    </Badge>
                                    <p className={`text-xs mt-2 ${BASE_COLOR_TEXT} opacity-70`}>{t.desc}</p>
                                </div>
                            ))}
                        </div>

                        <StepCard number={1} title="Run the schema script">
                            <CodeBlock title="SQL*Plus / SQLcl">{`-- Connect as your app schema owner:
sqlplus APP_USER/APP_PW@//localhost:1521/XEPDB1

-- Run the schema (idempotent — safe to re-run):
@Backend/sql/01_schema.sql`}</CodeBlock>
                        </StepCard>

                        <StepCard number={2} title="Seed sample audit data (optional)">
                            <p className={`text-sm ${BASE_COLOR_TEXT} opacity-75`}>Fills T_AUDIT_LOGS_DEV with ~200 synthetic rows so the observability dashboard renders charts immediately.</p>
                            <CodeBlock title="SQL*Plus / SQLcl">{`@Backend/sql/02_seed_demo.sql`}</CodeBlock>
                        </StepCard>

                        <StepCard number={3} title="Seed demo accounts (Argon2id)">
                            <p className={`text-sm ${BASE_COLOR_TEXT} opacity-75`}>
                                Creates the <code className="font-mono text-xs">admin</code> and <code className="font-mono text-xs">user</code> accounts with Argon2id-hashed passwords and HMAC-signed admin rows. Must run through the app (not raw SQL).
                            </p>
                            <CodeBlock title="Terminal">{`cd Backend
npm run db:seed:template`}</CodeBlock>
                        </StepCard>
                    </section>

                    {/* ── Frontend Setup ────────────────────────────────────────── */}
                    <section id="frontend-setup" className="mb-14 scroll-mt-24">
                        <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Frontend Setup</h2>

                        <StepCard number={1} title="Install & configure">
                            <CodeBlock title="Terminal">{`cd Frontend
npm install
cp .env.example .env`}</CodeBlock>
                        </StepCard>

                        <StepCard number={2} title="Set environment variables">
                            <p className={`text-sm ${BASE_COLOR_TEXT} opacity-75`}>
                                Key variables in <code className="text-orange-400 bg-orange-400/10 px-1.5 py-0.5 rounded text-xs font-mono">Frontend/.env</code>:
                            </p>
                            <div className="overflow-x-auto">
                                <table className="w-full text-left">
                                    <thead>
                                        <tr className="border-b border-grey-300/30 dark:border-grey-700/30">
                                            <th className={`py-2 pr-4 text-xs font-bold uppercase tracking-wider ${TITLE_COLOR_TEXT}`}>Variable</th>
                                            <th className={`py-2 text-xs font-bold uppercase tracking-wider ${TITLE_COLOR_TEXT}`}>Set to</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <EnvRow name="VITE_API_BASE_URL" purpose="Backend API base with trailing slash — use your LAN IP, e.g. http://192.168.0.193:2108/api/v1/" />
                                        <EnvRow name="VITE_APP_NAME" purpose="Display name (default: CATHERINE)." />
                                        <EnvRow name="VITE_SESSION_TIMEOUT_MS" purpose="Match the backend JWT_EXPIRES_IN (e.g. 1800000 = 30 min)." />
                                    </tbody>
                                </table>
                            </div>
                            <div className={`mt-4 p-4 rounded-xl border border-blue-400/30 bg-blue-400/5`}>
                                <p className={`text-sm ${BASE_COLOR_TEXT} opacity-75`}>
                                    💡 The example file ships <code className="font-mono text-xs">http://localhost:3000/api/v1/</code> — change it to your machine's LAN IP and the backend port (default <code className="font-mono text-xs">2108</code>), e.g. <code className="font-mono text-xs">http://192.168.0.193:2108/api/v1/</code>. Also add your frontend origin (e.g. <code className="font-mono text-xs">http://192.168.0.193:5173</code>) to <code className="font-mono text-xs">CORS_ORIGINS</code> in the backend — see the <strong>CORS Setup</strong> guide.
                                </p>
                            </div>
                        </StepCard>
                    </section>

                    {/* ── Running the App ───────────────────────────────────────── */}
                    <section id="running" className="mb-14 scroll-mt-24">
                        <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Running the App</h2>
                        <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>Open two terminals:</p>

                        <CodeBlock title="Terminal 1 — Backend">{`cd Backend && npm start
# HOST=0.0.0.0 → reachable at http://192.168.0.193:2108`}</CodeBlock>
                        <div className="h-4" />
                        <CodeBlock title="Terminal 2 — Frontend">{`cd Frontend && npm run dev
# Vite prints the Network URL → http://192.168.0.193:5173`}</CodeBlock>

                        <p className={`mt-6 text-sm ${BASE_COLOR_TEXT} opacity-75`}>
                            Both servers bind to <code className="font-mono text-xs">0.0.0.0</code>, so use your machine's <strong>LAN IP</strong> (shown in Vite's <em>Network</em> line), not localhost. Health check: open <code className="text-orange-400 bg-orange-400/10 px-1.5 py-0.5 rounded text-xs font-mono">http://192.168.0.193:2108/api/v1/health</code> — it should return <code className="font-mono text-xs">{`{ "status": "success" }`}</code>. See the <strong>CORS Setup</strong> guide for details.
                        </p>
                    </section>

                    {/* ── Demo Accounts ─────────────────────────────────────────── */}
                    <section id="demo-accounts" className="mb-14 scroll-mt-24">
                        <h2 className={`text-2xl font-extrabold mb-6 ${TITLE_COLOR_TEXT}`}>Demo Accounts</h2>
                        <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>
                            Available in Demo Mode (or after running <code className="font-mono text-xs">npm run db:seed:template</code>):
                        </p>

                        <div className="overflow-x-auto rounded-xl border border-grey-200/30 dark:border-grey-700/30">
                            <table className="w-full text-left">
                                <thead className="bg-grey-50 dark:bg-white/5">
                                    <tr>
                                        <th className={`px-4 py-3 text-xs font-bold uppercase tracking-wider ${TITLE_COLOR_TEXT}`}>Username</th>
                                        <th className={`px-4 py-3 text-xs font-bold uppercase tracking-wider ${TITLE_COLOR_TEXT}`}>Password</th>
                                        <th className={`px-4 py-3 text-xs font-bold uppercase tracking-wider ${TITLE_COLOR_TEXT}`}>Role</th>
                                        <th className={`px-4 py-3 text-xs font-bold uppercase tracking-wider ${TITLE_COLOR_TEXT}`}>Access</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr className="border-b border-grey-200/20 dark:border-grey-700/20">
                                        <td className="px-4 py-3">
                                            <code className="font-mono text-sm text-orange-400">admin</code>
                                        </td>
                                        <td className="px-4 py-3">
                                            <code className="font-mono text-sm text-grey-300">Demo@123</code>
                                        </td>
                                        <td className="px-4 py-3">
                                            <Badge variant="purple" size="xs">
                                                SUPER_ADMIN
                                            </Badge>
                                        </td>
                                        <td className={`px-4 py-3 text-sm ${BASE_COLOR_TEXT} opacity-75`}>Everything: observability, admin mgmt, changelog</td>
                                    </tr>
                                    <tr className="border-b border-grey-200/20 dark:border-grey-700/20">
                                        <td className="px-4 py-3">
                                            <code className="font-mono text-sm text-orange-400">manager</code>
                                        </td>
                                        <td className="px-4 py-3">
                                            <code className="font-mono text-sm text-grey-300">Demo@123</code>
                                        </td>
                                        <td className="px-4 py-3">
                                            <Badge variant="blue" size="xs">
                                                ADMIN
                                            </Badge>
                                        </td>
                                        <td className={`px-4 py-3 text-sm ${BASE_COLOR_TEXT} opacity-75`}>Admin management, observability</td>
                                    </tr>
                                    <tr>
                                        <td className="px-4 py-3">
                                            <code className="font-mono text-sm text-orange-400">user</code>
                                        </td>
                                        <td className="px-4 py-3">
                                            <code className="font-mono text-sm text-grey-300">Demo@123</code>
                                        </td>
                                        <td className="px-4 py-3">
                                            <Badge variant="green" size="xs">
                                                USER
                                            </Badge>
                                        </td>
                                        <td className={`px-4 py-3 text-sm ${BASE_COLOR_TEXT} opacity-75`}>Standard user views</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </section>

                    {/* ── Features to Explore ──────────────────────────────────── */}
                    <section id="features" className="mb-14 scroll-mt-24">
                        <h2 className={`text-2xl font-extrabold mb-6 ${TITLE_COLOR_TEXT}`}>Features to Explore</h2>
                        <div className="grid gap-4 sm:grid-cols-2">
                            {[
                                {
                                    icon: faChartBar,
                                    title: "Logging & Observability",
                                    desc: "Golden-signal charts, audit log browser, per-request detail, real-time SSE updates, metrics dashboard, and health probes.",
                                    color: "text-purple-400",
                                    bg: "bg-purple-400/10 dark:bg-purple-400/15",
                                },
                                {
                                    icon: faUserShield,
                                    title: "Admin Management",
                                    desc: "RBAC user/admin CRUD with tamper-evident SYSSIGNATURE, progressive login lockout, and default-password enforcement.",
                                    color: "text-danger-400",
                                    bg: "bg-danger-400/10 dark:bg-danger-400/15",
                                },
                                {
                                    icon: faArrowRight,
                                    title: "Version History",
                                    desc: "Encrypted changelog with release-train controls (draft → promote → cut), semver tagging, and a timeline UI.",
                                    color: "text-blue-400",
                                    bg: "bg-blue-400/10 dark:bg-blue-400/15",
                                },
                                {
                                    icon: faShieldHalved,
                                    title: "Security Stack",
                                    desc: "14-layer middleware: Helmet, CORS, CSRF double-submit, rate limiting, IP filtering, security filter, Argon2id, and HMAC row signing.",
                                    color: "text-(--accent-icon)",
                                    bg: "bg-orange-400/10 dark:bg-orange-400/15",
                                },
                            ].map((f, i) => (
                                <div key={f.title} className={`p-5 rounded-2xl ${BASE_COLOR_BG} ${STANDARD_BORDER} ${TRANSITION_SPRING} ${HOVER_LIFT} ${ANIMATE_ENTER_UP} ${staggerDelay(i)}`}>
                                    <div className={`w-10 h-10 rounded-xl ${f.bg} flex items-center justify-center mb-3`}>
                                        <FontAwesomeIcon icon={f.icon} className={`${f.color}`} />
                                    </div>
                                    <h3 className={`font-bold text-sm ${TITLE_COLOR_TEXT}`}>{f.title}</h3>
                                    <p className={`text-xs mt-1.5 ${BASE_COLOR_TEXT} opacity-70 leading-relaxed`}>{f.desc}</p>
                                </div>
                            ))}
                        </div>
                    </section>

                    {/* ── Useful Commands ───────────────────────────────────────── */}
                    <section className="mb-14 scroll-mt-24">
                        <h2 className={`text-2xl font-extrabold mb-6 ${TITLE_COLOR_TEXT}`}>Useful Commands</h2>
                        <Tabs
                            variant="pill"
                            size="sm"
                            tabs={[
                                {
                                    id: "backend-cmds",
                                    label: "Backend",
                                    content: (
                                        <div className="mt-4 overflow-x-auto">
                                            <table className="w-full text-left">
                                                <thead>
                                                    <tr className="border-b border-grey-300/30 dark:border-grey-700/30">
                                                        <th className={`py-2 pr-4 text-xs font-bold uppercase tracking-wider ${TITLE_COLOR_TEXT}`}>Command</th>
                                                        <th className={`py-2 text-xs font-bold uppercase tracking-wider ${TITLE_COLOR_TEXT}`}>What it does</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    <EnvRow name="npm start" purpose="Start the API (node server.js)." />
                                                    <EnvRow name="npm test" purpose="Run the full test suite." />
                                                    <EnvRow name="npm run test:unit" purpose="Unit tests only." />
                                                    <EnvRow name="npm run db:seed:template" purpose="Seed demo admin + user accounts (Argon2id)." />
                                                    <EnvRow name="npm run build" purpose="Compile a standalone .exe with pkg." />
                                                </tbody>
                                            </table>
                                        </div>
                                    ),
                                },
                                {
                                    id: "frontend-cmds",
                                    label: "Frontend",
                                    content: (
                                        <div className="mt-4 overflow-x-auto">
                                            <table className="w-full text-left">
                                                <thead>
                                                    <tr className="border-b border-grey-300/30 dark:border-grey-700/30">
                                                        <th className={`py-2 pr-4 text-xs font-bold uppercase tracking-wider ${TITLE_COLOR_TEXT}`}>Command</th>
                                                        <th className={`py-2 text-xs font-bold uppercase tracking-wider ${TITLE_COLOR_TEXT}`}>What it does</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    <EnvRow name="npm run dev" purpose="Vite dev server." />
                                                    <EnvRow name="npm run build" purpose="Production build." />
                                                    <EnvRow name="npm run lint" purpose="ESLint." />
                                                    <EnvRow name="npm run preview" purpose="Preview the production build." />
                                                </tbody>
                                            </table>
                                        </div>
                                    ),
                                },
                            ]}
                        />
                    </section>

                    {/* ── Troubleshooting ───────────────────────────────────────── */}
                    <section id="troubleshooting" className="mb-14 scroll-mt-24">
                        <h2 className={`text-2xl font-extrabold mb-6 ${TITLE_COLOR_TEXT}`}>Troubleshooting</h2>
                        <div className="space-y-3">
                            <TroubleRow symptom="DPI-1047 / Oracle Client library not found" fix="Install Oracle Instant Client and set ORACLE_INSTANT_CLIENT to its folder in Backend/.env." />
                            <TroubleRow symptom="[CryptoVault] ARGON2_PEPPER must be ≥ 32 chars" fix={`Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" and set it in Backend/.env.`} />
                            <TroubleRow symptom="Login works but the app can't call the API (CORS)" fix="Add your frontend origin (e.g. http://192.168.0.193:5173) to CORS_ORIGINS in Backend/.env. See the CORS Setup guide." />
                            <TroubleRow symptom="Frontend hits the wrong port" fix="Set VITE_API_BASE_URL in Frontend/.env to your backend port (with trailing slash)." />
                            <TroubleRow symptom="Health check OK but DB calls fail" fix="Check the Oracle service name + credentials in Backend/.env. The pool retries lazily on first request." />
                            <TroubleRow symptom="Observability dashboard is empty" fix="Run Backend/sql/02_seed_demo.sql, or use Demo Mode (DEMO_MODE=true) which pre-populates 200 audit rows." />
                        </div>
                    </section>

                    {/* ── Where to go next ──────────────────────────────────────── */}
                    <section className="mb-14 scroll-mt-24">
                        <h2 className={`text-2xl font-extrabold mb-6 ${TITLE_COLOR_TEXT}`}>Where to Go Next</h2>
                        <WhereToGoNext
                            items={[
                                { label: "Database Connection", to: "/about/database-connection", desc: "Configure .env, the connection registry, and the built-in ORM." },
                                { label: "CORS Setup", to: "/about/cors-setup", desc: "LAN IP access and the CORS_ORIGINS allow-list." },
                                { code: "Backend/sql/README.md", desc: "The sample database in detail." },
                                { code: "Backend/CLAUDE.md", desc: "Backend architecture, conventions, and the testing guide." },
                                { code: "Frontend/CLAUDE.md", desc: "UI component library, design tokens, and feature workflow." },
                                { code: "Backend/src/utils/oracle-mongo-wrapper/README.md", desc: "The MongoDB-style Oracle API." },
                            ]}
                        />
                    </section>

                    {/* ── Footer ────────────────────────────────────────────────── */}
                    <footer className={`pt-8 border-t border-grey-200/30 dark:border-grey-700/30 text-center`}>
                        <p className={`text-sm ${BASE_COLOR_TEXT} opacity-50`}>CATHERINE Template · Built with Express 5 + React 19 + Tailwind v4</p>
                    </footer>
        </DocShell>
    );
}

export default function GettingStarted() {
    return (
        <ErrorBoundary>
            <GettingStartedContent />
        </ErrorBoundary>
    );
}
