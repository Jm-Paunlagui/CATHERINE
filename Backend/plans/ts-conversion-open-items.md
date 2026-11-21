# Backend TypeScript conversion — open items

Branch `backend-rewrite-to-typescript` (PR #4, open, not merged). Status as of 2026-11-21.

## 1. Before merge

- [ ] **CI on PRs.** The only workflow (`.github/workflows/verify-changelog-release.yml`) runs on tags, so nothing checks a PR. Add one that runs `bun run typecheck`, `bun run lint` and `bun run test`.
- [x] **CSRF body token.** Since the typing pass fixed the misspelt `getCsrfTokenFromRequest` option, a token sent in the request body is accepted. Add an integration test that posts the token in the body.
- [ ] **Windows server (owner).** Run the exe, stop it through WinSW, then test Thick mode with the Instant Client and test clustering. The TypeScript build has only been run on macOS.
- [x] PR #4 description covers the wrapper commit `2758c0d`.
- [x] **Changelog entry `1.0.0-dev.53`** for the wrapper fixes (G1–G4). CATHERINE is still at `1.0.0-dev.52`.

## 2. Follow-up PRs (after merge)

- [ ] **G18:** `updateOne({})`, `replaceOne({})` and `deleteOne({})` build `… t0  AND ROWNUM = 1`, which is invalid SQL. See `oracle-wrapper-gap-inventory.md`.
- [ ] **Remaining `any`:** 550 `: any`, 172 `Record<string, any>`, 49 `any[]`, 1 `as any`. Most of it is in `metricsMerge.ts` (71), `OracleCollection.ts` (24), `AlertNotifierService.ts` (24), `ClusterRpcHub.ts` (23) and `oracle.ts` (22). The wrapper's filter operands may stay `any`; the rest is typeable debt.
- [ ] **Port to TypeScript:** `scripts/` (7 files), `test/` (109 files) and the root configs (`eslint.config.js`, `vitest*.config.js`). This removes `require(...).default` from tests.
- [ ] **Frontend** TypeScript conversion (not started).
- [ ] **TypeScript 7** once typescript-eslint supports it (currently pinned `~6.0`).
- [ ] **Wrapper backlog G5–G17** (`oracle-wrapper-gap-inventory.md`).

## Known flaky tests

- `shutdownGate.perf` and `scanner-blocking` occasionally fail under full-suite load and pass when rerun.
