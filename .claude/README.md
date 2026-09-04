# Agent Fleet

A fleet of 41 specialist agents and 37 skills for Claude Code. Each agent is a narrow expert with explicit constraints, a defined output format, and a rule against working outside its specialisation.

The point is not that Claude gets smarter. It is that work gets **routed to a specialist with the right constraints**, hands off through a defined contract, and reports back in a format the next agent can act on.

---

## Quick start

**You do not need to name an agent.** Describe the task; Claude matches it to one from the agent descriptions.

```
Add a route to list active kiosk terminals
        → senior-nodejs-engineer

Why is this form not showing the validation shake?
        → senior-react-qa-engineer

Is this query injectable?
        → senior-oracle-engineer
```

**When work spans more than one specialisation**, ask for the orchestrator by name:

```
Use project-manager-architect to plan the terminal-location feature end to end
```

It returns a dispatch plan — work units, who owns each, what runs in parallel, the contract at every boundary, and the definition of done. It writes no code; you run its plan.

**When a decision is expensive to reverse**, run the planner first:

```
Have senior-react-engineer-planner plan this, then the executor implement it
```

---

## The three agent shapes

Each exists because the cost of a wrong decision differs. **Do not normalise them into one shape.**

| Shape | Model | Writes code | Use when |
| ----- | ----- | ----------- | -------- |
| **Paired builder** — planner then executor | Opus → Sonnet | Executor only | The decision is costly to reverse: architecture, schema, data split, serving topology |
| **Single-pass specialist** | Opus | Some | The output *is* the analysis: a review, an audit, a design, a test suite |
| **Single-pass builder** | Opus | Yes | Language-level work, where the decisions worth planning belong to another specialisation |

---

## Roster

### Paired builders — 12 planner/executor pairs

| Domain | Planner | Executor |
| ------ | ------- | -------- |
| React frontend | `senior-react-engineer-planner` | `senior-react-engineer` |
| Next.js App Router | `senior-nextjs-engineer-planner` | `senior-nextjs-engineer` |
| Node.js / Express | `senior-nodejs-engineer-planner` | `senior-nodejs-engineer` |
| OracleDB | `senior-oracle-engineer-planner` | `senior-oracle-engineer` |
| MongoDB | `senior-mongodb-engineer-planner` | `senior-mongodb-engineer` |
| C# / .NET | `senior-csharp-engineer-planner` | `senior-csharp-engineer` |
| Docker / Kubernetes | `senior-docker-kubernetes-engineer-planner` | `senior-docker-kubernetes-engineer` |
| Data analytics / ELT | `senior-data-analytics-engineer-planner` | `senior-data-analytics-engineer` |
| Machine learning | `senior-machine-learning-engineer-planner` | `senior-machine-learning-engineer` |
| Deep learning | `senior-deep-learning-engineer-planner` | `senior-deep-learning-engineer` |
| LLM systems | `senior-llm-engineer-planner` | `senior-llm-engineer` |
| AI productionisation | `senior-ai-engineer-planner` | `senior-ai-engineer` |

### Single-pass specialists — 13

`senior-uiux-designer` · `senior-cybersecurity-engineer` · `code-reviewer-cwe-cve` · `senior-react-qa-engineer` · `senior-nextjs-qa-engineer` · `senior-nodejs-qa-engineer` · `senior-csharp-qa-engineer` · `senior-test-engineer` · `senior-accountant-mba` · `senior-code-documentation-engineer` · `senior-chaos-resilience-engineer` · `senior-performance-engineer` · `senior-anti-pattern-auditor`

### Single-pass builders — 3

`senior-python-engineer` · `senior-go-engineer` · `senior-rust-engineer`

### Orchestrator — 1

`project-manager-architect`

---

## The AI group's four seams

These four overlap in casual language and must be routed on **what the work is**, not which buzzword was used:

| The work is… | Owner |
| ------------ | ----- |
| Features, splits, leakage, metrics on tabular data | `senior-machine-learning-engineer` |
| Training a neural network — architecture, loop, GPU | `senior-deep-learning-engineer` |
| Building **on** a hosted model — prompts, RAG, evals | `senior-llm-engineer` |
| Getting **any** model into production — serving, drift, rollback | `senior-ai-engineer` |

**LLM builds on a model; AI operates a model.** A RAG pipeline's chunking is LLM work; the same pipeline's deployment and rollback is AI work.

All four write Python, and `senior-python-engineer` owns **none** of their decisions — it owns typing, packaging, async correctness, and test structure. A training loop's correctness is Deep Learning; that script's dependency pinning is Python.

---

## Skills

Skills carry the discipline; agents are the short form that invokes them. They load automatically when a task matches. Four are invoked directly:

| Command | Does |
| ------- | ---- |
| `/fleet-init` | Point the fleet at a new repo, or re-verify a stale profile |
| `/commit-log` | Conventional Commit messages plus a changelog entry |
| `/feature-docs` | End-to-end feature documentation with Mermaid diagrams |
| `/caveman` | Compressed output mode (`lite`, `full`, `ultra`) |

---

## Portability — the project profile

**The fleet adapts to any project without editing a single skill.**

Skills carry *discipline*, which is portable. One file carries *project facts*, which are not:

```
skills/project-manager-architect/references/project-profile.md
```

It holds the surfaces, stacks, verified entry points, where each fact's authority lives, and **which agents have no target in this repo**. Point the fleet somewhere new by replacing that one file.

### Authority order

Every skill states this, and it is the rule that keeps agents honest:

> **the code** > the project's `CLAUDE.md` > the profile > the skill

Lower sources tell you where to look. They are **never evidence for a defect report**. Every profile records real cases where a project's own documentation disagrees with its code — because that is common, not hypothetical.

### Applicability

The profile marks agents with no target here as **not applicable**, and the orchestrator is told never to dispatch them. The reason is specific:

> An agent pointed at a stack this project does not have will not report "not applicable" — it will find something to say.

---

## Porting to a new repo

1. Copy `.claude/` into the repo.
2. Run `/fleet-init`. It detects surfaces from manifests, reads stacks from dependencies, **opens** entry points rather than guessing them, locates fact authorities, and writes the profile.
3. Check the applicability table.
4. **Edit no skill.** If a project fact seems to need a skill edit, that is a design defect in the skill — the fact belongs in the profile.

Portable with zero changes: the AI group, the language agents, performance, chaos, accountant, docker-kubernetes, and every shared reference.

---

## Multiple copies

Several repos may each hold a copy. They drift, silently.

- `agents/` and `skills/*/SKILL.md` **should be identical** across copies. A difference is drift.
- `project-profile.md` **must differ**. Two repos with identical profiles means one is describing the other's codebase, and its paths are wrong.

```bash
diff -r -q --exclude=project-profile.md <copyA>/.claude <copyB>/.claude
```

Pick one copy as canonical for discipline. Propagating an improvement means copying everything **except** each repo's own profile. `/fleet-init` in doctor mode reports both drift and stale profiles.

---

## Shared references

Cross-cutting knowledge lives in `references/` under its owning skill, and siblings link to it. One source, no duplication.

| Reference | Owner | Carries |
| --------- | ----- | ------- |
| `collaboration-protocol.md` | project-manager-architect | Dispatch-prompt contract, interface shapes per boundary, escalation format, what each shape reports, collision boundaries, gate order |
| `project-profile.md` | project-manager-architect | Which project the fleet points at |
| `project-profile.template.md` | project-manager-architect | Blank profile for a new repo |
| `severity-and-findings.md` | code-reviewer-cwe-cve | Severity scale, finding format, evidence rules, what is *not* a finding |
| `cwe-catalog.md` · `cve-methodology.md` · `owasp-top10.md` · `secure-development.md` | senior-cybersecurity-engineer | CWE catalog, CVSS/EPSS/KEV, OWASP Top 10s, SAST/DAST/threat modeling |
| `mermaid-diagrams.md` | feature-docs | Diagram selection and embedding |

---

## The rules that make it work

**Every agent sees only the prompt written for it** — not the plan, not the other units, not this conversation. Contracts get pasted into a dispatch prompt, never referenced.

**Escalate, do not improvise.** Work crossing a specialisation boundary stops. The agent names what is needed, names the discipline that owns it, reports what it finished, and leaves the rest. An escalation is a new work unit, not a failure.

**Verify before asserting.** No agent reports a defect on the strength of a remembered or documented fact. It opens the code first.

**Two agents in one file is worse than a gap.** A gap is visible; a collision produces plausible conflicting work that passes review. The collision boundaries are written down.

**Never report done from a plan.** Done means the executor confirmed it landed.

**Gate order:** build → QA → tests → security → docs. QA output *is* the test gate's scope. Dropping a gate is allowed; dropping it silently is not.

---

## Layout

```
.claude/
├── README.md
├── agents/                        41 × <name>.agent.md
└── skills/
    ├── <discipline>/SKILL.md      29 disciplines, one per agent specialisation
    ├── fleet-init/SKILL.md        point the fleet at a repo / doctor mode
    ├── commit-log/ feature-docs/  workflow skills
    ├── caveman*/                  output-compression modes
    ├── project-manager-architect/references/
    │       collaboration-protocol.md, project-profile.md,
    │       project-profile.template.md
    ├── code-reviewer-cwe-cve/references/severity-and-findings.md
    └── senior-cybersecurity-engineer/references/
            cwe-catalog.md, cve-methodology.md,
            owasp-top10.md, secure-development.md
```

Agents and skills register at session start. **After adding or renaming one, restart the session** — an unregistered agent cannot be dispatched, and its skill cannot be invoked.
