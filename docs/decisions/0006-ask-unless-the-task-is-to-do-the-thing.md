# 0006: Ask unless the task is to do the thing

**Date:** 2026-09-17
**Status:** Accepted

## Context
Sessions and sous chef need a rule for what they may do unattended. Dylan's rule: ask unless the task itself is to do the thing. `/build` and `/orchestrate` are tasks to build and open PRs, so they do that without asking.

## Decision
- Sous chef manages its own memory without asking. It asks before writing to Linear or a repo unless Dylan asked for exactly that.
- A session does what its task names and asks (`needs-decision`) before anything beyond it.
- Always, whatever the task: never merge into `main` or `staging`; merging a sub-branch into a feature branch is fine when the task calls for it; ask before anything destructive, irreversible or outward-facing.

## Consequences
The rule is written into `templates/worker-brief.md` and `AGENTS.md`. It is enforced by instructions and Claude Code's auto permission mode, not structurally; branch protection or a blocking hook is listed as production work in `docs/architecture.md`.
