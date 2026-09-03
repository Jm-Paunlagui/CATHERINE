# Frontend dependency audit — accepted advisories

Every entry here is an advisory that `npm audit` reports and that we have
consciously triaged. The order of preference is **upgrade > patch > vendor
mitigation > suppress**. An entry reaches "suppress" only after the first three
are ruled out, and must record the reachability analysis that justified it.

This file is deliberately not empty-and-missing. A register that is *known* to be
current is a different artifact from no register at all: it records that the
audit was run, on what date, and what was decided.

Last reviewed: **2026-09-03**

---

## Current status: 2 production advisories, 1 additional dev-only

```
npm audit --omit=dev  -> 2 moderate  (uuid via exceljs)
npm audit             -> 3 moderate  (+ @humanfs/node, dev-only)
```

| Package | Severity | Vulnerable range | Advisory | Fix | Path |
| --- | --- | --- | --- | --- | --- |
| `uuid` | moderate | < 11.1.1 | GHSA-w5hq-g745-h8pq — missing buffer bounds check in v3/v5/v6 **when `buf` is provided** | `npm audit fix` (patch available) | transitive under `exceljs` |
| `exceljs` | moderate | ≥ 3.5.0 | depends on the vulnerable `uuid` above | via the same fix | direct dependency |
| `@humanfs/node` | moderate | < 0.16.8 | GHSA-p498-v437-472g — recursive copy follows symlinks | `npm audit fix` | **dev-only** (under ESLint tooling); absent from `--omit=dev` |

### Reachability

- **`uuid` / `exceljs`** — the `uuid` advisory only triggers when a caller passes
  a pre-allocated `buf` argument to `uuid.v3/v5/v6()` so the write overruns the
  buffer. `exceljs` calls `uuid` with **no `buf`**, so the vulnerable branch is
  unreachable through this dependency. On top of that, `exceljs` in CATHERINE is
  **lazy-imported only by the money/export path** and is dormant until such a
  feature loads it (the `exceljsNoEvalPlugin` in `vite.config.js` even warns that
  no exceljs module was transformed in the current build). A patch is available
  and preferred over suppression: apply `npm audit fix` at the next
  dependency-maintenance pass.
- **`@humanfs/node`** — a **dev-only transitive** under the ESLint toolchain. It
  does not ship in the built bundle and does not appear in `npm audit --omit=dev`
  (the release-gating view). Do not "fix" it by adding a top-level override that
  would pull a build-time dependency into production.

### Decision

- `uuid` / `exceljs`: **APPLY at next maintenance** (`npm audit fix`), then
  delete those rows. Unreachable in the meantime. **Re-evaluate by: 2026-10-03.**
- `@humanfs/node`: **ACCEPTED (dev-only)** — not release-gating. Track with the
  ESLint upgrade cadence. **Re-evaluate by: 2026-10-03.**

---

## Verifying this file is still accurate

```bash
cd Frontend
npm audit                 # every reported advisory should appear above
npm audit --omit=dev      # production-only view — this is the one that gates a release
```

If `npm audit` reports a package **not** listed here, it is unreviewed — triage
it, do not assume it is covered. Record: package, installed version, advisory,
severity, vulnerable range, fix availability, **reachability analysis**,
decision, and a re-evaluation date.
