# Frontend dependency audit — accepted advisories

Every entry here is an advisory that `bun audit` reports and that we have
consciously triaged. The order of preference is **upgrade > patch > vendor
mitigation > suppress**. An entry reaches "suppress" only after the first three
are ruled out, and must record the reachability analysis that justified it.

This file is deliberately not empty-and-missing. A register that is *known* to be
current is a different artifact from no register at all: it records that the
audit was run, on what date, and what was decided.

Last reviewed: **2026-11-21**

---

## Current status: no open advisories

```
bun audit --prod  -> No vulnerabilities found
bun audit         -> No vulnerabilities found
```

Re-checked 2026-11-21 after moving the package manager from npm to Bun (`bun.lock`
replaces `package-lock.json`). Rows closed in that pass:

- `uuid` / `exceljs` (GHSA-w5hq-g745-h8pq) — resolved; `overrides.uuid` pins `^11.1.1`
  (flattened from the npm-style nested override, which Bun does not support).
- `@humanfs/node` (GHSA-p498-v437-472g, dev-only) — resolved by the fresh resolution.
- `follow-redirects` 1.16.1 (GHSA-mrwp-f3q8-3g9p, high, under `axios`) — fixed with
  `bun audit fix` → 1.16.2 (within `axios`'s range).

---

## Verifying this file is still accurate

```bash
cd Frontend
bun audit                 # every reported advisory should appear above
bun audit --prod          # production-only view — this is the one that gates a release
```

If `bun audit` reports a package **not** listed here, it is unreviewed — triage
it, do not assume it is covered. Record: package, installed version, advisory,
severity, vulnerable range, fix availability, **reachability analysis**,
decision, and a re-evaluation date.
