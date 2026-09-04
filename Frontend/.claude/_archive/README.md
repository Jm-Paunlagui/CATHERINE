# Archive

Retired configuration. Nothing here is loaded by Claude Code — this directory sits outside `agents/` and `skills/` on purpose.

## `aumovio-fullstack-engineer.agent.md.bak`

Archived 2026-09-04. The original 55KB monolithic agent that unified thirteen specialisations into one voice.

**Superseded by** the 26-agent fleet in `../agents/`: seven Opus-planner / Sonnet-executor builder pairs, eleven single-pass Opus specialists, and `project-manager-architect` as the orchestrator. Every specialisation it contained now lives in its own agent file with a paired skill in `../skills/`.

**Why archived rather than deleted:** its `description` field carried six `<example>` delegation blocks that loaded into every session's context. Nothing pointed into it and nothing unique remained in it — the four security reference files it owned were moved to `../skills/senior-cybersecurity-engineer/references/`, and the CWE rules and CVE discipline it held were restored into that skill.

**The `.bak` extension is load-bearing.** Claude Code discovers agents by scanning `agents/**/*.md`, so a subdirectory would not have stopped it loading. Keep the extension if you move this file.

**To restore:** copy back to `../agents/aumovio-fullstack-engineer.md`. Note that its frontmatter uses the pre-fix schema (`tools:` as a YAML list of `read, edit, search, execute`, and `model: "Claude Sonnet 5"`) — both are invalid and would need the same corrections applied to the rest of the fleet.

## `aumovio-fullstack-engineer.skill/SKILL.md.bak`

Archived 2026-09-04, alongside the agent. The 50KB unified skill behind the monolith.

**Superseded by** the nineteen specialisation skills in `../skills/`.

**Why archived:** it was redundant with the split skills, and its description ended with *"Bias toward triggering: under-triggering this skill is more costly than over-triggering"* — which made it win requests ahead of the focused skills built to replace it, pulling ~50KB into context each time.

**Its four security reference files are not here.** They were moved to `../skills/senior-cybersecurity-engineer/references/`, which is now their permanent home. The links inside this `.bak` point there and still resolve.

**To restore:** copy to `../skills/aumovio-fullstack-engineer/SKILL.md`. Consider dropping the trigger-bias line first, or it will shadow the specialisation skills again.
