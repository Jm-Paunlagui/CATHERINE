// Apply encoding polyfills first (mirrors server.js startup order)
require("../src/utils/encodingPolyfill");

("use strict");

/**
 * Seed (or reset) the changelog encrypted store.
 *
 * This script wipes the existing data/changelog.enc file and writes a fresh
 * copy from the SEED_ENTRIES constant below.
 *
 * Entries follow these rules:
 *   • Saturday commits are folded into the preceding Friday's displayDate.
 *   • Sunday commits are folded into the following Monday's displayDate.
 *   • Frontend and backend commits on the same displayDate are combined into
 *     one user-friendly entry.
 *   • Every version carries a -dev.N pre-release tag — the project has not
 *     shipped a formal stable release yet. Stage labels (alpha/beta/rc/stable)
 *     are reserved for when a real release process begins. This makes the
 *     version ladder strictly monotonic oldest→newest and semantically honest.
 *
 * Usage:
 *   node scripts/seed-changelog.js
 *
 * WARNING: Running this script OVERWRITES data/changelog.enc completely.
 *   Always run `node scripts/dump-changelog.js` first to capture live state.
 *
 * Prerequisites:
 *   CHANGELOG_ENCRYPTION_KEY (64-char hex)  OR  DATA_SIGNING_SECRET (≥32 chars)
 *   must be set in .env.
 */

const dotenv = require("dotenv");
dotenv.config({ path: ".env" });

const ChangelogModel = require("../src/models/changelog.model");

// ─── Seed entries (oldest → newest) ──────────────────────────────────────────
// Each displayDate is the "logical workday" after applying the Sat→Fri / Sun→Mon
// shift rule. Comments note when commits from adjacent weekend days are included.
//
// VERSION CONVENTION: all versions use -dev.N suffix.
//   • -rc.N  → normalised to -dev.N  (same ordinal)
//   • -beta.N → normalised to -dev.N  (same ordinal)
//   • bare X.Y.Z → normalised to X.Y.Z-dev.1

const SEED_ENTRIES = [
  {
    "id": "ca7e1100-0001-0000-0000-000000000001",
    "displayDate": "2026-03-02",
    "version": "1.0.0-dev.1",
    "title": "Initial Template Scaffold",
    "message": "First release of the Catherine full-stack template — a production-grade Express v5 + React 19 foundation with clean layered architecture and a standardized API contract.",
    "whatChanged": [
      {
        "text": "Established the full-stack project structure",
        "items": [
          "React 19 + Tailwind CSS v4 frontend with the Aumovio Design System",
          "Node.js + Express v5 backend with a class-based OOP architecture"
        ]
      },
      {
        "text": "Defined the frontend three-layer architecture (api → hook → view)"
      },
      {
        "text": "Defined the backend layered architecture (Route → Controller → Service → Model)"
      },
      {
        "text": "Added a standardized API response shape (sendSuccess / sendError)"
      },
      {
        "text": "Added the AppError class and a single global error handler"
      }
    ],
    "type": "feat",
    "authors": [
      "John Moises Paunlagui"
    ],
    "coAuthors": [],
    "createdAt": "2026-03-02T08:00:00.000Z",
    "updatedAt": "2026-06-18T02:27:55.762Z"
  },
  {
    "id": "ca7e1100-0002-0000-0000-000000000002",
    "displayDate": "2026-03-06",
    "version": "1.0.0-dev.2",
    "title": "Security Middleware Suite",
    "message": "Hardened the template with a full suite of security middleware covering response headers, CSRF, CORS, IP filtering, and scanner blocking.",
    "whatChanged": [
      {
        "text": "Added Helmet for secure HTTP response headers"
      },
      {
        "text": "Added double-submit-cookie CSRF protection"
      },
      {
        "text": "Added network-aware CORS with corporate, VPN, and local origin matching"
      },
      {
        "text": "Added a CIDR-aware IP allowlist filter"
      },
      {
        "text": "Added a security filter that blocks scanners, path traversal, and script injection"
      },
      {
        "text": "Added redirect prevention for all /api routes"
      }
    ],
    "type": "security",
    "authors": [
      "John Moises Paunlagui"
    ],
    "coAuthors": [],
    "createdAt": "2026-03-06T08:00:00.000Z",
    "updatedAt": "2026-06-18T02:28:20.389Z"
  },
  {
    "id": "ca7e1100-0003-0000-0000-000000000003",
    "displayDate": "2026-03-11",
    "version": "1.0.0-dev.3",
    "title": "JWT Authentication & Dynamic Permissions",
    "message": "Added JWT authentication with a data-driven permission model, per-user login lockout, and route guarding on the frontend.",
    "whatChanged": [
      {
        "text": "Added JWT authentication with HTTP-only cookie token storage"
      },
      {
        "text": "Introduced a dynamic requireAccess(predicate) authorization model",
        "items": [
          "Permissions are data-driven, not hardcoded per project"
        ]
      },
      {
        "text": "Added per-user login lockout after repeated failed attempts"
      },
      {
        "text": "Added ProtectedRoute and AuthMiddleware.isAuth() on the frontend"
      },
      {
        "text": "Added the standard auth routes (register, login, refresh, logout)"
      }
    ],
    "type": "feat",
    "authors": [
      "John Moises Paunlagui"
    ],
    "coAuthors": [],
    "createdAt": "2026-03-11T08:00:00.000Z",
    "updatedAt": "2026-06-18T02:29:37.943Z"
  },
  {
    "id": "ca7e1100-0004-0000-0000-000000000004",
    "displayDate": "2026-03-16",
    "version": "1.0.0-dev.4",
    "title": "OracleDB Dual-Pool & Mongo-Style Wrapper",
    "message": "Connected the template to OracleDB with a resilient dual-pool setup and a MongoDB-style query wrapper that makes Oracle SQL feel familiar.",
    "whatChanged": [
      {
        "text": "Added an OracleDB adapter with a dual-connection-pool pattern"
      },
      {
        "text": "Added a PoolHealthMonitor (30s checks, 3-strike unhealthy marking)"
      },
      {
        "text": "Added exponential-backoff retry on pool initialization"
      },
      {
        "text": "Added the oracle-mongo-wrapper library (MongoDB-style API over Oracle SQL)"
      },
      {
        "text": "Added Oracle error classification for clear, actionable messages"
      },
      {
        "text": "Added join column disambiguation to prevent ORA-00918 ambiguity errors"
      }
    ],
    "type": "feat",
    "authors": [
      "John Moises Paunlagui"
    ],
    "coAuthors": [],
    "createdAt": "2026-03-16T08:00:00.000Z",
    "updatedAt": "2026-06-18T02:30:26.847Z"
  },
  {
    "id": "ca7e1100-0005-0000-0000-000000000005",
    "displayDate": "2026-03-20",
    "version": "1.0.0-dev.5",
    "title": "Rate Limiting, Traceability & Response Timing",
    "message": "Added per-IP rate limiting, end-to-end request traceability, and response-time tracking with slow-response detection.",
    "whatChanged": [
      {
        "text": "Added a Sliding Window Counter rate limiter (in-memory, no Redis)"
      },
      {
        "text": "Added request traceability with a unique X-Request-Id per request"
      },
      {
        "text": "Added response-time tracking with an X-Response-Time header"
      },
      {
        "text": "Added structured incoming and completed request logging"
      },
      {
        "text": "Added graceful shutdown with connection-pool cleanup"
      }
    ],
    "type": "feat",
    "authors": [
      "John Moises Paunlagui"
    ],
    "coAuthors": [],
    "createdAt": "2026-03-20T08:00:00.000Z",
    "updatedAt": "2026-06-18T02:30:50.631Z"
  },
  {
    "id": "ca7e1100-0006-0000-0000-000000000006",
    "displayDate": "2026-03-27",
    "version": "1.0.0-dev.6",
    "title": "Aumovio Design System Component Library",
    "message": "Shipped the Aumovio Design System — a large, dark-mode-ready React component library covering forms, UI, charts, layout, and typography.",
    "whatChanged": [
      {
        "text": "Added form components",
        "items": [
          "Input, Select, Textarea, Checkbox, Radio, Toggle, FileInput, and more"
        ]
      },
      {
        "text": "Added UI components",
        "items": [
          "Modal, Drawer, Tabs, Table, Card, Badge, Tooltip, Datepicker, and more"
        ]
      },
      {
        "text": "Added a charts suite (Area, Bar, Donut, Heatmap, Line, Radial, Scatter)"
      },
      {
        "text": "Added layout components (Navbar, Sidebar, Footer, BottomNav)"
      },
      {
        "text": "Added a dark-mode ThemeToggle with persisted preference"
      },
      {
        "text": "Wrapped every view in an ErrorBoundary"
      }
    ],
    "type": "feat",
    "authors": [
      "John Moises Paunlagui"
    ],
    "coAuthors": [],
    "createdAt": "2026-03-27T08:00:00.000Z",
    "updatedAt": "2026-06-18T02:31:06.030Z"
  },
  {
    "id": "ca7e1100-0007-0000-0000-000000000007",
    "displayDate": "2026-04-02",
    "version": "1.0.0-dev.7",
    "title": "Domain-Agnostic Cache Subsystem",
    "message": "Added a reusable cache subsystem with a registry, deterministic key builder, and cache-aside middleware that ports cleanly to any project.",
    "whatChanged": [
      {
        "text": "Added CacheStore — a NodeCache wrapper with structured operation logging"
      },
      {
        "text": "Added CacheRegistry — the single place where cache stores are created"
      },
      {
        "text": "Added CacheKeyBuilder — alphabetically sorted keys, auto-hashed when long"
      },
      {
        "text": "Added CacheMiddleware — cache-aside read with fire-and-forget invalidation",
        "items": [
          "Only caches 2xx JSON responses; errors are never stored"
        ]
      }
    ],
    "type": "feat",
    "authors": [
      "John Moises Paunlagui"
    ],
    "coAuthors": [],
    "createdAt": "2026-04-02T08:00:00.000Z",
    "updatedAt": "2026-06-18T02:31:21.368Z"
  },
  {
    "id": "ca7e1100-0008-0000-0000-000000000008",
    "displayDate": "2026-04-08",
    "version": "1.0.0-dev.8",
    "title": "Metrics & Health Observability",
    "message": "Added live request metrics and a health endpoint so the running service can be monitored at a glance.",
    "whatChanged": [
      {
        "text": "Added a metrics middleware tracking Requests, Errors, and Duration (RED)"
      },
      {
        "text": "Added an in-memory MetricsStore with a metrics API route"
      },
      {
        "text": "Added a GET /api/v1/health endpoint that always returns 200 OK"
      },
      {
        "text": "Added frontend charts to visualize live service metrics"
      }
    ],
    "type": "feat",
    "authors": [
      "John Moises Paunlagui"
    ],
    "coAuthors": [],
    "createdAt": "2026-04-08T08:00:00.000Z",
    "updatedAt": "2026-06-18T02:31:35.736Z"
  },
  {
    "id": "ca7e1100-0009-0000-0000-000000000009",
    "displayDate": "2026-04-14",
    "version": "1.0.0-dev.9",
    "title": "Audit Logging Module",
    "message": "Added an audit logging module that records system activity for traceability and later investigation.",
    "whatChanged": [
      {
        "text": "Added an audit-log middleware that records mutating requests"
      },
      {
        "text": "Added audit-log route, controller, and service layers"
      },
      {
        "text": "Captured the request actor, action, and timestamp for every audited event"
      }
    ],
    "type": "feat",
    "authors": [
      "John Moises Paunlagui"
    ],
    "coAuthors": [],
    "createdAt": "2026-04-14T08:00:00.000Z",
    "updatedAt": "2026-06-18T02:31:57.797Z"
  },
  {
    "id": "ca7e1100-0010-0000-0000-000000000010",
    "displayDate": "2026-04-20",
    "version": "1.0.0-dev.10",
    "title": "RFC 5424 Logging & Session UX",
    "message": "Upgraded the logger to the industry-standard RFC 5424 8-level hierarchy and added proactive session-expiry handling on the frontend.",
    "whatChanged": [
      {
        "text": "Upgraded the logger from 4 levels to the RFC 5424 8-level hierarchy",
        "items": [
          "logger.warn(...) renamed to logger.warning(...) — warn kept as a deprecated alias"
        ]
      },
      {
        "text": "Added a proactive Session Warning modal before the login session expires"
      },
      {
        "text": "Added a Profile modal and toast notifications"
      },
      {
        "text": "Logs are organized as logs/YYYY/MM/DD/level.log and never truncated"
      }
    ],
    "type": "refactor",
    "authors": [
      "John Moises Paunlagui"
    ],
    "coAuthors": [],
    "createdAt": "2026-04-20T08:00:00.000Z",
    "updatedAt": "2026-06-18T02:32:10.869Z"
  },
  {
    "id": "ca7e1100-0011-0000-0000-000000000011",
    "displayDate": "2026-04-24",
    "version": "1.0.0-dev.11",
    "title": "Theme Personalization",
    "message": "Added a Personalize option so each user can pick the app's accent color theme, saved between sessions.",
    "whatChanged": [
      {
        "text": "Added a ColorPicker-based Personalize option for the accent color theme"
      },
      {
        "text": "Theme preference is persisted between sessions"
      },
      {
        "text": "Replaced hardcoded color values with design-system palette variables for consistency"
      }
    ],
    "type": "feat",
    "authors": [
      "John Moises Paunlagui"
    ],
    "coAuthors": [],
    "createdAt": "2026-04-24T08:00:00.000Z",
    "updatedAt": "2026-06-18T02:32:25.264Z"
  },
  {
    "id": "ca7e1100-0012-0000-0000-000000000012",
    "displayDate": "2026-04-28",
    "version": "1.0.0-dev.12",
    "title": "Changelog / Version History Module",
    "message": "Added the Changelog module — an encrypted entry store on the backend and a timeline-style Version History page on the frontend.",
    "whatChanged": [
      {
        "text": "Added an AES-256-GCM encrypted changelog store (data/changelog.enc)"
      },
      {
        "text": "Added changelog routes with SUPER_ADMIN-only create, update, and delete"
      },
      {
        "text": "Added a Version History timeline page with collapsible 'What Changed' sections"
      },
      {
        "text": "Added SemVer-aware version auto-suggestion based on the selected change type"
      }
    ],
    "type": "feat",
    "authors": [
      "John Moises Paunlagui"
    ],
    "coAuthors": [],
    "createdAt": "2026-04-28T08:00:00.000Z",
    "updatedAt": "2026-06-18T02:32:37.882Z"
  },
  {
    "id": "ca7e1100-0013-0000-0000-000000000013",
    "displayDate": "2026-05-04",
    "version": "1.0.0-dev.13",
    "title": "Changelog Entry Format Upgrade",
    "message": "Restructured changelog entries from a single summary field into a short headline message plus a structured 'What Changed' list, with automatic migration of older entries.",
    "whatChanged": [
      {
        "text": "Replaced the single summary field with a message + structured whatChanged array",
        "items": [
          "whatChanged supports nested sub-bullets (indent 2 spaces in the form)"
        ]
      },
      {
        "text": "Added automatic, idempotent migration of legacy summary-only entries on read"
      },
      {
        "text": "Updated the entry form to a one-item-per-line 'What Changed' textarea"
      }
    ],
    "type": "refactor",
    "authors": [
      "John Moises Paunlagui"
    ],
    "coAuthors": [],
    "createdAt": "2026-05-04T08:00:00.000Z",
    "updatedAt": "2026-06-18T02:32:56.338Z"
  },
  {
    "id": "3d64de09-948a-433a-8101-554250fcbea9",
    "displayDate": "2026-06-05",
    "version": "1.0.0-dev.14",
    "title": "Theme Personalization & Version History Upgrade",
    "message": "Personalize the app with a full color picker, more accent palettes that adapt to dark mode, and a layout switcher. The Version History page now shows grouped \"what changed\" detail per release.",
    "whatChanged": [
      {
        "text": "Appearance",
        "items": [
          "Added a full color picker (drag, hue slider, hex entry, keyboard control)",
          "Added many more accent palettes that adjust their surface and text colors in dark mode"
        ]
      },
      {
        "text": "Added a layout switcher and a redesigned two-column Personalize panel with live preview"
      },
      {
        "text": "Transparency toggle now applies instantly with no flash on load"
      },
      {
        "text": "Refreshed components for consistent dark-mode colors"
      },
      {
        "text": "Version History",
        "items": [
          "Release entries now carry a short headline plus a grouped \"what changed\" list with sub-items",
          "Added a `patch` release type",
          "Reset/seed the history from a standalone script instead of bundled data"
        ]
      }
    ],
    "type": "feat",
    "authors": [
      "John Moises Paunlagui"
    ],
    "coAuthors": [],
    "createdAt": "2026-06-05T07:16:54.728Z",
    "updatedAt": "2026-06-18T02:33:22.608Z"
  },
  {
    "id": "46d3d198-a38f-4717-ba4e-64374dca4053",
    "displayDate": "2026-06-05",
    "version": "1.0.0-dev.15",
    "title": "Accurate Availability and Error Rate Metrics",
    "message": "Availability no longer counts client errors (4xx) as failures, so the dashboard reflects true service health. Client and server errors now report as separate, clearly labelled rates.",
    "whatChanged": [
      {
        "text": "Availability is now computed from server errors only — a 4xx (bad input, failed auth, blocked scanner) counts as a correct rejection, not an outage"
      },
      {
        "text": "Client Error Rate (4xx) and Server Error Rate (5xx) shown as independent metrics, each as a share of total traffic"
      },
      {
        "text": "Added an Availability headline to the system health banner"
      },
      {
        "text": "Fixed audit statistics so category counts always reconcile with the total (no more Success + Redirect exceeding Total)"
      },
      {
        "text": "Retuned the high-error-rate alert to fire on server errors only (1% warning, 5% critical), removing false alarms from client-error noise"
      },
      {
        "text": "Request-completion logs now record the HTTP status code and duration, making error entries diagnosable"
      },
      {
        "text": "Added unit tests covering status-code boundaries and metric reconciliation"
      }
    ],
    "type": "patch",
    "authors": [
      "John Moises Paunlagui"
    ],
    "coAuthors": [],
    "createdAt": "2026-06-05T08:55:44.509Z",
    "updatedAt": "2026-06-18T02:33:37.719Z"
  },
  {
    "id": "9625a063-623e-4a7a-a5e1-7a4de817f3d7",
    "displayDate": "2026-06-08",
    "version": "1.0.0-dev.16",
    "title": "Accurate Heap Metrics And Leak Detection",
    "message": "The system monitor now reports memory against Node's real heap ceiling instead of a misleading internal figure, so a healthy server no longer shows a near-full heap. New garbage-collection and leak-trend indicators make memory problems visible before they cause an outage.",
    "whatChanged": [
      {
        "text": "Heap usage now measured against the real V8 limit, not the committed heap",
        "items": [
          "Dashboard bar reads true utilization (e.g. ~2%) instead of a false ~94%",
          "Committed heap kept as a secondary garbage-collection pressure hint"
        ]
      },
      {
        "text": "Added a Memory Trend (Leak Detector) card with Stable / Gathering Data / Leak Suspected status"
      },
      {
        "text": "Added garbage-collection health: overhead %, major/minor counts, recent pause times"
      },
      {
        "text": "Heap alerts now graduate (warning at 75%, critical at 90% of the limit)"
      },
      {
        "text": "New alerts for excessive GC overhead and sustained post-GC memory growth"
      },
      {
        "text": "Fixed a broken critical-heap log call that would have thrown when triggered"
      },
      {
        "text": "Added full unit, integration, and chaos test coverage plus test:metrics and test:chaos scripts"
      }
    ],
    "type": "patch",
    "authors": [
      "John Moises Paunlagui"
    ],
    "coAuthors": [
      "Claude Opus"
    ],
    "createdAt": "2026-06-08T04:01:36.924Z",
    "updatedAt": "2026-06-18T02:33:54.081Z"
  },
  {
    "id": "3e6d718e-9a6c-40b5-a580-b94252d9c2a8",
    "displayDate": "2026-06-15",
    "version": "1.0.0-dev.17",
    "title": "Standardized Observability Dashboard",
    "message": "The Logging & Observability page now follows industry-standard observability practice — one coherent five-tab layout built around the Four Golden Signals, with operational data the system was already collecting but never showing.",
    "whatChanged": [
      {
        "text": "Reorganized into five tabs: Overview, Metrics, Audit Logs, Health, Log Retention",
        "items": [
          "Overview leads with the Four Golden Signals (Latency, Traffic, Errors, Saturation) plus Apdex and a health-at-a-glance strip",
          "Metrics consolidates RED, System, Dependencies, Frontend Vitals, and Alerts"
        ]
      },
      {
        "text": "Added an Oracle Dependencies view showing live connection-pool utilization, open/in-use connections, and queue depth"
      },
      {
        "text": "Added a Frontend Vitals view — Core Web Vitals (LCP/CLS/INP) summaries with drill-down plus a client-side error log"
      },
      {
        "text": "Started collecting frontend performance and error telemetry that was previously inactive"
      },
      {
        "text": "Added a pool-saturation alert that warns above 80% and goes critical above 95% utilization"
      },
      {
        "text": "Added a one-click jump from a firing alert to the matching filtered audit logs"
      },
      {
        "text": "Surfaced the Apdex responsiveness score that was computed but never displayed"
      },
      {
        "text": "Improved dark-mode contrast on the historical date-range controls"
      }
    ],
    "type": "feat",
    "authors": [
      "John Moises Paunlagui"
    ],
    "coAuthors": [],
    "createdAt": "2026-06-15T04:02:11.804Z",
    "updatedAt": "2026-06-18T02:34:12.014Z"
  },
  {
    "id": "f82900ba-61c6-49a6-ae0b-e99ff74c3176",
    "displayDate": "2026-06-18",
    "version": "1.0.0-dev.18",
    "title": "Sidebar Layout Redesign",
    "message": "Redesigned the sidebar layout with a branded gradient header, responsive navigation breadcrumb, and fixed sidebar positioning for a polished, consistent experience across all screen sizes.",
    "whatChanged": [
      {
        "text": "Separated logo, version, and profile controls into a full-width header bar",
        "items": [
          "Company gradient (orange → purple) on desktop, palette and theme aware",
          "Glass-style version badge for gradient backgrounds"
        ]
      },
      {
        "text": "Rewrote breadcrumb to understand navigation groups",
        "items": [
          "Group segments show hover dropdowns instead of linking to 404 pages",
          "Sidebar toggle button appears on tablet/mobile screens",
          "Gradient styling matches the header bar"
        ]
      },
      {
        "text": "Sidebar is always expanded on desktop, slides in as overlay on tablet",
        "items": [
          "Sidebar stays fixed while main content scrolls independently",
          "Removed collapsed icon-only mode"
        ]
      },
      {
        "text": "Active sidebar border now matches each group's assigned color"
      },
      {
        "text": "Header height is consistent between sidebar and topbar layout modes"
      },
      {
        "text": "Removed sidebar-specific CSS variables — uses standard theme tokens"
      }
    ],
    "type": "feat",
    "authors": [
      "John Moises Paunlagui"
    ],
    "coAuthors": [
      "Claude Opus"
    ],
    "createdAt": "2026-06-18T09:21:17.836Z",
    "updatedAt": "2026-06-18T09:21:17.836Z"
  },
  {
    "id": "a8e93459-baa8-4d51-8296-96a4e7122763",
    "displayDate": "2026-06-19",
    "version": "1.0.0-dev.19",
    "title": "In-App Documentation & Public Changelog",
    "message": "Added scroll-spy documentation system with comprehensive guides for Getting Started, CORS, Database Connection, and Mira ORM. Version History is now publicly viewable without authentication.",
    "whatChanged": [
      {
        "text": "Added DocShell layout with sticky \"On this page\" rail for navigation"
      },
      {
        "text": "Implemented useScrollSpy hook for section tracking and smooth scroll"
      },
      {
        "text": "Created Callout, CodeBlock, DefRow, WhereToGoNext shared components"
      },
      {
        "text": "Added Getting Started documentation page"
      },
      {
        "text": "Added CORS Setup documentation page"
      },
      {
        "text": "Added Database Connection documentation page"
      },
      {
        "text": "Created comprehensive Mira ORM showcase (14+ sections: overview, capabilities, CRUD, aggregation, transactions, advanced queries, schema, ORM vs SQL, best practices, debugging, testing)"
      },
      {
        "text": "Integrated documentation into sidebar navigation (Features & Docs)"
      },
      {
        "text": "Made /api/v1/changelog GET endpoint public (read-only for all users)"
      },
      {
        "text": "Updated oracle-mongo-wrapper README with clarified examples"
      }
    ],
    "type": "feat",
    "authors": [
      "John Moises Paunlagui"
    ],
    "coAuthors": [
      "Claude Opus"
    ],
    "createdAt": "2026-06-19T09:14:49.047Z",
    "updatedAt": "2026-06-19T09:14:49.047Z"
  },
  {
    "id": "3cf91049-f9de-4cf2-987d-4e55550ef850",
    "displayDate": "2026-06-20",
    "version": "1.0.0-dev.20",
    "title": "Test Suite Migration to Vitest",
    "message": "Backend test tooling moved to Vitest for faster, more reliable runs and stricter coverage gates. Connection pool sizing and the email library were upgraded for better performance and security under load.",
    "whatChanged": [
      {
        "text": "Migrated the full backend test suite from Mocha/Chai/Sinon to Vitest",
        "items": [
          "845 tests across 57 files passing on the new runner",
          "Added coverage gates: 80% lines/statements, 85% branches/functions",
          "Each test file runs in an isolated process for safe env handling"
        ]
      },
      {
        "text": "Increased database connection pool sizing (min 5, max 20) for steadier performance under concurrent load"
      },
      {
        "text": "Upgraded the email library (nodemailer) to v9 for security and compatibility"
      },
      {
        "text": "Fixed environment variable loading so config no longer re-injects values tests deliberately clear"
      },
      {
        "text": "Moved the local dev server port to 5174"
      },
      {
        "text": "Removed obsolete cache, changelog, metrics, and release test files"
      }
    ],
    "type": "chore",
    "authors": [
      "John Moises Paunlagui"
    ],
    "coAuthors": [
      "Claude Opus"
    ],
    "createdAt": "2026-06-20T10:23:56.750Z",
    "updatedAt": "2026-06-20T10:23:56.750Z"
  },
  {
    "id": "c51b96a4-bd48-4b6f-8762-a8c4147b3563",
    "displayDate": "2026-06-30",
    "version": "1.0.0-dev.21",
    "title": "Template Decoupling and Cron-Leader Election",
    "message": "Removed all hard-coded HRIS and Meal project references so the template ships as a clean, product-agnostic starting point. Added automatic cron-leader election for clustered deployments.",
    "whatChanged": [
      {
        "text": "Removed legacy HRIS user-account model and Meal admin model"
      },
      {
        "text": "Renamed admin table references from T_EMP_MGMT_ADMIN to T_ADMINS_DEV"
      },
      {
        "text": "Renamed binary, IPC channels, and storage keys to generic names"
      },
      {
        "text": "Added ClusterRole utility — exactly one worker runs scheduled jobs"
      },
      {
        "text": "Added cron-leader election and re-election on worker death"
      },
      {
        "text": "Genericised changelog subtitle and role descriptions in the UI"
      },
      {
        "text": "Re-indented core backend files to 4-space convention"
      },
      {
        "text": "Updated SQL README and Getting Started guide to remove project-specific setup"
      }
    ],
    "type": "refactor",
    "authors": [
      "John Moises Paunlagui"
    ],
    "coAuthors": [
      "Claude Opus"
    ],
    "createdAt": "2026-06-30T08:30:59.784Z",
    "updatedAt": "2026-06-30T08:30:59.784Z"
  },
  {
    "id": "cb17bfdf-2555-4f92-8cef-c93798b6c6e3",
    "displayDate": "2026-06-30",
    "version": "1.0.0-dev.22",
    "title": "Frontend Web Vitals Telemetry",
    "message": "Browser performance metrics (LCP, CLS, FID, INP) and uncaught JavaScript errors now flow automatically to the backend observability pipeline — no user action required.",
    "whatChanged": [
      {
        "text": "Web Vitals collection (LCP, CLS, FID, INP) now initializes at app startup"
      },
      {
        "text": "Uncaught JS errors and unhandled promise rejections captured automatically"
      },
      {
        "text": "Telemetry starts before auth/CSRF — covers login page performance"
      },
      {
        "text": "Events buffered in-memory and flushed via keepalive fetch (survives page unloads)"
      },
      {
        "text": "Data flows to POST /api/v1/metrics/frontend (no auth, rate-limited)"
      }
    ],
    "type": "feat",
    "authors": [
      "John Moises Paunlagui"
    ],
    "coAuthors": [
      "Claude Opus"
    ],
    "createdAt": "2026-06-30T09:10:48.868Z",
    "updatedAt": "2026-06-30T09:10:48.868Z"
  },
  {
    "id": "770b5810-989b-42c1-a240-a6e07911098f",
    "displayDate": "2026-07-01",
    "version": "1.0.0-dev.23",
    "title": "Snowflake Request IDs and Inline Error Alerts",
    "message": "Every API response now includes a unique, time-sortable Request ID that appears inline alongside error messages — making it easy to report issues and correlate them with server logs.",
    "whatChanged": [
      {
        "text": "Replaced random request IDs with Snowflake IDs (Timestamp-MachineID-Sequence format)",
        "items": [
          "Time-sortable, deconstructable, collision-free across distributed instances",
          "Zero external dependencies — fully compatible with PKG compilation",
          "Configurable via SNOWFLAKE_MACHINE_ID environment variable"
        ]
      },
      {
        "text": "Every API response (success and error) now includes a requestId field",
        "items": [
          "Also available in the X-Request-ID response header"
        ]
      },
      {
        "text": "API errors now display as persistent inline alerts instead of auto-dismissing toasts",
        "items": [
          "Positioned near the failed action (above submit buttons, below form fields)",
          "Includes a copyable Request ID for support correlation",
          "Applied to Login, Change Password, Admin Management, and Changelog modals"
        ]
      },
      {
        "text": "Added Request ID column to the Audit Log table with search support"
      },
      {
        "text": "Audit log endpoints now use parameterized route patterns (consistent with RED Metrics)"
      },
      {
        "text": "Background operations (exports, deletes) retain toast notifications where no inline area exists"
      }
    ],
    "type": "feat",
    "authors": [
      "John Moises Paunlagui"
    ],
    "coAuthors": [],
    "createdAt": "2026-07-01T00:20:30.228Z",
    "updatedAt": "2026-07-01T00:20:30.228Z"
  },
  {
    "id": "ef5f5c55-3815-4b76-8110-927d280ef4c4",
    "displayDate": "2026-07-01",
    "version": "1.0.0-dev.24",
    "title": "Visually Distinct Snowflake Request IDs",
    "message": "Request IDs now show a random tail segment instead of always ending in 0000, making each ID immediately distinguishable at a glance.",
    "whatChanged": [
      {
        "text": "Request ID tail segment now mixes a crypto-random nonce with the internal sequence counter",
        "items": [
          "Before: 0078801085196-0448-0000 (always 0000)",
          "After:  0078801367094-0448-8401 (random per request)"
        ]
      },
      {
        "text": "Same-millisecond burst uniqueness still guaranteed by the sequence"
      },
      {
        "text": "Updated Snowflake test suite to verify nonce distribution and range"
      }
    ],
    "type": "patch",
    "authors": [
      "John Moises Paunlagui"
    ],
    "coAuthors": [],
    "createdAt": "2026-07-01T01:33:03.288Z",
    "updatedAt": "2026-07-01T01:33:03.288Z"
  },
  {
    "id": "5490f376-b2a4-4ed6-bbd4-90359a29d30f",
    "displayDate": "2026-07-01",
    "version": "1.0.0-dev.25",
    "title": "Fully Inline Error Display",
    "message": "All error notifications now appear as persistent inline alerts near the failed action — no more auto-dismissing toasts. Each error includes a copyable Request ID for support correlation.",
    "whatChanged": [
      {
        "text": "Eliminated all remaining error toasts across Admin Management,",
        "items": [
          "Log Retention, Trace Modal, and Version History"
        ]
      },
      {
        "text": "Validation errors (e.g. \"Please select an employee\") now display",
        "items": [
          "inline above the submit button instead of as a fleeting toast"
        ]
      },
      {
        "text": "API errors in the Delete Logging stepper show inline with Request ID"
      },
      {
        "text": "Trace Modal export errors display in the modal footer"
      },
      {
        "text": "Version History fetch errors display at page level with Request ID"
      },
      {
        "text": "Error toasts are now fully reserved for success messages only"
      }
    ],
    "type": "refactor",
    "authors": [
      "John Moises Paunlagui"
    ],
    "coAuthors": [],
    "createdAt": "2026-07-01T01:52:29.498Z",
    "updatedAt": "2026-07-01T01:52:29.498Z"
  },
  {
    "id": "afff8915-9c09-4597-b459-5e57a39b71c5",
    "displayDate": "2026-07-01",
    "version": "1.0.0-dev.26",
    "title": "Project Catherine Home Page & Live Security Demo",
    "message": "New landing page introduces Project Catherine with a live interactive security demo that fires real attack payloads against the backend. Fixed a critical gap where SQL injection in query strings was undetected.",
    "whatChanged": [
      {
        "text": "Added 10-section Glasswing-inspired home page at /home",
        "items": [
          "Hero, introduction, threat landscape, architecture, tech stack",
          "Security benchmarks, roadmap, FAQ, sources & references"
        ]
      },
      {
        "text": "Added live security demo with 36 real attack scenarios",
        "items": [
          "Grouped by 11 categories: Injection, XSS, Traversal, Scanner, Auth, CSRF, RCE, etc.",
          "Fires actual HTTP requests — shows real status codes, headers, and response bodies"
        ]
      },
      {
        "text": "All threat statistics sourced from authoritative reports (IBM, NIST NVD, Verizon DBIR)"
      },
      {
        "text": "Fixed SecurityFilterMiddleware not scanning query strings (CWE-20)",
        "items": [
          "Added 22 injection detection patterns (SQLi, XSS, command injection, LDAP)",
          "Injection payloads in ?query=params now blocked with 403"
        ]
      },
      {
        "text": "Extracted home page into 13 sibling components (641 → 88 lines in view)"
      }
    ],
    "type": "security",
    "authors": [
      "John Moises Paunlagui"
    ],
    "coAuthors": [],
    "createdAt": "2026-07-01T04:10:52.569Z",
    "updatedAt": "2026-07-01T04:10:52.569Z"
  },
  {
    "id": "22bca4f4-849a-4582-9dc6-13660c086aff",
    "displayDate": "2026-07-01",
    "version": "1.0.0-dev.27",
    "title": "Pre-Deploy Security Hardening",
    "message": "Comprehensive security hardening pass addressing 15 findings from a full-stack audit. The server now refuses to start with placeholder secrets, JWT forgery vectors are closed, and the live security demo no longer blocks real visitors.",
    "whatChanged": [
      {
        "text": "Added fail-fast boot guard — server exits immediately in production when secrets are still set to template placeholders (C1)",
        "items": [
          "Covers JWT_SECRET, CSRF_SECRET, COOKIE_SECRET, ARGON2_PEPPER, DATA_SIGNING_SECRET, CHANGELOG_ENCRYPTION_KEY",
          "Also blocks DEMO_MODE=true in production (M4)"
        ]
      },
      {
        "text": "Wired TRUST_PROXY env to app.set('trust proxy') so req.ip reflects the real client behind a reverse proxy (H1)"
      },
      {
        "text": "Cookies now force Secure flag in production even when USE_HTTPS=false, supporting TLS-terminating proxy deployments (H2)"
      },
      {
        "text": "Login and admin fields reject object-typed values, blocking Mongo-style operator injection like {\"$regex\":\".*\"} (H3)"
      },
      {
        "text": "Live security demo returns simulated responses in production builds, preventing visitors from self-blocking their IP (H4)"
      },
      {
        "text": "Response body capture skips SSE streams and caps at 64 KiB to prevent memory exhaustion on long-lived connections (M2)"
      },
      {
        "text": "Removed duplicate unprotected /dashboard route that shadowed the role-guarded one (M3)"
      },
      {
        "text": "Pinned HS256 algorithm on all JWT sign/verify calls (L1)"
      },
      {
        "text": "SecurityFilterMiddleware now double-decodes URLs to catch %25-encoded bypass attempts (L2)"
      },
      {
        "text": "Public /health endpoint no longer exposes hostname, PID, or environment (L3)"
      },
      {
        "text": "PII fields (email, name, phone, DOB) added to request log redaction list (L4)"
      },
      {
        "text": "Implemented missing _validateRole and _rejectDefaultPassword helpers in AdminManagementService (I1)"
      },
      {
        "text": "Frontend npm audit fix: 6 → 2 advisories"
      }
    ],
    "type": "security",
    "authors": [
      "John Moises Paunlagui"
    ],
    "coAuthors": [
      "Claude Opus"
    ],
    "createdAt": "2026-07-01T05:36:08.305Z",
    "updatedAt": "2026-07-01T05:36:08.305Z"
  }
];

// ─── Main ─────────────────────────────────────────────────────────────────────

const LINE = "─".repeat(55);

async function main() {
    console.log(`\n${LINE}`);
    console.log(`  seed-changelog — reset the changelog store`);
    console.log(`${LINE}`);
    console.log(`  Entries to write : ${SEED_ENTRIES.length}`);
    console.log(
        `  Date range       : ${SEED_ENTRIES[0].displayDate} → ${SEED_ENTRIES[SEED_ENTRIES.length - 1].displayDate}`,
    );
    console.log(`${LINE}\n`);

    process.stdout.write("  Writing encrypted store ... ");
    const count = ChangelogModel.resetStore(SEED_ENTRIES);
    console.log("done.\n");

    console.log(`${LINE}`);
    console.log(`  Changelog seeded successfully!`);
    console.log(`${LINE}`);
    console.log(`  Entries written : ${count}`);
    console.log(`  Store location  : data/changelog.enc`);
    console.log(`${LINE}\n`);
}

main().catch((err) => {
    console.error("\n  Seed failed:", err.message || err);
    if (process.env.NODE_ENV !== "production") {
        console.error(err.stack);
    }
    process.exit(1);
});
