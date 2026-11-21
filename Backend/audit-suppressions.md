# Backend dependency audit — accepted advisories

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

- `qs` (GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g) — resolved; `qs` under `express@5` was
  already at 6.16.1 in the last npm lockfile, so this row was stale.

---

## Verifying this file is still accurate

```bash
cd Backend
bun audit                 # every reported advisory should appear above
bun audit --prod          # production-only view — this is the one that gates a release
```

If `bun audit` reports a package **not** listed here, it is unreviewed — triage
it, do not assume it is covered. Record: package, installed version, advisory,
severity, vulnerable range, fix availability, **reachability analysis**,
decision, and a re-evaluation date.
