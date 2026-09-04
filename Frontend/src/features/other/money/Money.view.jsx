/**
 * Money.view.jsx — Reference documentation for CATHERINE's money capability.
 *
 * The template ships a money CAPABILITY, not a money feature: exact-decimal
 * arithmetic (`Money`), an ISO 4217 registry, money-aware row signing,
 * idempotent money routes, live balance streaming, and money-safe export — but
 * no Wallet, no Transactions route, and no Finance nav group. This page is the
 * worked reference a copier reads before building a money domain on top.
 *
 * Every rule here is a BOOKING rule with an audit consequence, not an
 * engineering preference. Snippets mirror the verified library source
 * (Backend/src/utils/money.js, constants/currencies.js, integrity/signedFields.js,
 * middleware/security/IdempotencyMiddleware.js) — no fabricated APIs.
 *
 * Accessible at /about/money. Renders inside the app shell with a right-hand
 * "On this page" rail (shared DocShell).
 */

import { faArrowRightArrowLeft, faBan, faBolt, faCalculator, faCoins, faDatabase, faFileExcel, faKey, faScaleBalanced, faShieldHalved, faSignature, faTableCells, faTowerBroadcast, faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ANIMATE_ENTER_UP, ANIMATE_FADE_IN_UP, ANIM_DELAY_0, BASE_COLOR_BG, BASE_COLOR_TEXT, GRADIENT_COLOR_TEXT, HOVER_LIFT, STANDARD_BORDER, TITLE_COLOR_TEXT, TRANSITION_SPRING, staggerDelay } from "../../../assets/styles/pre-set-styles";
import { Callout, CodeBlock, DefRow, DocShell, WhereToGoNext } from "../../../components/shared/DocsPage";
import { ErrorBoundary } from "../../../components/feedback/ErrorBoundary";
import { Badge } from "../../../components/ui/Badge";

// ── Section registry — drives the "On this page" rail + scroll spy ────────────
const SECTIONS = [
    { id: "overview", label: "Overview" },
    { id: "why-not-number", label: "Why not Number" },
    { id: "currency-model", label: "The currency model" },
    { id: "money-table", label: "Defining a money table" },
    { id: "signing", label: "Signing a money row" },
    { id: "idempotency", label: "Idempotent money routes" },
    { id: "streaming", label: "Streaming a balance" },
    { id: "export", label: "Exporting money" },
    { id: "accounting", label: "Accounting rules" },
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

// ── Main content ──────────────────────────────────────────────────────────────
function MoneyContent() {
    return (
        <DocShell sections={SECTIONS}>
            {/* ── Hero ──────────────────────────────────────────────────────────── */}
            <header id="overview" className={`mb-12 scroll-mt-24 ${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_0}`}>
                <p className="text-xs font-bold uppercase tracking-widest text-(--accent-foreground) mb-2">Reference</p>
                <h1 className={`text-4xl sm:text-5xl font-extrabold tracking-tight ${TITLE_COLOR_TEXT}`}>
                    <span className={GRADIENT_COLOR_TEXT}>Money</span> and Currency
                </h1>
                <p className={`mt-4 text-lg leading-relaxed ${BASE_COLOR_TEXT} opacity-80 max-w-2xl`}>
                    CATHERINE ships a money <strong>capability</strong>, not a money feature. You get exact-decimal arithmetic, a currency registry, money-aware row signing, idempotent routes, live streaming, and money-safe export — but no Wallet and no Finance group. This page is the reference for building your own money domain on top, correctly, on day one.
                </p>
                <div className="flex flex-wrap gap-2 mt-5 mb-5">
                    <Badge variant="orange" size="sm">
                        Exact decimals (BigInt)
                    </Badge>
                    <Badge variant="green" size="sm">
                        ISO 4217
                    </Badge>
                    <Badge variant="blue" size="sm">
                        No currency column
                    </Badge>
                    <Badge variant="purple" size="sm">
                        Append-only ledgers
                    </Badge>
                    <Badge variant="cyan" size="sm">
                        Idempotent
                    </Badge>
                    <Badge variant="grey" size="sm">
                        Apache 2.0
                    </Badge>
                </div>
                <Callout tone="danger" icon={faScaleBalanced} title="These are booking rules, not style preferences">
                    Every rule on this page has an <strong>audit consequence</strong> if broken. A rounding error is not a formatting nit — it is the accounting identity failing. Read this page before you add a single money column.
                </Callout>
            </header>

            {/* ── Why not Number ────────────────────────────────────────────────── */}
            <section id="why-not-number" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Why Not <code className="font-mono">Number</code></h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>A JavaScript <code className="font-mono text-xs">Number</code> is an IEEE-754 double. It fails money in two distinct ways, both with real values:</p>
                <div className="grid gap-4 sm:grid-cols-2 mb-6">
                    {[
                        { icon: faBan, title: "Fractions don't represent", body: "0.1 + 0.2 === 0.30000000000000004. Sum a column of these and the total drifts. Money.from(\"0.1\").add(Money.from(\"0.2\")).toStorage() === \"0.3000\" — exactly." },
                        { icon: faTriangleExclamation, title: "Scale overflows silently", body: "Held as scaled integers, an amount past 9.0e11 at scale 4 crosses MAX_SAFE_INTEGER and rounds without error. A BigInt coefficient has no ceiling — the value survives intact." },
                    ].map((p, i) => (
                        <div key={p.title} className={`${ANIMATE_ENTER_UP} ${staggerDelay(i)}`}>
                            <CapabilityCard icon={p.icon} title={p.title}>
                                {p.body}
                            </CapabilityCard>
                        </div>
                    ))}
                </div>
                <CodeBlock title="Money — a BigInt coefficient plus an integer scale" language="js">{`const { Money } = require("../utils/money");

// Construct from a STRING (canonical) or a BigInt — never a JS number.
Money.from("0.1").add(Money.from("0.2")).toStorage();  // "0.3000"  (exact)
Money.from(0.1);                                        // throws — a number is
                                                       // already rounded to a double

// Serialises as a STRING everywhere, never a number.
JSON.stringify({ amount: Money.from("1500.5") });      // {"amount":"1500.5000"}`}</CodeBlock>
                <Callout tone="warn" icon={faBan} title="Nothing rounds — over-precision is rejected, not truncated">
                    <code className="font-mono text-xs">toStorage()</code> throws <strong>400</strong> on a value with more than four non-zero decimals rather than quietly truncating it into a <code className="font-mono text-xs">NUMBER(19,4)</code>. A silent truncation is a lost cent; a thrown error is a bug you find at the call site.
                </Callout>
            </section>

            {/* ── The currency model ────────────────────────────────────────────── */}
            <section id="currency-model" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>The Currency Model</h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>The base currency is a <strong>system fact</strong>, held in config (<code className="font-mono text-xs">MONEY_BASE_CURRENCY</code>) — never a column on a transaction row. Only the three-letter ISO 4217 code is ever persisted; symbols are presentation, resolved from the registry.</p>
                <CodeBlock title="The registry — code, display scale, symbol, locale" language="js">{`const { getCurrency, getDisplayScale } = require("../constants/currencies");

getDisplayScale("JPY");  // 0  — no minor unit
getDisplayScale("USD");  // 2
getDisplayScale("KWD");  // 3  — still STORED at scale 4

// Frontend: format at the currency's own display scale.
import { formatMoney } from "../components/shared/money";
formatMoney("1500.5000", "PHP");  // "₱1,500.50"
formatMoney("1500",      "JPY");  // "¥1,500"
formatMoney("1.2345",    "KWD");  // "KD 1.234"`}</CodeBlock>
                <div className="overflow-x-auto mt-6">
                    <table className="w-full text-left">
                        <tbody>
                            <DefRow name="Storage scale" value="Always 4 (NUMBER(19,4)), for every currency — so two money columns are always summable without knowing a per-currency scale." />
                            <DefRow name="Display scale" value="0–3, per currency. Presentation only — it formats, never rounds the stored value." />
                            <DefRow name="Persisted" value="The 3-letter code only, and only where a code is genuinely needed (e.g. a rate row). Never a symbol." />
                        </tbody>
                    </table>
                </div>
                <Callout tone="danger" icon={faShieldHalved} title="The invariant a copier must not break">
                    A non-base amount never reaches a money column raw. Conversion happens at the <strong>read boundary</strong> using the rate effective on the row's own date — so inserting a newer rate never changes a past figure.
                </Callout>
            </section>

            {/* ── Defining a money table ─────────────────────────────────────────── */}
            <section id="money-table" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Defining a Money Table</h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>Two column classes, never one. A posted amount and a rate are different value types with different scales — do not mix them.</p>
                <CodeBlock title="Column contract (reference DDL — the template ships none)" language="sql">{`-- Posted amount: exact, scale 4, non-negative guard.
BALANCE       NUMBER(19,4) DEFAULT 0 NOT NULL CHECK (BALANCE >= 0),
AMOUNT        NUMBER(19,4)           NOT NULL,
DIRECTION     VARCHAR2(6)            NOT NULL CHECK (DIRECTION IN ('CREDIT','DEBIT')),

-- Rate / unit price: higher precision, NEVER a posting (§3.7.3).
RATE          NUMBER(19,8)           NOT NULL,
CURRENCY_CODE VARCHAR2(3)            NOT NULL,  -- ISO 4217, rate rows only`}</CodeBlock>
                <div className="h-3" />
                <CodeBlock title="Bind the fixed-scale STRING — never a double" language="js">{`// toStorage() gives the canonical fixed-scale-4 string.
const amount = Money.from("1500.5").toStorage();  // "1500.5000"

// Bind through parseUpdate — the value never round-trips through a JS number.
await ledger.insertOne({ DIRECTION: "CREDIT", AMOUNT: amount });

// A fetchTypeHandler reads any NUMBER with scale > 0 back as a STRING, so the
// read side is exact too. Scale-0 columns (IDs, counts) stay numbers.`}</CodeBlock>
                <Callout tone="blue" icon={faDatabase} title="Full reference DDL is in the schema README">
                    <code className="font-mono text-xs">Backend/sql/README.md</code> carries commented DDL for <code className="font-mono text-xs">T_FX_RATE_DEV</code>, the base-currency epoch table, and a single-entry ledger — copy them when you build a money domain, not before.
                </Callout>
            </section>

            {/* ── Signing a money row ────────────────────────────────────────────── */}
            <section id="signing" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Signing a Money Row</h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>An HMAC only verifies when signer and verifier build a <strong>byte-identical</strong> field object. Money must be canonicalised first, or four spellings of one amount produce four digests.</p>
                <CodeBlock title="Four spellings, four digests — the failure to avoid" language="js">{`// Raw interpolation in CryptoVault.buildPayload:  \`\${k}=\${fields[k]}\`
1500        ->  "1500"
1500.00     ->  "1500"        // JS drops trailing zeros on a Number
"1500.5000" ->  "1500.5000"
1500.5      ->  "1500.5"
// A row signed at write time from a string and verified at read time from an
// Oracle NUMBER (a JS number) can NEVER match — legitimate rows read TAMPERED.`}</CodeBlock>
                <div className="h-3" />
                <CodeBlock title="One projection, money-canonicalised, shared by signer and verifier" language="js">{`const { makeSignedFields } = require("../utils/integrity/signedFields");

const ledgerSig = makeSignedFields({
  domain: "T_LEDGER_DEV",
  fields: ["DIRECTION", "AMOUNT", "MEMO"],
  moneyFields: ["AMOUNT"],   // run through Money.toStorage() before signing
});

const sig = await ledgerSig.sign(row);      // canonical, deterministic
const ok  = await ledgerSig.verify(row, sig);`}</CodeBlock>
                <Callout tone="warn" icon={faSignature} title="One builder, never four">
                    MEAL's projection drifted into four copies — two used <code className="font-mono text-xs">parseFloat</code>, two used <code className="font-mono text-xs">Number()</code> — so a corrected row read TAMPERED forever. There must be exactly one projection function. Row hashes are defence in depth; <strong>append-only</strong> is the primary control.
                </Callout>
            </section>

            {/* ── Idempotent money routes ────────────────────────────────────────── */}
            <section id="idempotency" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Making a Money Route Idempotent</h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>A duplicated money-moving request is not recoverable after the fact. The client sends an <code className="font-mono text-xs">Idempotency-Key</code>; a replay returns the stored outcome instead of posting twice.</p>
                <CodeBlock title="Mount after RateLimiter, before the handler" language="js">{`const { IdempotencyMiddleware } = require("../middleware/security/IdempotencyMiddleware");
const idem = new IdempotencyMiddleware({ ttl: 86400 });  // 24h

router.post("/ledger", idem.handle, ledgerController.post);

// Key + route + caller + body-hash -> stored outcome (2xx only).
//   same key, same body  -> replay the stored response (header Idempotent-Replay: true)
//   same key, diff body  -> 409 Conflict
//   missing key          -> 400 (required by default)`}</CodeBlock>
                <div className="overflow-x-auto mt-6">
                    <table className="w-full text-left">
                        <tbody>
                            <DefRow name="Guarded methods" value="POST, PUT, PATCH. GET/DELETE pass through untouched." />
                            <DefRow name="Body hash" value="SHA-256 of a stable, sorted-key JSON — a reordered body is the SAME request, not a conflict." />
                            <DefRow name="Caller scope" value="user id → ip → 'anonymous'. One caller's key never replays another's response (CWE-639)." />
                            <DefRow name="Storage" value="A dedicated cache-registry store with its own TTL. Only 2xx outcomes are stored." />
                        </tbody>
                    </table>
                </div>
            </section>

            {/* ── Streaming a balance ────────────────────────────────────────────── */}
            <section id="streaming" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Streaming a Balance</h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}><code className="font-mono text-xs">ScopedSsePoller</code> shares one poll across every client watching a scope; <code className="font-mono text-xs">useLiveStream</code> owns the connection lifecycle on the client.</p>
                <CodeBlock title="Server + client" language="js">{`// Server — one poll per scope, fanned out to all subscribers.
const { ScopedSsePoller } = require("../utils/sse/ScopedSsePoller");
const poller = new ScopedSsePoller({ intervalMs: 5000, fetch: readBalance });
poller.subscribe(req, res, { scope: accountId });

// Client — connect, receive, tear down cleanly on unmount.
const { data } = useLiveStream(\`/api/v1/ledger/\${accountId}/stream\`);`}</CodeBlock>
                <Callout tone="danger" icon={faTowerBroadcast} title="The load-bearing ordering rule">
                    Purge the cache <strong>before</strong> broadcasting the <code className="font-mono text-xs">update</code> event. A client that refetches on the event must never be served the stale rows it was told changed.
                </Callout>
            </section>

            {/* ── Exporting money ────────────────────────────────────────────────── */}
            <section id="export" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Exporting Money</h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>An exported figure with no stated conversion basis is not auditable. Every workbook carries the currency and the basis; every money cell uses the registry-derived format.</p>
                <CodeBlock title="Registry-driven format + a mandatory basis header" language="js">{`const { moneyFmtFor, exportCurrencyBasis } = require("../utils/excelFormat");

sheet.getColumn("amount").numFmt = moneyFmtFor("USD");  // negatives in red
sheet.addRow([exportCurrencyBasis({
  currencyCode: "USD",
  baseCurrency: "PHP",
  asOf: row.CREATED_AT,   // rate as of the row's own date
})]);`}</CodeBlock>
                <Callout tone="warn" icon={faFileExcel} title="Two silent defects this closes">
                    A hardcoded <code className="font-mono text-xs">"#,##0.00"</code> truncates a 3-decimal currency; <code className="font-mono text-xs">moneyFmtFor</code> reads the display scale from the registry. And <code className="font-mono text-xs">toExcelDate</code> pre-shifts by the value's own timezone offset, fixing the UTC-vs-local drift that wrote <code className="font-mono text-xs">06:01 AM</code> as the previous day's <code className="font-mono text-xs">10:01 PM</code>.
                </Callout>
            </section>

            {/* ── Accounting rules ───────────────────────────────────────────────── */}
            <section id="accounting" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-2 ${TITLE_COLOR_TEXT}`}>Accounting Rules</h2>
                <p className={`mb-6 ${BASE_COLOR_TEXT} opacity-75`}>Representation settles how money is stored; these settle how it is allowed to behave. Each is a rule with an audit consequence.</p>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {[
                        { icon: faScaleBalanced, title: "Posted vs derived", body: "allocate() is posted — parts sum to the total EXACTLY, largest-remainder, deterministic tie-break on a stable ID. divide() is derived — precision required, remainder returned as evidence." },
                        { icon: faCalculator, title: "allocate() always balances", body: "Split ₱100 three ways and get 33.3334 / 33.3333 / 33.3333 — never 33/33/33, never a refusal. A rounding-difference account is the wrong instrument for apportionment." },
                        { icon: faKey, title: "Ledgers are append-only", body: "A posted row is never UPDATEd. Correct with a reversing entry (equal-and-opposite) plus the right one, both visible. Row hashes are defence in depth." },
                        { icon: faTableCells, title: "Single-entry is a stated limit", body: "The demo ledger records DIRECTION + AMOUNT: a correct balance, but no trial balance and no missing-counter-posting detection. Double-entry would add paired zero-sum postings." },
                        { icon: faArrowRightArrowLeft, title: "Rates are append-only too", body: "A rate is never edited; a correction closes the window and opens a new one. Converting a historical row reproduces the same figure forever (rule 4)." },
                        { icon: faCoins, title: "Base currency is an epoch", body: "Under IAS 21 a base change is prospective — never restated. The base is a time-keyed epoch; a row uses the base in force at its own CREATED_AT. bootGuard refuses an in-place change." },
                        { icon: faShieldHalved, title: "Segregation of duties", body: "A money-moving route supports maker/checker via requireAccess(predicate): the initiator is not the approver." },
                        { icon: faBolt, title: "Period close & cut-off", body: "Once a period closes, no posting lands inside it. Retro-posting into a closed period is the most common money defect and is invisible until reconciliation." },
                        { icon: faDatabase, title: "Retention", body: "Money records: BIR RR 17-2013 = 10 years, SOX = 7 years. Set retention deliberately; do not inherit a default." },
                    ].map((c, i) => (
                        <div key={c.title} className={`${ANIMATE_ENTER_UP} ${staggerDelay(i)}`}>
                            <CapabilityCard icon={c.icon} title={c.title}>
                                {c.body}
                            </CapabilityCard>
                        </div>
                    ))}
                </div>
                <Callout tone="success" icon={faScaleBalanced} title="Exact arithmetic is close to free">
                    BigInt is native, no dependency, and the money path is not hot — there is no tradeoff to weigh. The one decision that carries cost is the driver's <code className="font-mono text-xs">fetchTypeHandler</code>: selecting on <code className="font-mono text-xs">scale &gt; 0</code> keeps its blast radius at zero until a money column exists.
                </Callout>
            </section>

            {/* ── Where to go next ──────────────────────────────────────────────── */}
            <section id="next" className="mb-14 scroll-mt-24">
                <h2 className={`text-2xl font-extrabold mb-6 ${TITLE_COLOR_TEXT}`}>Where to Go Next</h2>
                <WhereToGoNext
                    items={[
                        { label: "Mira ORM", to: "/about/mira-orm", desc: "The query layer — transactions, bind-safe writes, and $lookup joins for a money domain." },
                        { label: "Database Connection", to: "/about/database-connection", desc: "Pools and the connection registry the money path runs on." },
                        { code: "Backend/CLAUDE.md → Money", desc: "The enforced backend contract: value type, column classes, transaction discipline, accounting rules." },
                        { code: "Backend/sql/README.md", desc: "Commented reference DDL for the rate table, base-currency epochs, and a single-entry ledger." },
                    ]}
                />
            </section>

            {/* ── Footer ────────────────────────────────────────────────────────── */}
            <footer className="pt-8 border-t border-grey-200/30 dark:border-grey-700/30 text-center">
                <p className={`text-sm ${BASE_COLOR_TEXT} opacity-50`}>Money capability · exact-decimal, ISO 4217 © 2026 John Moises Paunlagui (Apache 2.0)</p>
            </footer>
        </DocShell>
    );
}

export default function Money() {
    return (
        <ErrorBoundary>
            <MoneyContent />
        </ErrorBoundary>
    );
}
