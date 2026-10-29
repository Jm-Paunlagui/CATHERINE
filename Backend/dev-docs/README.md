# CATHERINE — Developer Documentation Index

Technical documentation for the CATHERINE template platform, organized to mirror
the application's **role-based navigation** (`Frontend/src/components/layout/config/nav.config.jsx`).
Each folder below is a nav **group**; each file documents a nav **item** (or a
cross-cutting concern under `Others`).

> Diagrams in these docs are fenced ` ```mermaid ` blocks — they render in
> GitHub, GitLab, Obsidian, VS Code's Markdown preview, **and in the in-app
> viewer** (Support → Dev Docs). For PDF via Chrome print, pre-render with
> `mermaid-cli` (`mmdc`) to SVG/PNG first.

> **Repository layout.** One repo, two surfaces: `Backend/` and `Frontend/`.
> Every path in this corpus is written from one of those two roots.
>
> **Index verified 2026-10-28 (template re-sync).** Every link below resolves to
> a file on disk (13 documents + this README, 3 section folders). Plans and
> working notes are **not** part of this corpus: they live in the repo-root
> `plans/` and `docs/` folders and are not served by the viewer.
>
> **Template re-sync caveat.** The 13 documents were imported from a downstream
> product app during the 2026-10-28 re-sync. Their platform behaviour applies to
> this template, but several still carry the source app's wording (repo names,
> pool names, product tables and screens). Where a document disagrees with the
> code, **the code and `Backend/CLAUDE.md` win**. The per-document rewrite is
> tracked in `plans/template-reimport-handover.md`.

---

## How this corpus is served

These files are readable inside the app at **Support → Dev
Docs** (`/support/dev-docs`), ADMIN and SUPER_ADMIN only (`GET /api/v1/dev-docs/{tree,search,doc/:section/:name}`). The corpus is **served
from the backend at request time, never copied into the frontend bundle** — a
bundled or `public/` copy would be a static asset with no auth check, and would
be a second copy to drift. See
[`Support/dev-docs-viewer-documentation.md`](Support/dev-docs-viewer-documentation.md).

Two consequences for anyone editing these files:

- **A new `.md` file needs no code change to appear.** It shows up once the
  service's 5-minute manifest TTL expires.
- **Root-level files (this README) are served under a synthetic `Overview`
  section**, mapped in the freshness map to `DevDocsService.js` — see below.

---

## Folder → Nav mapping

### System Admin (nav group "System", SUPER_ADMIN)
| Nav item | Doc |
|---|---|
| Logging & Observability (`/system/logging-and-observability`) | [`System Admin/logging-observability-documentation.md`](System%20Admin/logging-observability-documentation.md) |
| Metrics (`/system/metrics`) | [`System Admin/metrics-alerting-documentation.md`](System%20Admin/metrics-alerting-documentation.md) |
| Admin Management (`/system/admin-management`) | [`System Admin/admin-management-documentation.md`](System%20Admin/admin-management-documentation.md) |
| Data Integrity (`/system/data-integrity`) | [`System Admin/data-integrity-documentation.md`](System%20Admin/data-integrity-documentation.md) |
| Data Purge (`/system/data-purge`) | [`System Admin/data-management-documentation.md`](System%20Admin/data-management-documentation.md) |

### Support
| Nav item | Doc |
|---|---|
| Version History (`/about/changelog`, under Reference) | [`Support/changelog-release-train-documentation.md`](Support/changelog-release-train-documentation.md) |
| **Dev Docs** (`/support/dev-docs`, ADMIN + SUPER_ADMIN) | [`Support/dev-docs-viewer-documentation.md`](Support/dev-docs-viewer-documentation.md) — the viewer serving this corpus |
| **Architecture** (`/support/architecture`, SUPER_ADMIN) | [`Support/architecture-documentation.md`](Support/architecture-documentation.md) — interactive system map + request flows |
| **Runtime** (`/support/runtime`, SUPER_ADMIN) | [`Support/runtime-documentation.md`](Support/runtime-documentation.md) — how the server schedules, backs up, protects itself and shuts down |
| Help (`/about/help`, under Reference) + global Help Assistant | [`Support/help-center-documentation.md`](Support/help-center-documentation.md) |

### Others (cross-cutting / not a single nav item)
| Concern | Doc |
|---|---|
| Personalize | [`Others/personalize-documentation.md`](Others/personalize-documentation.md) |
| Authentication (login/refresh/logout/change-password) | [`Others/auth-documentation.md`](Others/auth-documentation.md) |
| Infrastructure (health, CSRF, client errors) | [`Others/infrastructure-health-csrf-client-documentation.md`](Others/infrastructure-health-csrf-client-documentation.md) |

---

## Freshness — what the badge in the viewer means

`DevDocsService` compares each document's last commit date against the newest
commit date across the source paths its **section** is mapped to
(`SECTION_SOURCE_MAP`), and reports one of three states:

| State | Meaning |
|---|---|
| `CURRENT` | The doc was committed at or after the code it describes. |
| `SUSPECT` | The code moved after the doc did. **It may still be accurate** — many commits to a service do not touch what its documentation claims. It means *worth checking*, not *wrong*. |
| `UNKNOWN` | No commit history for the doc, or its section is not in the map. **Not evidence of currency.** |

The mapping is deliberately coarse — section-level, not per file.

Current map (`Backend/src/services/DevDocsService.js`):

| Section | Sources |
|---|---|
| `System Admin` | `DataPurgeService`, `BackupStoreService`, `AdminManagementService`, `IntegrityService`, `AuditLogService`, `MetricsService` |
| `Support` | `ChangelogService`, `ArchitectureService`, `constants/architectureModel`, `constants/runtimeModel`, `utils/systemMap`, `DevDocsService` |
| `Others` | `AuthService`, `routes/health.route`, `CsrfMiddleware`, `ClientService` |
| `Overview` (root files such as this README) | `DevDocsService` |

> ⚠ **Known limit.** `Others/personalize-documentation.md` documents
> `Frontend/src/features/personalize/` and has **no backend at all**, while
> freshness compares against backend sources only. It inherits the `Others` date,
> which cannot speak to it. The `> **Verified …**` blocks in each document's
> header remain the authoritative record of what was re-checked.
>
> A build step (`scripts/build-devdocs-freshness.js`, run by `npm run build`)
> precomputes the freshness index for the PKG artefact, where git is unavailable.

**When you update a doc, add a `Verified` block** to its header blockquote in
the house style, e.g.:

```
> **Verified 2026-10-28 (template re-sync).** Re-checked against
> AdminManagementService. §5's route table gained one row; everything else was unchanged.
```

"No drift; no edits required" is a valid and valuable outcome — say so rather
than leaving the reader unable to tell a checked doc from an unchecked one.

### House format — and it is enforced

Every feature document follows the same shape, so a reader can navigate any of
them without relearning the layout:

```
# <Feature> — Technical Documentation

> **Scope:** <what this document covers>
> **Source:** <the FE and BE paths it describes>
> Generated <date>. <rendering note>
>
> **Verified <date> (<what was re-checked>).** <what changed, or "no drift">

## 1. Overview            ## 5. How frontend and backend connect (the contract)
## 2. Flow & Architecture ## 6. Technicalities
## 3. Frontend implementation  ## 7. Security
## 4. Backend implementation   ## 8. Verification Q&A
```

`Scope` and `Source` are **bolded labels on their own lines** — not prose, and
`Source` is never folded into the Scope sentence. One H1 per file.

> The source app enforced this shape with a frontend `docsFormat` test. That
> test was **not** carried into this template (`Frontend/test/` has no
> `devdocs` suite), so the format is a convention here, not a gate.

**The one exception is declared, not exempted.**
`Others/infrastructure-health-csrf-client-documentation.md` covers three
independent features and is structured **Part A / B / C**, each Part carrying its
own numbering (`A.1` Overview, `A.2` Flow & Architecture, …). It therefore has no
single §5 or §6. The document says so in its header, so the
departure reads as a decision rather than an oversight. Splitting it into three
was considered and rejected: health, CSRF and client error reporting are each too
small to carry a document, and a reader arrives at all three together.

`README.md` is an index, not a feature document, and carries no §1–8 skeleton by design.

### Diagrams — check them by eye

Diagrams are data read off disk at runtime, so nothing in the toolchain parses
them — not ESLint, not the build, and (in this template) no mermaid corpus test.
Preview every edited fence in the in-app viewer before committing. The two
traps worth knowing:

- **`;` ends a statement** in `sequenceDiagram` and is invalid in a
  `stateDiagram-v2` label. Write `,` in prose inside a label.
- **`[{` opens a shape**, so a `{` in a node label must be quoted:
  `ENC["{ iv, authTag }"]`, not `ENC[{ iv, authTag }]`.

---

## Documentation gaps (audited 2026-10-28)

**Open:**

- **Imported wording.** All 13 documents still describe the source app in
  places (repo names, pool names, product tables, screens that do not exist
  here). Rewrite per document against the code; until then the code and
  `Backend/CLAUDE.md` are authoritative.
- **No dedicated doc** for Dashboard (`/dashboard`), Home (`/home`) or the
  Reference pages (`/about/*`: Getting Started, Database Connection, Mira ORM,
  Money, CORS Setup). Platform-level docs for money, caching, RBAC and the
  wrapper live in the repo-root `docs/features/`.
- **No frontend dev-docs test suite** (format lint, mermaid corpus parse) in
  this template; see the two sections above.

---

_End of document. Updated 2026-10-28._
