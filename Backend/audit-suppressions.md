# Backend dependency audit — accepted advisories

Every entry here is an advisory that `npm audit` reports and that we have
consciously triaged. The order of preference is **upgrade > patch > vendor
mitigation > suppress**. An entry reaches "suppress" only after the first three
are ruled out, and must record the reachability analysis that justified it.

This file is deliberately not empty-and-missing. A register that is *known* to be
current is a different artifact from no register at all: it records that the
audit was run, on what date, and what was decided.

Last reviewed: **2026-09-03**

---

## Current status: 1 open advisory (patch available, not yet applied)

```
npm audit --omit=dev  -> 1 moderate  (qs)
npm audit             -> 1 moderate  (qs)
```

| Package | Severity | Vulnerable range | Advisory | Fix |
| --- | --- | --- | --- | --- |
| `qs` | moderate | 2.2.5 – 6.15.3 | GHSA-x5fp-wj9c-mxmx (array-limit bypass via bracket-key comma parsing), GHSA-4mjr-xmp4-gh2g (DoS via attacker-controlled isBuffer) | `npm audit fix` (non-breaking patch available) |

**Reachability:** `qs` is the query-string parser pulled in transitively under
`express@5`. It IS on a reachable path (every request query string is parsed),
so this is not a candidate for suppression — it is a **patch pending**. The fix
is a non-breaking `npm audit fix`, deferred to the next dependency-maintenance
pass so it lands with a full-suite re-run rather than mid-feature.

**Decision:** APPLY at next maintenance (`npm audit fix`), then delete this row.
Not suppressed. **Re-evaluate by: 2026-10-03.**

Mitigations already in place that reduce the practical risk in the meantime:
- `BODY_LIMIT` caps request body size; `RATE_LIMIT_MAX` caps request volume.
- Express's default query parser depth is bounded; the app does not build
  deeply-nested queries from untrusted input.

---

## Verifying this file is still accurate

```bash
cd Backend
npm audit                 # every reported advisory should appear above
npm audit --omit=dev      # production-only view — this is the one that gates a release
```

If `npm audit` reports a package **not** listed here, it is unreviewed — triage
it, do not assume it is covered. Record: package, installed version, advisory,
severity, vulnerable range, fix availability, **reachability analysis**,
decision, and a re-evaluation date.
