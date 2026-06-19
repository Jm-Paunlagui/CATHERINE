/**
 * DatabaseConnection.view.jsx — How CATHERINE connects to a database.
 *
 * Documents the pluggable data layer: the .env contract, the connection
 * registry in src/config/database.js (buildSimpleConnectString /
 * buildTNSConnectString), what the Oracle adapter (src/config/adapters/oracle.js)
 * does, and the two ways to query — with the built-in Oracle-Mongo-Wrapper ORM
 * or with pure SQL via withConnection().
 *
 * Accessible at /about/database-connection (public). Renders inside the app
 * shell with a right-hand "On this page" rail (shared DocShell).
 *
 * Every fact here is verified against the live backend source — no fabrication.
 */

import { faCircleCheck, faCode, faDatabase, faLayerGroup, faPlug, faRoute, faServer, faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ANIMATE_ENTER_UP, ANIMATE_FADE_IN_UP, ANIM_DELAY_0, BASE_COLOR_BG, BASE_COLOR_TEXT, GRADIENT_COLOR_TEXT, HOVER_LIFT, STANDARD_BORDER, TITLE_COLOR_TEXT, TRANSITION_SPRING, staggerDelay } from "../../../assets/styles/pre-set-styles";
import { ErrorBoundary } from "../../../components/feedback/ErrorBoundary";
import { Callout, CodeBlock, DefRow, DocShell, WhereToGoNext } from "../../../components/shared/DocsPage";
import { Badge } from "../../../components/ui/Badge";
import { Tabs } from "../../../components/ui/Tabs";

// ── Section registry — drives the "On this page" rail + scroll spy ────────────
const SECTIONS = [
    { id: "overview", label: "Overview" },
    { id: "env-setup", label: "Setting Up .env" },
    { id: "database-js", label: "Register in database.js" },
    { id: "adapter", label: "The Oracle Adapter" },
    { id: "querying", label: "Two Ways to Query" },
    { id: "transactions", label: "Transactions" },
    { id: "orm-optional", label: "Is the ORM Required?" },
    { id: "roadmap", label: "Other DB Engines" },
    { id: "next", label: "Where to Go Next" },
];

// ── Architecture piece card ───────────────────────────────────────────────────
function PieceCard({ icon, file, desc, color }) {
    return (
        <div className={`p-5 rounded-2xl ${BASE_COLOR_BG} ${STANDARD_BORDER} ${TRANSITION_SPRING} ${HOVER_LIFT}`}>
            <div className={`w-10 h-10 rounded-xl ${color} flex items-center justify-center mb-3`}>
                <FontAwesomeIcon icon={icon} className="text-(--accent-icon)" />
            </div>
            <code className="text-xs font-mono text-orange-400 dark:text-orange-300">{file}</code>
            <p className={`text-xs mt-1.5 ${BASE_COLOR_TEXT} opacity-70 leading-relaxed`}>{desc}</p>
        </div>
    );
}

// ── Main content ──────────────────────────────────────────────────────────────
function DatabaseConnectionContent() {
    return (
        <DocShell sections={SECTIONS}>
            {/* ── Hero ──────────────────────────────────────────────────────────── */}
            <header id="overview" className={`mb-12 scroll-mt-24 ${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_0}`}>
                <p className="text-xs font-bold uppercase tracking-widest text-orange-400 mb-2">Database Connection</p>
                <h1 className={`text-4xl sm:text-5xl font-extrabold tracking-tight ${TITLE_COLOR_TEXT}`}>
                    Connect <span className={GRADIENT_COLOR_TEXT}>CATHERINE</span> to your database
                </h1>
                <p className={`mt-4 text-lg leading-relaxed ${BASE_COLOR_TEXT} opacity-80 max-w-2xl`}>
                    The backend has a small, pluggable data layer: a <strong>connection registry</strong>, a lazy <strong>pool-managing adapter</strong>, and an optional <strong>MongoDB-style ORM</strong> (the Oracle-Mongo-Wrapper). The example ships <strong>one</strong> connection — but you can register as many as you need.
                </p>
                <div className="flex flex-wrap gap-2 mt-5">
                    <Badge variant="cyan" size="sm">
                        OracleDB
                    </Badge>
                    <Badge variant="blue" size="sm">
                        node-oracledb (Thick)
                    </Badge>
                    <Badge variant="purple" size="sm">
                        Connection Pooling
                    </Badge>
                    <Badge variant="green" size="sm">
                        Bind-variable safe
                    </Badge>
                    <Badge variant="orange" size="sm">
                        Optional ORM
                    </Badge>
                </div>

                {/* The five pieces */}
                <div className="grid gap-4 sm:grid-cols-2 mt-8">
                    {[
                        { icon: faPlug, file: ".env", desc: "Engine (DB_TYPE) + per-connection credentials and pool sizing. Skipped entirely when DEMO_MODE=true.", color: "bg-blue-400/10 dark:bg-blue-400/15" },
                        { icon: faLayerGroup, file: "src/config/database.js", desc: "Connection registry. Maps a name (e.g. appDb) to { user, password, connectString } using buildSimpleConnectString / buildTNSConnectString.", color: "bg-purple-400/10 dark:bg-purple-400/15" },
                        { icon: faServer, file: "src/config/adapters/oracle.js", desc: "Lazy connection pools, retry + backoff, background health monitoring, and the withConnection / withTransaction helpers.", color: "bg-orange-400/10 dark:bg-orange-400/15" },
                        { icon: faRoute, file: "src/config/index.js", desc: "Adapter factory. Picks the adapter from DB_TYPE and re-exports it together with database.js as one unified import.", color: "bg-cyan-400/10 dark:bg-cyan-400/15" },
                    ].map((p, i) => (
                        <div key={p.file} className={`${ANIMATE_ENTER_UP} ${staggerDelay(i)}`}>
                            <PieceCard {...p} />
                        </div>
                    ))}
                </div>
            </header>

            {/* ── Setting up .env ───────────────────────────────────────────────── */}
            <section id="env-setup" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Setting Up .env</h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>
                    The example file ships a <strong>single</strong> connection called <code className="font-mono text-xs">appDb</code> (the standalone template schema). Each connection needs its own credentials in <code className="text-orange-400 bg-orange-400/10 px-1.5 py-0.5 rounded text-xs font-mono">Backend/.env</code> — then one entry in <code className="font-mono text-xs">database.js</code>. Add as many as you like.
                </p>

                <CodeBlock title="Backend/.env">{`# Engine — "oracle" is the only adapter wired today
DB_TYPE=oracle

# Shared host/port + the appDb service name
DB_HOST=localhost
DB_PORT=1521
DB_APP_SERVICE_NAME=XEPDB1

# appDb credentials (the one connection a fresh template needs)
APP_DB_USERNAME=your_schema_user
APP_DB_PASSWORD=your_schema_password

# Optional per-connection pool sizing (falls back to 2 / 10)
APP_POOL_MIN=2
APP_POOL_MAX=10

# Required for Thick mode — unzipped Oracle Instant Client folder
ORACLE_INSTANT_CLIENT=C:\\oracle\\instantclient_23_8

# ── To add a SECOND connection, give it its own vars, e.g.: ──
# RPT_DB_USERNAME=reporting_user
# RPT_DB_PASSWORD=reporting_pass
# RPT_DB_HOST=localhost
# RPT_DB_PORT=1521
# RPT_DB_SERVICE_NAME=XEPDB1`}</CodeBlock>

                <Callout tone="blue" icon={faCircleCheck} title="Demo Mode skips the database">
                    With <code className="font-mono text-xs">DEMO_MODE=true</code> no Oracle pool is opened — auth, audit logs, admin management, and the changelog are served from in-memory fixtures. The database section below only applies when you run against a real schema.
                </Callout>
            </section>

            {/* ── Register in database.js ───────────────────────────────────────── */}
            <section id="database-js" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Register Connections in database.js</h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>
                    Connections are registered <strong>manually</strong> in <code className="font-mono text-xs">src/config/database.js</code>. You never hardcode passwords — only <code className="font-mono text-xs">process.env</code> references. Two built-in helpers build the connect string for you:
                </p>

                <div className="overflow-x-auto mb-6">
                    <table className="w-full text-left">
                        <tbody>
                            <DefRow name="buildSimpleConnectString(host, port, service)" value={`Returns "host:port/service" — Oracle EZConnect. Simplest; good for local dev and single-instance databases.`} />
                            <DefRow name="buildTNSConnectString(host, port, sid)" value="Returns a full (DESCRIPTION=(ADDRESS=…)…) string with LOAD_BALANCE and FAILOVER_MODE (SELECT/BASIC). Use for RAC / high-availability targets. This is what appDb uses." />
                        </tbody>
                    </table>
                </div>

                <h3 className={`text-lg font-bold mb-3 ${TITLE_COLOR_TEXT}`}>The shipped appDb entry</h3>
                <CodeBlock title="src/config/database.js" language="js">{`const connections = {
  // appDb — the only connection a fresh template needs.
  appDb: {
    user: process.env.APP_DB_USERNAME,
    password: process.env.APP_DB_PASSWORD,
    connectString: buildTNSConnectString(
      process.env.DB_HOST,
      process.env.DB_PORT,
      process.env.DB_APP_SERVICE_NAME,
    ),
    poolMin: parseInt(process.env.APP_POOL_MIN, 10) || 2,
    poolMax: parseInt(process.env.APP_POOL_MAX, 10) || 10,
  },
};`}</CodeBlock>

                <h3 className={`text-lg font-bold mb-3 mt-8 ${TITLE_COLOR_TEXT}`}>Adding a second connection</h3>
                <p className={`mb-4 text-sm ${BASE_COLOR_TEXT} opacity-75`}>Add the env vars (above), then one more entry. Nothing else changes — pools are created on first use.</p>
                <CodeBlock title="src/config/database.js" language="js">{`const connections = {
  appDb: { /* … as above … */ },

  // Second connection — EZConnect via buildSimpleConnectString
  reportingDb: {
    user: process.env.RPT_DB_USERNAME,
    password: process.env.RPT_DB_PASSWORD,
    connectString: buildSimpleConnectString(
      process.env.RPT_DB_HOST,
      process.env.RPT_DB_PORT,
      process.env.RPT_DB_SERVICE_NAME,
    ),
    poolMax: 10, // optional — overrides the global default
  },
};`}</CodeBlock>
                <p className={`mt-4 text-sm ${BASE_COLOR_TEXT} opacity-75`}>
                    Use it anywhere with <code className="font-mono text-xs">withConnection("reportingDb", …)</code> or <code className="font-mono text-xs">createDb("reportingDb")</code>.
                </p>

                <Callout tone="warn" icon={faTriangleExclamation} title="Oracle only — for now">
                    Both helpers and the registry currently target <strong>Oracle</strong> (<code className="font-mono text-xs">DB_TYPE=oracle</code> is the only adapter wired in <code className="font-mono text-xs">config/index.js</code>). A <strong>MySQL adapter is planned</strong> for a future update — see <a href="#roadmap" className="text-(--accent-foreground) underline underline-offset-2">Other DB Engines</a>.
                </Callout>
            </section>

            {/* ── The Oracle Adapter ────────────────────────────────────────────── */}
            <section id="adapter" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>What the Oracle Adapter Does</h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>
                    You never edit <code className="font-mono text-xs">src/config/adapters/oracle.js</code> to add a connection — it reads the registry and handles everything automatically:
                </p>

                <ul className={`space-y-2 mb-6 text-sm ${BASE_COLOR_TEXT} opacity-85`}>
                    {[
                        ["Lazy pools", "A pool is created the first time a connection name is used — and reused after that."],
                        ["Thick / Thin mode", "When ORACLE_INSTANT_CLIENT points at a valid client (oci.dll, oraociei23.dll), it runs in Thick mode (supports all password verifiers). Otherwise Thin mode."],
                        ["Retry with backoff", "Pool creation retries up to 3 times with exponential backoff — min(1000 · 2ⁿ, 10000) ms."],
                        ["Health monitoring", "A background monitor pings every pool every 30s and marks it unhealthy after 3 consecutive failures (and logs recovery). Live pool saturation feeds the Observability dashboard."],
                        ["Auto-release + timeouts", "Connections are released after each operation; a slow operation (>5s) is logged; connection acquisition times out at 15s."],
                        ["Graceful shutdown", "closeAll() drains every pool on process exit."],
                    ].map(([k, v]) => (
                        <li key={k} className="flex gap-2.5">
                            <FontAwesomeIcon icon={faCircleCheck} className="text-success-400 mt-1 w-3.5 h-3.5 shrink-0" />
                            <span>
                                <strong className={TITLE_COLOR_TEXT}>{k}</strong> — {v}
                            </span>
                        </li>
                    ))}
                </ul>

                <h3 className={`text-lg font-bold mb-3 ${TITLE_COLOR_TEXT}`}>Public API</h3>
                <div className="overflow-x-auto mb-8">
                    <table className="w-full text-left">
                        <tbody>
                            <DefRow name="withConnection(name, cb)" value="Acquire → run async (conn) => result → release." />
                            <DefRow name="withTransaction(name, cb)" value="Same as withConnection, wrapped in BEGIN / COMMIT / ROLLBACK." />
                            <DefRow name="withBatchConnection(name, ops[])" value="Run an array of operations on one shared connection; returns per-op { success, result/error, index }." />
                            <DefRow name="getPoolStats()" value="Monitoring snapshot — open/in-use connections, queue length, utilisation, recommendation." />
                            <DefRow name="isPoolHealthy(name) / getHealthMetrics()" value="Health probe used by the /health route and observability dashboard." />
                            <DefRow name="oracledb · OUT_FORMAT_OBJECT · EXECUTE_OPTIONS" value="The raw driver and execute presets, for pure-SQL queries (see below)." />
                        </tbody>
                    </table>
                </div>

                <h3 className={`text-lg font-bold mb-3 ${TITLE_COLOR_TEXT}`}>Pool defaults</h3>
                <p className={`mb-4 text-sm ${BASE_COLOR_TEXT} opacity-75`}>Applied to every pool unless overridden per-connection in <code className="font-mono text-xs">database.js</code> (appDb overrides poolMin/poolMax to 2 / 10).</p>
                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <tbody>
                            <DefRow name="poolMin / poolMax / poolIncrement" value="10 / 50 / 5" />
                            <DefRow name="poolTimeout / poolPingInterval" value="30s / 30s" />
                            <DefRow name="connectTimeout / queueTimeout" value="15s / 15s" />
                            <DefRow name="callTimeout" value="60s (max wait for a single query)" />
                            <DefRow name="stmtCacheSize" value="50 cached statements per connection" />
                        </tbody>
                    </table>
                </div>
            </section>

            {/* ── Two ways to query ─────────────────────────────────────────────── */}
            <section id="querying" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Two Ways to Query</h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>
                    CATHERINE ships a built-in ORM — the <strong>Oracle-Mongo-Wrapper</strong> — that lets you write MongoDB-style JavaScript and get bind-safe Oracle SQL. It is <strong>optional</strong>: you can drop to pure SQL through the same connection pools any time. Both paths use bind variables.
                </p>

                <Tabs
                    variant="pill"
                    size="sm"
                    tabs={[
                        {
                            id: "with-orm",
                            label: "With Oracle-Mongo-Wrapper",
                            content: (
                                <div className="mt-4 space-y-3">
                                    <p className={`text-sm ${BASE_COLOR_TEXT} opacity-75`}>
                                        <code className="font-mono text-xs">createDb(name)</code> binds to a registered pool; <code className="font-mono text-xs">OracleCollection</code> gives you MongoDB-style CRUD that compiles to bind-variable SQL.
                                    </p>
                                    <CodeBlock title="A backend service" language="js">{`const { createDb, OracleCollection } = require("../utils/oracle-mongo-wrapper");

const db = createDb("appDb");
const users = new OracleCollection("T_USERS_DEV", db);

// Read — { USERNAME: "admin" } becomes a bound WHERE clause
const admin = await users.findOne({ USERNAME: "admin" });

// Write
await users.insertOne({ USERNAME: "demo", IS_ACTIVE: "Y" });
await users.updateOne({ ID: 5 }, { $set: { IS_ACTIVE: "N" } });`}</CodeBlock>
                                </div>
                            ),
                        },
                        {
                            id: "pure-sql",
                            label: "Pure SQL (no ORM)",
                            content: (
                                <div className="mt-4 space-y-3">
                                    <p className={`text-sm ${BASE_COLOR_TEXT} opacity-75`}>
                                        Import the config and run raw SQL through <code className="font-mono text-xs">withConnection</code>. Pass values as <strong>bind variables</strong> — never string-concatenate input.
                                    </p>
                                    <CodeBlock title="A backend service" language="js">{`const db = require("../config");

const rows = await db.withConnection("appDb", async (conn) => {
  const result = await conn.execute(
    \`SELECT ID, USERNAME, EMAIL
       FROM T_USERS_DEV
      WHERE USERNAME = :username\`,
    { username: "admin" },   // bind variables — safe from injection
    db.EXECUTE_OPTIONS,      // { outFormat: OBJECT, autoCommit: true }
  );
  return result.rows;        // [{ ID, USERNAME, EMAIL }]
});`}</CodeBlock>
                                </div>
                            ),
                        },
                    ]}
                />

                <Callout tone="danger" icon={faTriangleExclamation} title="Always bind, never concatenate (CWE-89)">
                    Both styles parameterise values. Never build SQL by string concatenation with user input — the wrapper does this for you; in pure SQL you must pass a binds object as shown.
                </Callout>
            </section>

            {/* ── Transactions ──────────────────────────────────────────────────── */}
            <section id="transactions" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Transactions</h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>All-or-nothing work, either way:</p>

                <Tabs
                    variant="pill"
                    size="sm"
                    tabs={[
                        {
                            id: "tx-orm",
                            label: "With the wrapper",
                            content: (
                                <div className="mt-4 space-y-3">
                                    <CodeBlock title="A backend service" language="js">{`const { createDb, Transaction } = require("../utils/oracle-mongo-wrapper");
const db = createDb("appDb");

await new Transaction(db).withTransaction(async (session) => {
  const users = session.collection("T_USERS_DEV");
  await users.updateOne({ ID: 5 }, { $set: { IS_ACTIVE: "N" } });
  await session.savepoint("after_user");   // optional checkpoint
  // throw to roll back; return to commit — handled automatically
});`}</CodeBlock>
                                </div>
                            ),
                        },
                        {
                            id: "tx-sql",
                            label: "Pure SQL",
                            content: (
                                <div className="mt-4 space-y-3">
                                    <CodeBlock title="A backend service" language="js">{`const db = require("../config");

await db.withTransaction("appDb", async (conn) => {
  await conn.execute(
    \`UPDATE T_USERS_DEV SET IS_ACTIVE = :active WHERE ID = :id\`,
    { active: "N", id: 5 },
    { autoCommit: false },   // let withTransaction commit / rollback
  );
});`}</CodeBlock>
                                </div>
                            ),
                        },
                    ]}
                />

                <Callout tone="warn" icon={faTriangleExclamation} title="Inside withTransaction, set autoCommit: false">
                    <code className="font-mono text-xs">EXECUTE_OPTIONS</code> has <code className="font-mono text-xs">autoCommit: true</code> — fine for single statements, but it would commit each step of a transaction. Inside <code className="font-mono text-xs">withTransaction</code>, pass <code className="font-mono text-xs">{`{ autoCommit: false }`}</code> so the wrapper controls commit/rollback.
                </Callout>
            </section>

            {/* ── Is the ORM required? ──────────────────────────────────────────── */}
            <section id="orm-optional" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Is the ORM Required?</h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>
                    No. The Oracle-Mongo-Wrapper is a convenience layer over the <em>same</em> connection pools — <code className="font-mono text-xs">createDb(name)</code> and <code className="font-mono text-xs">withConnection(name, …)</code> draw from one registry. Mix freely:
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                    <div className={`p-5 rounded-2xl ${BASE_COLOR_BG} ${STANDARD_BORDER}`}>
                        <div className="w-10 h-10 rounded-xl bg-orange-400/10 dark:bg-orange-400/15 flex items-center justify-center mb-3">
                            <FontAwesomeIcon icon={faDatabase} className="text-(--accent-icon)" />
                        </div>
                        <h3 className={`font-bold text-sm ${TITLE_COLOR_TEXT}`}>Reach for the wrapper</h3>
                        <p className={`text-xs mt-1.5 ${BASE_COLOR_TEXT} opacity-70 leading-relaxed`}>Everyday CRUD, filtering, pagination, aggregation pipelines, joins, and transactions — with automatic bind safety and less boilerplate.</p>
                    </div>
                    <div className={`p-5 rounded-2xl ${BASE_COLOR_BG} ${STANDARD_BORDER}`}>
                        <div className="w-10 h-10 rounded-xl bg-blue-400/10 dark:bg-blue-400/15 flex items-center justify-center mb-3">
                            <FontAwesomeIcon icon={faCode} className="text-(--accent-icon)" />
                        </div>
                        <h3 className={`font-bold text-sm ${TITLE_COLOR_TEXT}`}>Reach for pure SQL</h3>
                        <p className={`text-xs mt-1.5 ${BASE_COLOR_TEXT} opacity-70 leading-relaxed`}>Hand-tuned queries, vendor-specific syntax, or anything the wrapper doesn't express — straight through withConnection, still pooled and bind-safe.</p>
                    </div>
                </div>
            </section>

            {/* ── Other DB engines (roadmap) ────────────────────────────────────── */}
            <section id="roadmap" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Other DB Engines</h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>
                    The data layer is engine-agnostic by design — <code className="font-mono text-xs">config/index.js</code> selects an adapter from <code className="font-mono text-xs">DB_TYPE</code>. Today only the <strong>Oracle</strong> adapter is wired; a <strong>MySQL adapter is planned</strong> for a future update.
                </p>
                <CodeBlock title="src/config/index.js" language="js">{`function _loadAdapter(engine) {
  switch (engine.toLowerCase()) {
    case "oracle":
      return require("./adapters/oracle");
    // case "mysql": return require("./adapters/mysql"); // planned
    default:
      throw new Error(\`Unknown DB_TYPE "\${engine}". Supported: oracle.\`);
  }
}`}</CodeBlock>
                <p className={`mt-4 text-sm ${BASE_COLOR_TEXT} opacity-75`}>
                    When the MySQL adapter lands: create <code className="font-mono text-xs">src/config/adapters/mysql.js</code> exposing the same API (<code className="font-mono text-xs">withConnection</code>, <code className="font-mono text-xs">withTransaction</code>, …), add a <code className="font-mono text-xs">case "mysql"</code>, and set <code className="font-mono text-xs">DB_TYPE=mysql</code>. No feature code changes.
                </p>
            </section>

            {/* ── Where to go next ──────────────────────────────────────────────── */}
            <section id="next" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-6 ${TITLE_COLOR_TEXT}`}>Where to Go Next</h2>
                <WhereToGoNext
                    items={[
                        { label: "CORS Setup", to: "/about/cors-setup", desc: "LAN IP access and the CORS_ORIGINS allow-list." },
                        { label: "Getting Started", to: "/about/getting-started", desc: "Prerequisites, secrets, and running the app." },
                        { code: "Backend/src/utils/oracle-mongo-wrapper/README.md", desc: "The full MongoDB-style Oracle API — operators, pipelines, joins, CTEs." },
                        { code: "Backend/src/config/database.js", desc: "The connection registry you edit to add connections." },
                        { code: "Backend/.env.example", desc: "Every documented env var with safe defaults." },
                        { code: "Backend/CLAUDE.md", desc: "Backend architecture, the dual-pool pattern, and conventions." },
                    ]}
                />
            </section>

            {/* ── Footer ────────────────────────────────────────────────────────── */}
            <footer className="pt-8 border-t border-grey-200/30 dark:border-grey-700/30 text-center">
                <p className={`text-sm ${BASE_COLOR_TEXT} opacity-50`}>CATHERINE Template · Oracle-Mongo-Wrapper © 2026 John Moises Paunlagui (Apache 2.0)</p>
            </footer>
        </DocShell>
    );
}

export default function DatabaseConnection() {
    return (
        <ErrorBoundary>
            <DatabaseConnectionContent />
        </ErrorBoundary>
    );
}
