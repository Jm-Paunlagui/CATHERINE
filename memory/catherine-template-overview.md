---
name: catherine-template-overview
description: What the CATHERINE template is, its monorepo layout, and where the real docs live
metadata:
  type: project
---

CATHERINE is a full-stack **boilerplate/template** monorepo at `C:\Users\johnm\WebRepo\CATHERINE`. Two halves:

- `Backend/` — Node.js + Express v5, class-based OOP, OracleDB. Internal package name `backend` (description "MEAL Backend API"). Origin repo: `github.com/Jm-Paunlagui/NodeExpress-Template`.
- `Frontend/` — React 19 + Tailwind v4, the **Aumovio Design System v3.1**. Internal package name `frontend`, version 1.18.1.

Key orientation facts (not obvious from a casual look):

- **`ReadMe.md` at root** was empty (0 bytes) until 2026-06-14, now holds the project showcase (security/perf/Mira/personalization). The deep technical documentation lives in two large CLAUDE.md files:
  - `Backend/CLAUDE.md` (~1992 lines) — architecture rules + full server testing guide.
  - `Frontend/Claude.md` (~1358 lines; note disk casing `Claude.md`) — Aumovio component map, design tokens, feature workflow, animation system.
- Template is **additive boilerplate** — foundational commit is 399 files (Backend 188, Frontend 189, plus `.claude` tooling). Nothing app-specific shipped.
- The `.claude/skills/aumovio-fullstack-engineer` skill encodes the engineering discipline for this template (13 specialisations).
- License: root `LICENSE`; backend package.json says ISC. `oracle-mongo-wrapper` is Apache 2.0 © 2026 John Moises Paunlagui.

See [[catherine-stack-versions]], [[catherine-backend-conventions]], [[catherine-frontend-conventions]].
