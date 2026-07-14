/**
 * MiraOrm.view.jsx — Showcase for "Mira ORM", CATHERINE's built-in
 * MongoDB-style Oracle ORM (the oracle-mongo-wrapper).
 *
 * Covers capabilities, a code tour (CRUD → aggregation → transactions →
 * analytics → schema), ORM-vs-raw-SQL trade-offs, best practices, debugging,
 * and testing. Every snippet mirrors the verified library README and source
 * (src/utils/oracle-mongo-wrapper/**) — no fabricated APIs.
 *
 * Accessible at /about/mira-orm (public). Renders inside the app shell with a
 * right-hand "On this page" rail (shared DocShell).
 */

import { faBolt, faBug, faCode, faCubes, faDiagramProject, faGaugeHigh, faScaleBalanced, faShieldHalved, faSitemap, faTableCells, faTriangleExclamation, faVial } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ANIMATE_ENTER_UP, ANIMATE_FADE_IN_UP, ANIM_DELAY_0, BASE_COLOR_BG, BASE_COLOR_TEXT, GRADIENT_COLOR_TEXT, HOVER_LIFT, STANDARD_BORDER, TITLE_COLOR_TEXT, TRANSITION_SPRING, staggerDelay } from "../../../assets/styles/pre-set-styles";
import { Callout, CodeBlock, DefRow, DocShell, WhereToGoNext } from "../../../components/shared/DocsPage";
import { ErrorBoundary } from "../../../components/feedback/ErrorBoundary";
import { Badge } from "../../../components/ui/Badge";
import { Tabs } from "../../../components/ui/Tabs";

// ── Section registry — drives the "On this page" rail + scroll spy ────────────
const SECTIONS = [
    { id: "overview", label: "Overview" },
    { id: "why", label: "Why Mira" },
    { id: "capabilities", label: "Capabilities" },
    { id: "crud", label: "CRUD Basics" },
    { id: "query", label: "Querying & Filters" },
    { id: "aggregation", label: "Aggregation & Joins" },
    { id: "transactions", label: "Transactions" },
    { id: "advanced", label: "Advanced" },
    { id: "schema", label: "Schema & DCL" },
    { id: "orm-vs-sql", label: "ORM vs Raw SQL" },
    { id: "best-practices", label: "Best Practices" },
    { id: "debugging", label: "Debugging" },
    { id: "testing", label: "Testing" },
    { id: "next", label: "Where to Go Next" },
];

// ── Capability card ───────────────────────────────────────────────────────────
function CapabilityCard({ icon, title, children }) {
    return (
        <div className={`p-5 rounded-2xl ${BASE_COLOR_BG} ${STANDARD_BORDER} ${TRANSITION_SPRING} ${HOVER_LIFT}`}>
            <div className="w-10 h-10 rounded-xl bg-orange-400/10 dark:bg-orange-400/15 flex items-center justify-center mb-3">
                <FontAwesomeIcon icon={icon} className="text-(--accent-icon)" />
            </div>
            <h3 className={`font-bold text-sm ${TITLE_COLOR_TEXT}`}>{title}</h3>
            <p className={`text-xs mt-1.5 ${BASE_COLOR_TEXT} opacity-70 leading-relaxed`}>{children}</p>
        </div>
    );
}

// ── Pros / cons list ──────────────────────────────────────────────────────────
function ProsCons({ title, tone, points }) {
    const dot = tone === "pro" ? "text-success-400" : "text-warn-500 dark:text-warn-400";
    const icon = tone === "pro" ? faShieldHalved : faTriangleExclamation;
    return (
        <div className={`p-5 rounded-2xl ${BASE_COLOR_BG} ${STANDARD_BORDER}`}>
            <h4 className={`font-bold text-sm mb-3 ${TITLE_COLOR_TEXT}`}>{title}</h4>
            <ul className="space-y-2">
                {points.map((p) => (
                    <li key={p} className={`flex gap-2.5 text-xs ${BASE_COLOR_TEXT} opacity-85`}>
                        <FontAwesomeIcon icon={icon} className={`${dot} mt-0.5 w-3 h-3 shrink-0`} />
                        <span>{p}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

// ── Main content ──────────────────────────────────────────────────────────────
function MiraOrmContent() {
    return (
        <DocShell sections={SECTIONS}>
            {/* ── Hero ──────────────────────────────────────────────────────────── */}
            <header id="overview" className={`mb-12 scroll-mt-24 ${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_0}`}>
                <p className="text-xs font-bold uppercase tracking-widest text-(--accent-foreground) mb-2">Getting Started</p>
                <h1 className={`text-4xl sm:text-5xl font-extrabold tracking-tight ${TITLE_COLOR_TEXT}`}>
                    <span className={GRADIENT_COLOR_TEXT}>Mira</span> ORM
                </h1>
                <p className={`mt-4 text-lg leading-relaxed ${BASE_COLOR_TEXT} opacity-80 max-w-2xl`}>
                    Mira is CATHERINE's built-in <strong>MongoDB-style Oracle ORM</strong> — the <code className="font-mono text-base">oracle-mongo-wrapper</code>. You write familiar JavaScript; Mira generates parameterised Oracle SQL. Same query model from a one-line <code className="font-mono text-base">findOne</code> all the way to recursive CTEs and window functions.
                </p>
                <div className="flex flex-wrap gap-2 mt-5 mb-5">
                    <Badge variant="orange" size="sm">
                        MongoDB-style
                    </Badge>
                    <Badge variant="green" size="sm">
                        Bind-safe by default
                    </Badge>
                    <Badge variant="blue" size="sm">
                        Lazy cursors
                    </Badge>
                    <Badge variant="purple" size="sm">
                        Aggregation pipeline
                    </Badge>
                    <Badge variant="cyan" size="sm">
                        Transactions
                    </Badge>
                    <Badge variant="grey" size="sm">
                        Apache 2.0
                    </Badge>
                </div>
                <CodeBlock title="The whole idea, in four lines" language="js">{`const { createDb, OracleCollection } = require("../utils/oracle-mongo-wrapper");
const db = createDb("appDb");
const users = new OracleCollection("T_USERS_DEV", db);
const admin = await users.findOne({ USERNAME: "admin" }); // → bound WHERE clause`}</CodeBlock>
            </header>

            {/* ── Why Mira ──────────────────────────────────────────────────────── */}
            <section id="why" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Why I Reach for Mira</h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>A quick pitch, dev to dev — why this beats hand-writing SQL for most of the app:</p>
                <div className="grid gap-4 sm:grid-cols-2">
                    {[
                        { icon: faShieldHalved, title: "Injection-safe by default", body: "Every value flows through parseFilter / parseUpdate as a bind variable. You can't forget to parameterise — the wrapper does it for you (CWE-89)." },
                        { icon: faBolt, title: "Less code, more intent", body: "findOne({ USERNAME }) reads like the requirement. No string building, no manual bind bookkeeping, no result-shape plumbing." },
                        { icon: faCubes, title: "One model, all the way up", body: "The same chainable API scales from CRUD to aggregation pipelines, joins, window functions, and recursive CTEs." },
                        { icon: faCode, title: "Escape hatch, always", body: "Need a hand-tuned query? Drop to raw SQL through the same connection pools any time — Mira never traps you." },
                    ].map((p, i) => (
                        <div key={p.title} className={`${ANIMATE_ENTER_UP} ${staggerDelay(i)}`}>
                            <CapabilityCard icon={p.icon} title={p.title}>
                                {p.body}
                            </CapabilityCard>
                        </div>
                    ))}
                </div>
            </section>

            {/* ── Capabilities ──────────────────────────────────────────────────── */}
            <section id="capabilities" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>What It Can Do</h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>Backed by <code className="font-mono text-xs">OracleCollection</code>, <code className="font-mono text-xs">OracleSchema</code>, <code className="font-mono text-xs">OracleDCL</code>, <code className="font-mono text-xs">Transaction</code>, and the pipeline/CTE/subquery builders:</p>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {[
                        { icon: faCubes, title: "CRUD", body: "insertOne / insertMany, find / findOne, updateOne / updateMany, deleteOne / deleteMany, countDocuments, distinct, indexes." },
                        { icon: faTableCells, title: "Query operators", body: "$gt $gte $lt $lte $ne $in $nin $between $like $regex $exists, and $and / $or / $nor / $not logical groups." },
                        { icon: faDiagramProject, title: "Aggregation", body: "$match $group $project $addFields $sort $limit $skip $count $having $bucket $out $merge — chained as a pipeline." },
                        { icon: faSitemap, title: "Joins & sets", body: "$lookup (left/right/inner/full/self/natural), multi-condition joins, UNION / INTERSECT / MINUS." },
                        { icon: faBolt, title: "Analytics", body: "Window functions (RANK, LAG, running SUM…), CTEs, recursive CTEs, CONNECT BY, PIVOT / UNPIVOT, ROLLUP / CUBE." },
                        { icon: faCode, title: "Schema & permissions", body: "OracleSchema for DDL (tables, columns, constraints, sequences, views) and OracleDCL for GRANT / REVOKE." },
                        { icon: faShieldHalved, title: "Transactions", body: "Transaction with savepoints, bulkWrite, MERGE / UPSERT — all-or-nothing with automatic commit/rollback." },
                        { icon: faGaugeHigh, title: "Performance tools", body: "createPerformance(): explainPlan, table stats, materialised views; .explain() to see generated SQL." },
                    ].map((c, i) => (
                        <div key={c.title} className={`${ANIMATE_ENTER_UP} ${staggerDelay(i)}`}>
                            <CapabilityCard icon={c.icon} title={c.title}>
                                {c.body}
                            </CapabilityCard>
                        </div>
                    ))}
                </div>
                <Callout tone="blue" icon={faCode} title="This page is a tour, not the full reference">
                    The complete operator reference lives in <code className="font-mono text-xs">Backend/src/utils/oracle-mongo-wrapper/README.md</code>. Below are representative, runnable examples for each area.
                </Callout>
            </section>

            {/* ── CRUD ──────────────────────────────────────────────────────────── */}
            <section id="crud" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>CRUD Basics</h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>A collection is a reference to a table; nothing runs until a terminal method is called.</p>
                <CodeBlock title="Create · Read · Update · Delete" language="js">{`const users = new OracleCollection("T_USERS_DEV", db);

// Create
const { insertedId } = await users.insertOne({ USERNAME: "demo", IS_ACTIVE: "Y" });
await users.insertMany([{ USERNAME: "a" }, { USERNAME: "b" }]);

// Read
const one = await users.findOne({ USERNAME: "admin" });
const many = await users.find({ IS_ACTIVE: "Y" }).toArray();

// Update
await users.updateOne({ ID: 5 }, { $set: { IS_ACTIVE: "N" } });
await users.updateMany({ IS_ACTIVE: "N" }, { $set: { IS_ACTIVE: "Y" } });

// Delete + count
await users.deleteOne({ USERNAME: "demo" });
const total = await users.countDocuments({ IS_ACTIVE: "Y" });`}</CodeBlock>
                <Callout tone="warn" icon={faBolt} title="find() is lazy">
                    <code className="font-mono text-xs">find()</code> builds a query — no SQL runs until a terminal: <code className="font-mono text-xs">.toArray()</code>, <code className="font-mono text-xs">.next()</code>, <code className="font-mono text-xs">.count()</code>, <code className="font-mono text-xs">.forEach()</code>, or <code className="font-mono text-xs">.explain()</code>. Never chain after a terminal.
                </Callout>
            </section>

            {/* ── Querying & Filters ────────────────────────────────────────────── */}
            <section id="query" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Querying &amp; Filters</h2>
                <CodeBlock title="Operators + chaining" language="js">{`// Comparison + membership + range + pattern
await users.find({ AGE: { $gte: 18, $lte: 65 } }).toArray();
await users.find({ STATUS: { $in: ["active", "premium"] } }).toArray();
await users.find({ NAME: { $like: "J%" } }).toArray();

// Logical groups
await users.find({ $or: [{ CITY: "Manila" }, { CITY: "Cebu" }] }).toArray();

// Chain: filter → sort → paginate → project (page 2, 10/page)
const page = await users
  .find({ STATUS: "active" })
  .sort({ NAME: 1 })   // 1 = ASC, -1 = DESC
  .skip(10)
  .limit(10)
  .project({ NAME: 1, EMAIL: 1 })
  .toArray();`}</CodeBlock>
                <h3 className={`text-lg font-bold mb-3 mt-8 ${TITLE_COLOR_TEXT}`}>Terminal methods</h3>
                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <tbody>
                            <DefRow name=".toArray()" value="All matching rows as an array." />
                            <DefRow name=".next() / .hasNext()" value="First row / whether any row exists." />
                            <DefRow name=".count()" value="Count of matching rows." />
                            <DefRow name=".forEach(fn)" value="Stream rows one at a time — O(1) memory for huge result sets." />
                            <DefRow name=".explain()" value="Return the generated SQL string without running it (debugging)." />
                        </tbody>
                    </table>
                </div>
            </section>

            {/* ── Aggregation & Joins ───────────────────────────────────────────── */}
            <section id="aggregation" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Aggregation &amp; Joins</h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>An aggregation is an ordered array of stages — data flows through like a conveyor belt.</p>
                <CodeBlock title="Top 5 regions by completed sales" language="js">{`const report = await orders.aggregate([
  { $match: { status: "completed" } },
  { $group: { _id: "$region", total: { $sum: "$amount" } } },
  { $having: { total: { $gt: 10000 } } },  // filter AFTER grouping
  { $sort: { total: -1 } },
  { $limit: 5 },
]);`}</CodeBlock>
                <div className="h-3" />
                <CodeBlock title="$lookup — join (and avoid ORA-00918)" language="js">{`await orders.aggregate([
  {
    $lookup: {
      from: "customers",
      localField: "customerId",
      foreignField: "id",
      as: "cust",
      joinType: "left",       // left | right | inner | full | self | natural
      select: ["name"],       // pull only what you need from the right table
    },
  },
  { $project: { orderId: 1, amount: 1, "cust.name": 1 } },
]);`}</CodeBlock>
                <Callout tone="warn" icon={faTriangleExclamation} title="ORA-00918: column ambiguously defined">
                    When the joined table shares a column name with the left table, add <code className="font-mono text-xs">select: [...]</code> to the <code className="font-mono text-xs">$lookup</code> so the result set has no duplicate column.
                </Callout>
            </section>

            {/* ── Transactions ──────────────────────────────────────────────────── */}
            <section id="transactions" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Transactions</h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>All work shares one connection. Return to commit, throw to roll back — with optional savepoints for partial rollback.</p>
                <CodeBlock title="Atomic multi-step write" language="js">{`const { createDb, Transaction } = require("../utils/oracle-mongo-wrapper");
const db = createDb("appDb");

await new Transaction(db).withTransaction(async (session) => {
  const orders = session.collection("orders");
  const payments = session.collection("payments");

  await orders.insertOne({ item: "laptop", total: 50000 });
  await session.savepoint("after_order");

  try {
    await payments.insertOne({ amount: -999 }); // might fail
  } catch (err) {
    await session.rollbackTo("after_order");    // keep the order, drop the payment
  }
  // reach the end without throwing → COMMIT
});`}</CodeBlock>
            </section>

            {/* ── Advanced ──────────────────────────────────────────────────────── */}
            <section id="advanced" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Advanced</h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>The same model reaches Oracle's analytic muscle.</p>
                <Tabs
                    variant="pill"
                    size="sm"
                    tabs={[
                        {
                            id: "window",
                            label: "Window functions",
                            content: (
                                <div className="mt-4">
                                    <CodeBlock title="Rank within partition, running total" language="js">{`await orders.aggregate([
  {
    $addFields: {
      rank: { $window: { fn: "RANK", partitionBy: "region", orderBy: { amount: -1 } } },
      runningTotal: {
        $window: { fn: "SUM", field: "amount", partitionBy: "customerId", orderBy: { date: 1 } },
      },
    },
  },
]);`}</CodeBlock>
                                </div>
                            ),
                        },
                        {
                            id: "rcte",
                            label: "Recursive CTE",
                            content: (
                                <div className="mt-4">
                                    <CodeBlock title="Org chart (tree traversal)" language="js">{`const { withRecursiveCTE } = require("../utils/oracle-mongo-wrapper");

const orgChart = await withRecursiveCTE(db, "org", {
  anchor: employees.find({ managerId: null }),  // roots
  recursive: { collection: "employees", joinOn: { managerId: "$org.id" } },
})
  .sort({ LVL: 1, name: 1 })  // LVL is added automatically (1 = root)
  .toArray();`}</CodeBlock>
                                </div>
                            ),
                        },
                        {
                            id: "pivot",
                            label: "PIVOT",
                            content: (
                                <div className="mt-4">
                                    <CodeBlock title="Rows → columns" language="js">{`const pivot = await sales.pivot({
  value: { $sum: "$amount" },
  pivotOn: "quarter",
  pivotValues: ["Q1", "Q2", "Q3", "Q4"],
  groupBy: "region",
});`}</CodeBlock>
                                </div>
                            ),
                        },
                        {
                            id: "sets",
                            label: "Set ops",
                            content: (
                                <div className="mt-4">
                                    <CodeBlock title="UNION / INTERSECT / MINUS" language="js">{`const allVip = await OracleCollection.union(
  users.find({ tier: "gold" }).project({ name: 1 }),
  users.find({ tier: "platinum" }).project({ name: 1 }),
); // both sides must return the same column count`}</CodeBlock>
                                </div>
                            ),
                        },
                    ]}
                />
            </section>

            {/* ── Schema & DCL ──────────────────────────────────────────────────── */}
            <section id="schema" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Schema &amp; Permissions</h2>
                <CodeBlock title="DDL with OracleSchema, DCL with OracleDCL" language="js">{`const { OracleSchema, OracleDCL } = require("../utils/oracle-mongo-wrapper");
const schema = new OracleSchema(db);

await schema.createTable("users", {
  id: { type: "NUMBER", primaryKey: true, autoIncrement: true },
  name: { type: "VARCHAR2(200)", notNull: true },
  status: { type: "VARCHAR2(20)", default: "'active'" },
});
await schema.alterTable("users", { addColumn: { phone: "VARCHAR2(20)" } });
await schema.createSequence("order_seq", { startWith: 1000, incrementBy: 1 });

const dcl = new OracleDCL(db);
await dcl.grant(["SELECT", "INSERT"], "users", "app_user");`}</CodeBlock>
            </section>

            {/* ── ORM vs Raw SQL ────────────────────────────────────────────────── */}
            <section id="orm-vs-sql" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>
                    <FontAwesomeIcon icon={faScaleBalanced} className="text-(--accent-icon) mr-2" />
                    ORM vs Raw SQL
                </h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>Both are first-class in CATHERINE and share the same pools. An honest comparison:</p>
                <div className="grid gap-4 sm:grid-cols-2">
                    <ProsCons
                        title="Mira ORM — strengths"
                        tone="pro"
                        points={["Bind variables automatic — injection-safe without effort", "Far less boilerplate for CRUD and aggregation", "Readable, composable, lazy query building", "One mental model from simple to analytic queries", "Built-in transactions, joins, pagination, MERGE"]}
                    />
                    <ProsCons
                        title="Mira ORM — trade-offs"
                        tone="con"
                        points={["An operator vocabulary to learn", "Exotic / vendor-specific SQL can be awkward to express", "You still must understand the generated SQL for tuning", "One more layer between you and the database"]}
                    />
                    <ProsCons
                        title="Raw SQL — strengths"
                        tone="pro"
                        points={["Total control — exact SQL, every Oracle feature", "Best fit for hand-tuned, performance-critical queries", "Nothing new to learn if you're SQL-fluent", "Trivial to paste/iterate a query from a SQL client"]}
                    />
                    <ProsCons
                        title="Raw SQL — trade-offs"
                        tone="con"
                        points={["You must bind every value yourself — injection risk if sloppy", "Repetitive boilerplate for everyday CRUD", "String building and result-shape plumbing by hand", "Easy to drift from one consistent style across a team"]}
                    />
                </div>
                <Callout tone="blue" icon={faScaleBalanced} title="My rule of thumb">
                    Reach for <strong>Mira</strong> for ~90% of the app — CRUD, filtering, pagination, aggregation, transactions. Drop to <strong>raw SQL</strong> for the handful of hand-tuned or vendor-specific queries that profiling actually demands. Both bind their values; never concatenate user input either way (CWE-89).
                </Callout>
            </section>

            {/* ── Best practices ────────────────────────────────────────────────── */}
            <section id="best-practices" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-6 ${TITLE_COLOR_TEXT}`}>Best Practices</h2>
                <ul className={`space-y-2 text-sm ${BASE_COLOR_TEXT} opacity-85`}>
                    {[
                        ["Let Mira bind — never interpolate", "Values flow through parseFilter / parseUpdate as binds. The only documented raw exception is PIVOT IN, which sanitises quotes — never user input."],
                        ["Add select on a sharing $lookup", "When the joined table shares a column name, list the right-side columns to dodge ORA-00918."],
                        ["Respect laziness", "Build with find(), then call exactly one terminal. Don't chain after .toArray() / .next()."],
                        ["Project what you need", "Use .project({...}) / $project to fetch only the columns you use — smaller result sets, faster queries."],
                        ["Batch to avoid N+1", "Use $in, insertMany, or bulkUpdateByKeys instead of looping single-row calls."],
                        ["Wrap multi-step writes in a Transaction", "Atomicity with savepoints for partial rollback — especially for anything money-related."],
                    ].map(([k, v]) => (
                        <li key={k} className="flex gap-2.5">
                            <FontAwesomeIcon icon={faShieldHalved} className="text-(--accent-icon) mt-1 w-3.5 h-3.5 shrink-0" />
                            <span>
                                <strong className={TITLE_COLOR_TEXT}>{k}</strong> — {v}
                            </span>
                        </li>
                    ))}
                </ul>
            </section>

            {/* ── Debugging ─────────────────────────────────────────────────────── */}
            <section id="debugging" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>
                    <FontAwesomeIcon icon={faBug} className="text-(--accent-icon) mr-2" />
                    Debugging
                </h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>See exactly what Mira generates — no guessing.</p>
                <CodeBlock title="Inspect the SQL and the plan" language="js">{`// 1. The generated SQL string, without running it
const sql = await users
  .find({ status: "active", age: { $gte: 18 } })
  .sort({ name: 1 })
  .project({ name: 1, email: 1 })
  .explain();
// → SELECT "name","email" FROM "users" t0 WHERE "status" = :where_status_0 ...

// 2. Oracle's execution plan (full table scan vs index range scan)
const perf = createPerformance(db);
const plan = await perf.explainPlan(users.find({ status: "active" }));`}</CodeBlock>
                <div className="overflow-x-auto mt-6">
                    <table className="w-full text-left">
                        <tbody>
                            <DefRow name="ORA-00918" value="Ambiguous column from a $lookup — add select: [...] to the join." />
                            <DefRow name="ORA-00001" value="Unique constraint — handle insertMany with { batchErrors: true } to isolate the failing row." />
                            <DefRow name="ORA-01789" value="Recursive CTE column mismatch — withRecursiveCTE derives column lists for you; check anchor vs recursive shape." />
                        </tbody>
                    </table>
                </div>
            </section>

            {/* ── Testing ───────────────────────────────────────────────────────── */}
            <section id="testing" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>
                    <FontAwesomeIcon icon={faVial} className="text-(--accent-icon) mr-2" />
                    Testing
                </h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>
                    The backend test suite is <strong>Mocha + Chai + Sinon + Supertest</strong> (see <code className="font-mono text-xs">Backend/test/server/</code>). Two patterns for code that uses Mira:
                </p>
                <Tabs
                    variant="pill"
                    size="sm"
                    tabs={[
                        {
                            id: "unit",
                            label: "Unit (stub the collection)",
                            content: (
                                <div className="mt-4 space-y-3">
                                    <p className={`text-sm ${BASE_COLOR_TEXT} opacity-75`}>Test service logic without a database by stubbing the collection with Sinon.</p>
                                    <CodeBlock title="test/server/unit/services/userService.test.js" language="js">{`const sinon = require("sinon");
const { expect } = require("chai");

it("findActive() filters by status", async () => {
  const collection = {
    find: sinon.stub().returns({ toArray: async () => [{ ID: 1 }] }),
  };
  const rows = await collection.find({ STATUS: "active" }).toArray();

  expect(collection.find.calledWith({ STATUS: "active" })).to.be.true;
  expect(rows).to.have.length(1);
});`}</CodeBlock>
                                </div>
                            ),
                        },
                        {
                            id: "integration",
                            label: "Integration (scratch table)",
                            content: (
                                <div className="mt-4 space-y-3">
                                    <p className={`text-sm ${BASE_COLOR_TEXT} opacity-75`}>Run against a real table inside a Transaction and never commit — clean by construction.</p>
                                    <CodeBlock title="test/server/integration/users.test.js" language="js">{`const { createDb, Transaction } = require("../../../src/utils/oracle-mongo-wrapper");

it("inserts and reads back a user", async () => {
  const db = createDb("appDb");
  await new Transaction(db).withTransaction(async (session) => {
    const users = session.collection("T_USERS_DEV");
    await users.insertOne({ USERNAME: "tmp_test", IS_ACTIVE: "Y" });
    const found = await users.findOne({ USERNAME: "tmp_test" });
    expect(found.IS_ACTIVE).to.equal("Y");
    throw new Error("rollback");  // discard test data
  }).catch(() => {});
});`}</CodeBlock>
                                </div>
                            ),
                        },
                    ]}
                />
                <Callout tone="blue" icon={faVial} title="Assert the SQL, not just the result">
                    For builder-heavy code, <code className="font-mono text-xs">.explain()</code> lets a unit test assert the generated SQL shape (e.g. that a predicate became a bind variable) without touching the database.
                </Callout>
            </section>

            {/* ── Where to go next ──────────────────────────────────────────────── */}
            <section id="next" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-6 ${TITLE_COLOR_TEXT}`}>Where to Go Next</h2>
                <WhereToGoNext
                    items={[
                        { label: "Database Connection", to: "/about/database-connection", desc: "Pools, the connection registry, and ORM-vs-pure-SQL." },
                        { label: "Getting Started", to: "/about/getting-started", desc: "Prerequisites, secrets, and running the app." },
                        { code: "Backend/src/utils/oracle-mongo-wrapper/README.md", desc: "The complete operator reference — every stage, builder, and helper." },
                        { code: "Backend/test/server/", desc: "The Mocha + Chai + Sinon + Supertest suite to model your tests on." },
                    ]}
                />
            </section>

            {/* ── Footer ────────────────────────────────────────────────────────── */}
            <footer className="pt-8 border-t border-grey-200/30 dark:border-grey-700/30 text-center">
                <p className={`text-sm ${BASE_COLOR_TEXT} opacity-50`}>Mira ORM · oracle-mongo-wrapper © 2026 John Moises Paunlagui (Apache 2.0)</p>
            </footer>
        </DocShell>
    );
}

export default function MiraOrm() {
    return (
        <ErrorBoundary>
            <MiraOrmContent />
        </ErrorBoundary>
    );
}
