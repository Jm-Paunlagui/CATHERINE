/**
 * help.data.jsx — Static Q&A content for the Help Center.
 *
 * WHAT THIS FILE DOES
 * ───────────────────
 * Exports curated help articles organised by category, each tagged with a
 * visibility rule. Content is derived from the CATHERINE dev-docs and reference
 * views, rewritten for end-user consumption (no test evidence, no CWE
 * references, no code snippets).
 *
 * HOW ROLE FILTERING WORKS
 * ────────────────────────
 * Two visibility models, checked in priority order (identical in both hooks):
 *   1. `roles` — an exact allow-list. Authoritative when present: a category is
 *      visible iff the viewer is signed in AND their role is in the list.
 *   2. `minRole` — the tier ladder. Visible iff the viewer's tier is at least
 *      the category's minRole tier. Tiers:
 *         null / USER            → tier 0 (general only)
 *         ADMIN                  → tier 1 (general + admin)
 *         SUPER_ADMIN / ROBOT    → tier 2 (everything)
 *
 * A tier is a LADDER, so it cannot express "signed-in-only, exactly this role".
 * The three System categories (logging, metrics, admin management) therefore
 * carry an explicit `roles` allow-list INSTEAD of a tier, and a `roleGroup`
 * label so their own nav divider never gets stamped over another role-scoped
 * feature's rows — see HelpCategoryNav.jsx's `categoryGroup()`.
 *
 * @module help.data
 */

import {
    LuChartColumn,
    LuCircleHelp,
    LuCoins,
    LuDatabase,
    LuDatabaseBackup,
    LuGitBranch,
    LuHistory,
    LuLayoutDashboard,
    LuNetwork,
    LuPalette,
    LuRocket,
    LuScrollText,
    LuSettings,
    LuShieldCheck,
    LuTriangleAlert,
    LuUserCog,
} from "react-icons/lu";
import { Callout, DefList, Formula, Mark, WorkedExample } from "./components/HelpFormula";

// LuCircleHelp is imported for typedoc parity with the nav rail's default icon;
// it is intentionally unused inside the category table (each category names its
// own icon) but kept so a copier extending this file has the fallback to hand.
void LuCircleHelp;

// ── Role tier mapping ─────────────────────────────────────────────────────────

/** @type {Record<string|null, number>} */
export const ROLE_TIERS = { null: 0, undefined: 0, USER: 0, VIEWER: 0, APPROVER: 0, ADMIN: 1, SUPER_ADMIN: 2, ROBOT: 2 };

// ── Categories & articles ─────────────────────────────────────────────────────

/**
 * @typedef {object} HelpArticle
 * @property {string}            id       — unique slug
 * @property {string}            question — the question text
 * @property {string}            answer   — plain-English answer (no evidence, no code)
 * @property {object}            [answerRender] — { chunk, perChunk, chunkThreshold, highlight }
 * @property {React.ReactNode}   [detail] — optional rich JSX content (formulas, tables, examples)
 * @property {string[]}          tags     — search keywords
 */

/**
 * @typedef {object} HelpCategory
 * @property {string}        id          — unique slug (used in URL ?category=)
 * @property {string}        label       — display name
 * @property {Function}      icon        — Lucide icon component
 * @property {string}        color       — badge/dot colour key (blue|orange|yellow|grey|purple|turquoise|red)
 * @property {string|null}   minRole     — minimum role to see this category (ignored when `roles` is set)
 * @property {string[]}      [roles]     — exact role allow-list; authoritative when present
 * @property {string}        [roleGroup] — nav divider label for a `roles`-scoped category; ignored when `roles` is absent
 * @property {string}        description — short summary
 * @property {HelpArticle[]} articles    — Q&A pairs
 */

/** @type {HelpCategory[]} */
export const HELP_CATEGORIES = [
    // ══════════════════════════════════════════════════════════════════════════
    // TIER 0 — General (visible to everyone, including unauthenticated)
    // ══════════════════════════════════════════════════════════════════════════
    {
        id: "account-login",
        label: "Account & Login",
        icon: LuShieldCheck,
        color: "blue",
        minRole: null,
        description: "Passwords, sign-in, sessions, and account security",
        articles: [
            {
                id: "lockout-policy",
                question: "What happens if I enter the wrong password too many times?",
                answer: "After several failed sign-in attempts your account is temporarily locked. The lockout is progressive — each subsequent cycle shortens the number of tries you are allowed and lengthens the wait before you can try again. If you exhaust every lockout cycle, the account stops accepting sign-ins entirely and stays that way until an administrator resets your password.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "your account is temporarily locked", tone: "key" },
                        { phrase: "each subsequent cycle shortens the number of tries you are allowed and lengthens the wait", tone: "key" },
                        { phrase: "until an administrator resets your password", tone: "bad" },
                    ],
                },
                tags: ["password", "lockout", "login", "locked out", "failed attempts", "blocked", "reset"],
            },
            {
                id: "lockout-escalation",
                question: "How long does a sign-in lockout last, and does it get harsher each time?",
                answer: "Yes, it escalates on purpose. The first lockout is short — a brief cooling-off wait, then you can try again. But each time you get locked out again, two things tighten: you are allowed fewer tries before the next lock, and the wait before you can retry gets longer. This is designed to slow down someone guessing at your password while barely inconveniencing you if you simply mistyped once or twice. If you keep failing through every stage, the account stops accepting sign-ins altogether and can only be reopened by an administrator resetting your password — at that point waiting no longer helps.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "The first lockout is short", tone: "good" },
                        { phrase: "each time you get locked out again, two things tighten", tone: "key" },
                        { phrase: "the account stops accepting sign-ins altogether", tone: "bad" },
                    ],
                },
                tags: ["lockout", "escalation", "progressive", "wait time", "retry", "attempts"],
            },
            {
                id: "session-timeout",
                question: "Why was I signed out after being idle?",
                answer: "Your session runs on a short-lived access credential that expires after about thirty minutes. When it expires the server responds with a session-timeout signal and the app returns you to the sign-in screen so nobody can use an unattended session. A longer-lived credential quietly renews the short one in the background while you are active, so a normal working session keeps going without asking you to sign in again.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "expires after about thirty minutes", tone: "key" },
                        { phrase: "returns you to the sign-in screen", tone: "key" },
                        { phrase: "quietly renews the short one in the background while you are active", tone: "good" },
                    ],
                },
                tags: ["session", "timeout", "idle", "signed out", "expiry", "token"],
            },
            {
                id: "credentials-safe",
                question: "Where is my password stored, and can the page read my sign-in token?",
                answer: "Your password is never stored in plain text — only a one-way cryptographic hash of it is kept, so even an administrator cannot read it back. When you sign in successfully the server sets your session in a secure, browser-managed cookie that JavaScript on the page cannot read. That means a script running in your browser can never lift your session token, and the credential travels automatically with every request without the page ever holding it.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "never stored in plain text", tone: "good" },
                        { phrase: "a secure, browser-managed cookie that JavaScript on the page cannot read", tone: "good" },
                    ],
                },
                tags: ["password", "hash", "cookie", "token", "security", "credentials", "httponly"],
            },
            {
                id: "wrong-password-message",
                question: "Why does a wrong username show the same error as a wrong password?",
                answer: "It is deliberate. An unknown username and a correct username with the wrong password return exactly the same message. If the app said 'no such user' for one and 'wrong password' for the other, someone could probe the sign-in form to discover which usernames exist. Returning one identical response for both keeps that information private.",
                answerRender: {
                    highlight: [{ phrase: "return exactly the same message", tone: "key" }],
                },
                tags: ["error", "invalid credentials", "username", "enumeration", "security", "login"],
            },
        ],
    },
    {
        id: "getting-started",
        label: "Getting Started",
        icon: LuRocket,
        color: "orange",
        minRole: null,
        description: "A quick orientation to the app and where things live",
        articles: [
            {
                id: "what-is-this",
                question: "What is this application?",
                answer: "It is a starter template — a fully working web application shell you build a real product on top of. It ships the parts every serious app needs but nobody wants to rebuild: secure sign-in, role-based access, a themeable design system, request logging, live metrics, error handling, and a database layer. The example screens you see are reference material showing how each piece works.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "a starter template", tone: "key" },
                        { phrase: "secure sign-in, role-based access, a themeable design system, request logging, live metrics", tone: "key" },
                    ],
                },
                tags: ["getting started", "template", "overview", "introduction", "what is"],
            },
            {
                id: "landing-pages",
                question: "Where do I land when I open the app or after I sign in?",
                answer: "Opening the app takes you to the public Home page, which introduces the template and includes a live security demo. After you sign in you are sent to your Dashboard — a personalised landing that greets you by name and shows only the shortcuts your role is allowed to use. A role with no available shortcuts sees a clear empty state rather than blank placeholders.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "the public Home page", tone: "key" },
                        { phrase: "your Dashboard", tone: "key" },
                        { phrase: "only the shortcuts your role is allowed to use", tone: "good" },
                    ],
                },
                tags: ["home", "dashboard", "landing", "getting started", "navigation"],
            },
            {
                id: "find-help",
                question: "How do I find answers to questions like these?",
                answer: "Two ways. This Help Center is the full library — browse by category on the right, or search the box at the top to jump straight to an answer. Everywhere else in the app there is a floating help button in the bottom-right corner: click it (or press Ctrl+K) to search the same answers without leaving the page you are on.",
                answerRender: {
                    highlight: [
                        { phrase: "search the box at the top", tone: "key" },
                        { phrase: "a floating help button in the bottom-right corner", tone: "key" },
                    ],
                },
                tags: ["help", "search", "assistant", "getting started", "support", "ctrl+k"],
            },
        ],
    },
    {
        id: "appearance",
        label: "Appearance & Personalization",
        icon: LuPalette,
        color: "purple",
        minRole: null,
        description: "Light/dark mode, accent palettes, layout, and transparency",
        articles: [
            {
                id: "dark-mode",
                question: "How do I switch between light and dark mode?",
                answer: "Open the personalization panel and pick a colour-scheme mode: Light, Dark, or System. System follows your operating system's preference and updates live if you flip your OS between light and dark. Your choice is saved on this device, so it sticks the next time you visit.",
                answerRender: {
                    highlight: [
                        { phrase: "Light, Dark, or System", tone: "key" },
                        { phrase: "System follows your operating system's preference", tone: "good" },
                    ],
                },
                tags: ["dark mode", "light mode", "theme", "appearance", "system", "color scheme"],
            },
            {
                id: "accent-palette",
                question: "Can I change the app's accent colours?",
                answer: "Yes. Choose one of the named palettes, or pick a single custom colour and the app derives a whole matching scheme from it. The moment you choose, every accent across the app repaints — buttons, links, highlights, charts — because they all reference the same colour variables. Text and icons stay readable on any palette because the app recalculates contrast automatically for both light and dark mode.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "pick a single custom colour and the app derives a whole matching scheme", tone: "key" },
                        { phrase: "recalculates contrast automatically", tone: "good" },
                    ],
                },
                tags: ["palette", "accent", "color", "custom color", "appearance", "theme"],
            },
            {
                id: "layout-transparency",
                question: "What are the layout and transparency options for?",
                answer: "Layout switches the app shell between a left sidebar and a top navigation bar — pick whichever you prefer to work with. Transparency toggles the frosted, blurred backdrop effects behind panels and modals; turning it off gives you flat, solid surfaces, which some people find calmer or faster on older hardware. Both preferences are saved on this device.",
                answerRender: {
                    highlight: [
                        { phrase: "a left sidebar and a top navigation bar", tone: "key" },
                        { phrase: "Transparency toggles the frosted, blurred backdrop effects", tone: "key" },
                    ],
                },
                tags: ["layout", "sidebar", "top bar", "transparency", "blur", "appearance"],
            },
            {
                id: "personalize-stored",
                question: "Do my appearance settings sync across devices?",
                answer: "No — personalization is entirely local. Your mode, palette, layout, and transparency choices are stored in this browser only and never sent to the server. That means they load instantly and work even before you sign in, but you will set them again on a different device or browser.",
                answerRender: {
                    highlight: [
                        { phrase: "stored in this browser only", tone: "key" },
                        { phrase: "never sent to the server", tone: "good" },
                    ],
                },
                tags: ["personalize", "sync", "local", "storage", "device", "settings"],
            },
        ],
    },
    {
        id: "version-history",
        label: "Version History",
        icon: LuHistory,
        color: "grey",
        minRole: null,
        description: "Release notes, the version badge, and the release train",
        articles: [
            {
                id: "where-changelog",
                question: "Where can I see what changed between releases?",
                answer: "The Version History page lists every release entry — a date, a version number, a headline, and a bullet list of what changed. It is public, so you can read it before signing in, and the version badge shown around the app comes from the newest entry there.",
                answerRender: {
                    highlight: [
                        { phrase: "a date, a version number, a headline, and a bullet list of what changed", tone: "key" },
                        { phrase: "It is public", tone: "good" },
                    ],
                },
                tags: ["changelog", "version", "release notes", "history", "updates"],
            },
            {
                id: "version-badge",
                question: "What does the version badge next to the app name mean?",
                answer: "It shows the current version and its release stage. A release moves along a ladder — development, alpha, beta, release candidate, then stable — and the badge reflects where the newest published entry sits. A pre-stable badge signals the build is still maturing; a stable badge means it is a finished release.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "development, alpha, beta, release candidate, then stable", tone: "key" },
                        { phrase: "a stable badge means it is a finished release", tone: "good" },
                    ],
                },
                tags: ["version", "badge", "stage", "stable", "beta", "release train", "semver"],
            },
        ],
    },
    {
        id: "money-currency",
        label: "Money & Currency",
        icon: LuCoins,
        color: "yellow",
        minRole: null,
        description: "How amounts are stored, formatted, and kept exact",
        articles: [
            {
                id: "money-exact",
                question: "Why is money handled so carefully in this app?",
                answer: "Ordinary computer numbers cannot store many decimal amounts exactly — a classic example is that 0.1 plus 0.2 does not equal exactly 0.3. For money that is unacceptable, so the app carries every amount as an exact decimal value that never rounds during calculation. An amount is only ever formatted for display; the exact figure is always preserved underneath.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "an exact decimal value that never rounds during calculation", tone: "good" },
                        { phrase: "the exact figure is always preserved underneath", tone: "good" },
                    ],
                },
                tags: ["money", "currency", "decimal", "rounding", "exact", "precision"],
            },
            {
                id: "display-vs-stored",
                question: "Why might a displayed amount show fewer decimal places than were entered?",
                answer: "Each currency has a display scale — how many decimal places it shows on screen. Most currencies show two places; some show none (like the Japanese yen) and a few show three. This only affects presentation. The stored value keeps its full precision, so an amount that displays with two places is formatted, not rounded — the exact value is still there behind the scenes.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "how many decimal places it shows on screen", tone: "key" },
                        { phrase: "formatted, not rounded", tone: "good" },
                    ],
                },
                detail: (
                    <>
                        <Formula label="Displayed amount">stored value → format to currency&apos;s display scale (value unchanged)</Formula>
                        <DefList
                            label="Terms"
                            items={[
                                { name: "Stored value", desc: "The exact amount kept internally, at full precision.", color: "purple" },
                                { name: "Display scale", desc: "How many decimal places a currency shows on screen (0, 2, or 3).", color: "blue" },
                            ]}
                        />
                        <WorkedExample
                            title="An amount that stores more places than it shows"
                            variant="info"
                            steps={[
                                { label: "Stored value", value: "1500.5000" },
                                { label: "Currency display scale", value: "2 places" },
                            ]}
                            result="Shown as 1,500.50 — the exact value is untouched"
                        />
                        <Callout variant="info">
                            <Mark tone="plain">Display never rounds the stored value.</Mark> A currency that shows fewer places is formatted for readability only.
                        </Callout>
                    </>
                ),
                tags: ["display", "decimal places", "scale", "currency", "format", "rounding"],
            },
            {
                id: "money-inert",
                question: "Does this app charge money or hold a wallet?",
                answer: "No. The money capability is a toolkit, not a product. There is no wallet, no ledger, and no payment screen — only the exact-decimal foundation a project would build a money feature on top of. Until a base currency is configured, the money machinery stays completely dormant.",
                answerRender: {
                    highlight: [
                        { phrase: "a toolkit, not a product", tone: "key" },
                        { phrase: "stays completely dormant", tone: "good" },
                    ],
                },
                tags: ["money", "wallet", "payment", "capability", "currency", "toolkit"],
            },
        ],
    },
    {
        id: "dashboard-home",
        label: "Dashboard & Home",
        icon: LuLayoutDashboard,
        color: "blue",
        minRole: null,
        description: "The public Home page and your signed-in Dashboard",
        articles: [
            {
                id: "home-vs-dashboard",
                question: "What is the difference between Home and the Dashboard?",
                answer: "Home is the public front page — anyone can see it, and it introduces the template with a live security demonstration. The Dashboard is where every signed-in user lands after logging in. It greets you personally and shows the shortcuts your role can reach, so two different roles see two different dashboards.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "Home is the public front page", tone: "key" },
                        { phrase: "The Dashboard is where every signed-in user lands", tone: "key" },
                    ],
                },
                tags: ["home", "dashboard", "landing", "public", "shortcuts"],
            },
            {
                id: "security-demo",
                question: "What is the live security demo on the Home page?",
                answer: "It is a panel that fires representative malicious requests at the running backend and shows you whether each one was blocked. It is a real demonstration, not a mock-up — proof that the app's security layers are actually intercepting the kinds of attacks they are designed to stop.",
                answerRender: {
                    highlight: [
                        { phrase: "fires representative malicious requests at the running backend", tone: "key" },
                        { phrase: "a real demonstration, not a mock-up", tone: "good" },
                    ],
                },
                tags: ["security demo", "home", "attack", "blocked", "defense", "live"],
            },
            {
                id: "dashboard-shortcuts",
                question: "Why do I see different shortcuts than a colleague on the Dashboard?",
                answer: "Each shortcut declares which roles are allowed to use it, and the Dashboard shows you only the ones that match your role. A more privileged role sees more shortcuts; a basic role sees fewer. This is a convenience filter on top of the real access checks — the server still enforces permissions on every request regardless of what the Dashboard displays.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "shows you only the ones that match your role", tone: "key" },
                        { phrase: "the server still enforces permissions on every request", tone: "good" },
                    ],
                },
                tags: ["dashboard", "shortcuts", "role", "permissions", "access"],
            },
        ],
    },
    {
        id: "errors-troubleshooting",
        label: "Errors & Troubleshooting",
        icon: LuTriangleAlert,
        color: "red",
        minRole: null,
        description: "What error screens mean and when the whole page reloads",
        articles: [
            {
                id: "full-page-vs-inline",
                question: "Why do some errors take over the whole screen while others stay in place?",
                answer: "The app tells apart two kinds of failure. A full-page takeover happens only when the current screen genuinely cannot continue — your session has ended, the whole app is being rate-limited, or the server is not responding. Everything else — a validation message, a permission refusal, a record conflict — stays inline right where you are working, so you never lose a half-filled form to see what amounts to a form-validation message.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "A full-page takeover happens only when the current screen genuinely cannot continue", tone: "key" },
                        { phrase: "stays inline right where you are working", tone: "good" },
                        { phrase: "you never lose a half-filled form", tone: "good" },
                    ],
                },
                tags: ["error", "full page", "inline", "takeover", "validation", "troubleshooting"],
            },
            {
                id: "error-envelope",
                question: "Why do error messages look consistent and never show raw technical detail?",
                answer: "Every failure on the server passes through one classifier and comes back in a single, predictable shape: a status, a stable code, a title, and a friendly message. The raw database text, the query, and the stack trace stay in the server log where operators can find them — you only ever see the sanitised, safe version. That keeps sensitive internals out of the browser while still giving support a request id to trace the exact failure.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "one classifier", tone: "key" },
                        { phrase: "The raw database text, the query, and the stack trace stay in the server log", tone: "good" },
                        { phrase: "a request id to trace the exact failure", tone: "key" },
                    ],
                },
                tags: ["error", "message", "envelope", "request id", "troubleshooting", "log"],
            },
            {
                id: "what-to-do",
                question: "I hit an error — what should I do?",
                answer: "First, read the message: most are validation or permission notices that tell you exactly what to fix. If the app returned you to the sign-in screen, your session simply expired — sign in again and continue. If you see a service-unavailable screen, wait a moment and retry; it usually clears on its own. If it persists, note the request id shown on the error and give it to your administrator so they can find the matching server log line.",
                answerRender: {
                    chunk: true,
                    perChunk: 2,
                    highlight: [
                        { phrase: "read the message", tone: "key" },
                        { phrase: "sign in again and continue", tone: "good" },
                        { phrase: "note the request id", tone: "key" },
                    ],
                },
                tags: ["error", "troubleshooting", "what to do", "retry", "request id", "support"],
            },
        ],
    },

    // ══════════════════════════════════════════════════════════════════════════
    // TIER 1 — Admin (visible to ADMIN and above)
    // ══════════════════════════════════════════════════════════════════════════
    {
        id: "database-connection",
        label: "Database & Connections",
        icon: LuDatabase,
        color: "turquoise",
        minRole: "ADMIN",
        description: "How the app talks to Oracle and manages connection pools",
        articles: [
            {
                id: "how-db-works",
                question: "How does the app connect to the database?",
                answer: "The app talks to Oracle through pooled connections — a managed set of ready-to-use connections that requests borrow and return, rather than opening a fresh one every time. Pools are created lazily on first use and rebuilt automatically with backoff if the database is briefly unreachable, and a health monitor watches each pool so a failing one is spotted and recovered instead of silently degrading.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "pooled connections", tone: "key" },
                        { phrase: "created lazily on first use", tone: "key" },
                        { phrase: "a health monitor watches each pool", tone: "good" },
                    ],
                },
                tags: ["database", "oracle", "connection", "pool", "health", "backoff"],
            },
            {
                id: "no-raw-sql",
                question: "Do developers write raw SQL, and is it safe from injection?",
                answer: "No raw SQL is hand-written for normal data access. The app uses a query layer that takes simple, structured requests and turns them into safe database statements where every value you pass travels as a bound parameter and every table or column name is quoted. Because there is no way to concatenate a value into a query, the common injection attack simply has no surface to work against.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "every value you pass travels as a bound parameter", tone: "good" },
                        { phrase: "the common injection attack simply has no surface", tone: "good" },
                    ],
                },
                tags: ["sql", "injection", "safe", "bind variable", "query", "database", "security"],
            },
            {
                id: "demo-mode",
                question: "Can the app run without a database at all?",
                answer: "Yes. There is a demo mode that swaps the real database for an in-memory fixture store. The same sign-in, the same password checks, and the same behaviour all run unchanged — just against fixtures instead of Oracle. It is ideal for evaluating or demonstrating the app without provisioning a database.",
                answerRender: {
                    highlight: [
                        { phrase: "swaps the real database for an in-memory fixture store", tone: "key" },
                        { phrase: "run unchanged", tone: "good" },
                    ],
                },
                tags: ["demo mode", "database", "fixture", "no database", "in-memory", "offline"],
            },
        ],
    },
    {
        id: "mira-orm",
        label: "Mira ORM",
        icon: LuGitBranch,
        color: "purple",
        minRole: "ADMIN",
        description: "The document-style query layer over Oracle SQL",
        articles: [
            {
                id: "what-is-mira",
                question: "What is the document-style query layer?",
                answer: "It is a data layer that lets code work with the database using familiar document-shaped commands — find one, update one, insert one — instead of writing SQL by hand. Behind the scenes it translates each of those commands into a proper, parameterised Oracle statement. Developers get an ergonomic, readable interface; the database still receives correct, safe SQL.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "familiar document-shaped commands", tone: "key" },
                        { phrase: "translates each of those commands into a proper, parameterised Oracle statement", tone: "good" },
                    ],
                },
                tags: ["orm", "mira", "query", "document", "mongodb-style", "database"],
            },
            {
                id: "lazy-cursor",
                question: "When does a query actually run?",
                answer: "Queries are lazy. Describing a query — which records to find, how to sort them, how many to take — builds nothing on its own. The database is only touched when you ask for the result, at the terminal step that actually fetches. That means you can compose a query in stages without paying for a database round trip until you genuinely need the data.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "Queries are lazy", tone: "key" },
                        { phrase: "only touched when you ask for the result", tone: "good" },
                    ],
                },
                tags: ["query", "lazy", "cursor", "orm", "mira", "performance"],
            },
            {
                id: "advanced-unused",
                question: "Does the app use the full power of this data layer?",
                answer: "Only a fraction of it. The template's own screens use straightforward reads and writes against a single connection pool. The heavier capabilities — aggregation pipelines, joins across tables, window functions, hierarchical queries — all ship ready but unused, there for a project to reach for when it needs them.",
                answerRender: {
                    highlight: [
                        { phrase: "Only a fraction of it", tone: "key" },
                        { phrase: "ship ready but unused", tone: "good" },
                    ],
                },
                tags: ["orm", "mira", "aggregation", "joins", "advanced", "unused", "capability"],
            },
        ],
    },
    {
        id: "caching",
        label: "Caching",
        icon: LuDatabaseBackup,
        color: "orange",
        minRole: "ADMIN",
        description: "How the app caches reads and keeps cached data fresh",
        articles: [
            {
                id: "how-cache-works",
                question: "How does caching work in this app?",
                answer: "The backend keeps an in-process cache: certain read requests are remembered for a short time so a repeat request can be answered from memory instead of hitting the database again. Each cached area lives under a named store with its own settings. There is no external cache server — the cache lives inside the running app.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "an in-process cache", tone: "key" },
                        { phrase: "answered from memory instead of hitting the database again", tone: "good" },
                    ],
                },
                tags: ["cache", "caching", "performance", "read", "store", "memory"],
            },
            {
                id: "cache-invalidation",
                question: "How does the app avoid serving stale cached data after a change?",
                answer: "The hard part of caching is not storing data — it is knowing when to throw it away. When a request changes data, the app clears the affected cache entries so the next read rebuilds them from the source. When the app runs as several worker processes, an invalidation on one worker is relayed to the others, so no worker keeps serving an old copy after a change.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "clears the affected cache entries", tone: "key" },
                        { phrase: "relayed to the others", tone: "good" },
                        { phrase: "no worker keeps serving an old copy", tone: "good" },
                    ],
                },
                tags: ["cache", "invalidation", "stale", "fresh", "workers", "cluster"],
            },
            {
                id: "cache-stampede",
                question: "What happens if many requests miss the cache at the same time?",
                answer: "The app coalesces them. If several requests ask for the same uncached data at once, only one of them actually does the expensive work; the rest wait and share that single result. That prevents a burst of identical requests from all stampeding the database for the same value at the same moment.",
                answerRender: {
                    highlight: [
                        { phrase: "only one of them actually does the expensive work", tone: "good" },
                        { phrase: "the rest wait and share that single result", tone: "good" },
                    ],
                },
                tags: ["cache", "stampede", "single flight", "coalesce", "concurrent", "performance"],
            },
        ],
    },
    {
        id: "cors-setup",
        label: "CORS Setup",
        icon: LuNetwork,
        color: "grey",
        minRole: "ADMIN",
        description: "Which origins are allowed to call the API and why",
        articles: [
            {
                id: "what-is-cors",
                question: "What is CORS and why does the app enforce it?",
                answer: "CORS controls which websites are allowed to make requests to this API from a browser. By default a browser blocks a page on one site from calling an API on another; the app declares an explicit allow-list of trusted origins so only your own front end can talk to the API. A request from an unlisted origin is refused before it reaches any application logic.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "which websites are allowed to make requests", tone: "key" },
                        { phrase: "an explicit allow-list of trusted origins", tone: "good" },
                        { phrase: "refused before it reaches any application logic", tone: "good" },
                    ],
                },
                tags: ["cors", "origin", "allow-list", "cross-origin", "browser", "security"],
            },
            {
                id: "configure-cors",
                question: "Where do I configure the allowed origins?",
                answer: "The allowed origins are set in configuration, not in code, so adding a new front-end address is an environment change rather than a code change. If you deploy the front end to a new domain and requests start being blocked, adding that domain to the allowed-origins setting is almost always the fix.",
                answerRender: {
                    highlight: [
                        { phrase: "set in configuration, not in code", tone: "key" },
                        { phrase: "adding that domain to the allowed-origins setting is almost always the fix", tone: "good" },
                    ],
                },
                tags: ["cors", "configure", "origin", "domain", "blocked", "setup", "environment"],
            },
        ],
    },
    {
        id: "request-lifecycle",
        label: "Request Lifecycle",
        icon: LuScrollText,
        color: "blue",
        minRole: "ADMIN",
        description: "The ordered checks every request passes through",
        articles: [
            {
                id: "middleware-chain",
                question: "What happens to a request between arriving and being handled?",
                answer: "Every request runs through a fixed, ordered sequence of checks before any feature code sees it. In order, it passes security headers, a security filter, a request-id stamp, body parsing, response timing, compression, cross-origin checks, cookie parsing, cross-site-request protection, and rate limiting. Only a request that clears all of them reaches the route that actually does the work.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "a fixed, ordered sequence of checks", tone: "key" },
                        { phrase: "Only a request that clears all of them reaches the route", tone: "good" },
                    ],
                },
                tags: ["middleware", "request", "lifecycle", "chain", "order", "pipeline"],
            },
            {
                id: "order-matters",
                question: "Why does the order of those checks matter?",
                answer: "Because each step depends on the ones before it. Security headers go first so they apply to everything. The request id is stamped early so every later step and log line can be tied to that one request. Body parsing must happen before anything wants to read the request body. The order is deliberate and fixed — reordering it would break the guarantees each step relies on.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "each step depends on the ones before it", tone: "key" },
                        { phrase: "The order is deliberate and fixed", tone: "good" },
                    ],
                },
                tags: ["middleware", "order", "sequence", "request id", "lifecycle", "dependency"],
            },
            {
                id: "error-catch-all",
                question: "What catches a request that matches no route or throws an error?",
                answer: "Two handlers sit at the very end of the chain. Anything that matches no route falls to a not-found handler; anything that throws or fails funnels into one global error handler that turns it into the app's standard error response. They are mounted last on purpose, because an error handler can only catch what was registered before it.",
                answerRender: {
                    highlight: [
                        { phrase: "a not-found handler", tone: "key" },
                        { phrase: "one global error handler", tone: "key" },
                        { phrase: "mounted last on purpose", tone: "good" },
                    ],
                },
                tags: ["error", "404", "not found", "handler", "middleware", "lifecycle"],
            },
        ],
    },

    // ══════════════════════════════════════════════════════════════════════════
    // TIER 2 — Super Admin (visible to SUPER_ADMIN via minRole)
    // ══════════════════════════════════════════════════════════════════════════
    {
        id: "boot-config-build",
        label: "Boot, Config & Build",
        icon: LuSettings,
        color: "grey",
        minRole: "SUPER_ADMIN",
        description: "How the server starts, validates config, and is packaged",
        articles: [
            {
                id: "boot-guard",
                question: "What is the boot guard that runs at startup?",
                answer: "When the server starts it validates its configuration before doing anything else. The boot guard checks that every required secret is present, long enough, and not still a template placeholder. In production, if anything is missing or unsafe the process refuses to start rather than booting into an insecure state — a fail-closed check that turns a misconfiguration into a loud startup error instead of a silent vulnerability.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "validates its configuration before doing anything else", tone: "key" },
                        { phrase: "the process refuses to start rather than booting into an insecure state", tone: "good" },
                        { phrase: "fail-closed", tone: "key" },
                    ],
                },
                tags: ["boot", "startup", "config", "secrets", "validation", "fail-closed"],
            },
            {
                id: "clustering",
                question: "Does the server run as one process or several?",
                answer: "It can run as a cluster of worker processes to use more than one CPU core, or as a single worker. When clustered, one worker is elected the leader for scheduled jobs so a recurring task does not run several times over. If a worker crashes it is replaced, and shutdown is graceful — in-flight requests are allowed to finish before the process exits.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "a cluster of worker processes", tone: "key" },
                        { phrase: "one worker is elected the leader for scheduled jobs", tone: "good" },
                        { phrase: "shutdown is graceful", tone: "good" },
                    ],
                },
                tags: ["cluster", "workers", "process", "leader", "shutdown", "boot"],
            },
            {
                id: "pkg-build",
                question: "How is the backend packaged for deployment?",
                answer: "The backend can be compiled into a single self-contained executable, so it runs without a separate Node.js install on the target machine. A couple of native components that cannot be embedded in that bundle are copied alongside it during the build so the executable finds them at runtime. Configuration is read from a file next to the executable, so the app works no matter what folder it is launched from.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "a single self-contained executable", tone: "key" },
                        { phrase: "read from a file next to the executable", tone: "good" },
                    ],
                },
                tags: ["build", "pkg", "executable", "deploy", "package", "native"],
            },
        ],
    },

    // ══════════════════════════════════════════════════════════════════════════
    // ROLE-SCOPED — System (SUPER_ADMIN only, grouped under "System")
    // ══════════════════════════════════════════════════════════════════════════
    {
        id: "logging-audit",
        label: "Logging & Audit",
        icon: LuScrollText,
        color: "purple",
        roles: ["SUPER_ADMIN"],
        roleGroup: "System",
        description: "The two records every request writes, and how to browse them",
        articles: [
            {
                id: "two-records",
                question: "What does the app record about each request?",
                answer: "Every request produces two independent records. The first is a set of plain-text log lines on disk, grouped by severity, each stamped with a timestamp, the machine, the process, and the request's correlation id. The second is a single structured row in an audit table capturing the method, the endpoint, the status, how long it took, the client address, and who made it. The audit row is written after the response has already gone out, so logging never slows the user down.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "two independent records", tone: "key" },
                        { phrase: "plain-text log lines on disk", tone: "key" },
                        { phrase: "a single structured row in an audit table", tone: "key" },
                    ],
                },
                tags: ["logging", "audit", "log", "record", "request", "trace"],
            },
            {
                id: "request-id-trace",
                question: "How do I trace everything a single request did?",
                answer: "By its request id. Each request is given a unique id the moment it arrives, which is added to the response, stamped into every log line it produces, and stored on its audit row. Given one audit row you can pull back every log line that request wrote — one id ties the whole story together, which is the entire point of the design.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "By its request id", tone: "key" },
                        { phrase: "one id ties the whole story together", tone: "good" },
                    ],
                },
                tags: ["request id", "trace", "correlation", "logging", "audit", "debug"],
            },
            {
                id: "redaction",
                question: "Are sensitive values kept out of the logs?",
                answer: "Yes — credentials and personal data are redacted before anything is written. There are deliberately two redaction lists: the log lines strip both credentials and personal data, while the audit record uses a narrower credentials-only list, because that audit column is forensic evidence and over-redacting it would quietly destroy detail an investigation needs later.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "credentials and personal data are redacted before anything is written", tone: "good" },
                        { phrase: "two redaction lists", tone: "key" },
                    ],
                },
                tags: ["redaction", "sensitive", "credentials", "privacy", "logging", "audit"],
            },
            {
                id: "browse-logs",
                question: "Where do I browse logs and audit records?",
                answer: "On the Logging & Observability page, which is restricted to the highest role. Its Audit Logs area has two views: one reads the database-backed audit trail, with statistics, a filterable table, and a per-request trace; the other reads the on-disk log files by severity and offers a live tail that streams new lines as they are written.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "the Logging & Observability page", tone: "key" },
                        { phrase: "a live tail that streams new lines as they are written", tone: "good" },
                    ],
                },
                tags: ["logs", "browse", "audit trail", "live tail", "observability", "logging"],
            },
        ],
    },
    {
        id: "metrics-observability",
        label: "Metrics & Observability",
        icon: LuChartColumn,
        color: "turquoise",
        roles: ["SUPER_ADMIN"],
        roleGroup: "System",
        description: "The live metrics dashboard, golden signals, and alerts",
        articles: [
            {
                id: "how-metrics-work",
                question: "How does the app measure its own performance?",
                answer: "It measures itself with no external monitoring tool. The app keeps a running record of how long each route takes, how many requests it serves, and how often they fail, plus background probes for system health. Recording a request stays cheap — the numbers are only sorted and summarised when you actually open the dashboard to look.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "no external monitoring tool", tone: "key" },
                        { phrase: "how long each route takes, how many requests it serves, and how often they fail", tone: "key" },
                    ],
                },
                tags: ["metrics", "observability", "performance", "monitoring", "dashboard", "telemetry"],
            },
            {
                id: "golden-signals",
                question: "How do I read the metrics dashboard?",
                answer: "The Overview tiles show the four golden signals of a healthy service. Latency is how long requests take, read from high percentiles so slow outliers are not hidden by the average. Traffic is how many requests you are serving. Errors is the share that fail. Saturation is how full the system is — memory, event-loop lag, and database-pool usage. Per-route breakdowns below let you find exactly which endpoint is slow or erroring.",
                answerRender: {
                    chunk: true,
                    perChunk: 2,
                    highlight: [
                        { phrase: "the four golden signals", tone: "key" },
                        { phrase: "Latency", tone: "key" },
                        { phrase: "Traffic", tone: "key" },
                        { phrase: "Errors", tone: "key" },
                        { phrase: "Saturation", tone: "key" },
                    ],
                },
                detail: (
                    <>
                        <DefList
                            label="The four golden signals"
                            items={[
                                { name: "Latency", desc: "How long requests take, measured at high percentiles so slow outliers show.", color: "blue" },
                                { name: "Traffic", desc: "How many requests the app is currently serving.", color: "purple" },
                                { name: "Errors", desc: "The share of requests that fail with a server error.", color: "red" },
                                { name: "Saturation", desc: "How full the system is — memory, event-loop lag, database-pool usage.", color: "orange" },
                            ]}
                        />
                        <Callout variant="info">
                            Start at the tiles for a health snapshot, then use the <Mark tone="plain">per-route breakdown</Mark> to locate the specific endpoint behind a bad signal.
                        </Callout>
                    </>
                ),
                tags: ["metrics", "dashboard", "golden signals", "latency", "traffic", "errors", "saturation"],
            },
            {
                id: "alerts",
                question: "How do metric alerts work, and why don't they spam?",
                answer: "A set of rules is evaluated against the latest measurements to decide whether anything is unhealthy. Notifications are sent only on transitions — when an alert first fires, escalates, or recovers — not on every check. A steady problem that is polled every minute would otherwise generate the same alert over and over; recording only the changes keeps the notifications meaningful.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "sent only on transitions", tone: "good" },
                        { phrase: "recording only the changes keeps the notifications meaningful", tone: "good" },
                    ],
                },
                tags: ["alerts", "metrics", "notification", "transition", "rules", "observability"],
            },
            {
                id: "frontend-telemetry",
                question: "Does the app measure the browser experience too?",
                answer: "Yes. The front end collects web-performance measurements — how quickly the page becomes usable and how stable it is — along with any uncaught errors, and sends them back to the app. That reporting is deliberately allowed even before you sign in, because the whole point is to measure the sign-in page itself, which every user sees first.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "web-performance measurements", tone: "key" },
                        { phrase: "allowed even before you sign in", tone: "good" },
                    ],
                },
                tags: ["frontend", "telemetry", "web vitals", "performance", "browser", "metrics"],
            },
        ],
    },
    {
        id: "admin-management",
        label: "Admin Management & RBAC",
        icon: LuUserCog,
        color: "orange",
        roles: ["SUPER_ADMIN"],
        roleGroup: "System",
        description: "Privileged accounts, roles, and access control",
        articles: [
            {
                id: "roles",
                question: "What roles exist and what can each do?",
                answer: "Privileged accounts carry one of three roles: a basic role, an administrator role, and a super-administrator role. Access is not a fixed permission table — each protected action states its own rule in terms of the role. Broadly, administrators can manage day-to-day features, while super-administrators can additionally reach the sensitive areas like logging, metrics, and account management.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "one of three roles", tone: "key" },
                        { phrase: "each protected action states its own rule in terms of the role", tone: "key" },
                    ],
                },
                tags: ["rbac", "roles", "admin", "super admin", "access control", "permissions"],
            },
            {
                id: "tamper-evident",
                question: "How does the app know an account row wasn't edited directly in the database?",
                answer: "Each privileged account carries a cryptographic signature over its key fields. Before any change to an account, the app recomputes that signature and refuses the operation if it does not match — so a row edited directly in the database cannot be updated, deleted, or deactivated until its signature is repaired. After every legitimate change the row is re-signed so the protection stays intact.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "a cryptographic signature over its key fields", tone: "key" },
                        { phrase: "refuses the operation if it does not match", tone: "good" },
                        { phrase: "a row edited directly in the database cannot be updated, deleted, or deactivated", tone: "good" },
                    ],
                },
                tags: ["signature", "tamper", "integrity", "account", "rbac", "security"],
            },
            {
                id: "safety-guards",
                question: "What stops an administrator from locking everyone out?",
                answer: "Two safety guards. The app counts the remaining active super-administrators before a delete or a deactivation and refuses if the action would leave zero — you can never remove the last super-administrator. And a new password can never be set to the known reset default, so the reset placeholder can never quietly become a real, working credential.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "you can never remove the last super-administrator", tone: "good" },
                        { phrase: "a new password can never be set to the known reset default", tone: "good" },
                    ],
                },
                tags: ["safety", "last admin", "guard", "default password", "rbac", "lockout"],
            },
            {
                id: "provisioning",
                question: "How are new privileged accounts created?",
                answer: "Only through the account-management screen — there is no public self-registration. An existing administrator provisions each account, sets its role, and can reset passwords, repair a broken signature, or deactivate an account from the same roster, where every row shows its role, its active status, and its integrity state at a glance.",
                answerRender: {
                    chunk: true,
                    highlight: [
                        { phrase: "there is no public self-registration", tone: "good" },
                        { phrase: "An existing administrator provisions each account", tone: "key" },
                    ],
                },
                tags: ["provisioning", "create account", "admin", "register", "roster", "rbac"],
            },
        ],
    },
];
