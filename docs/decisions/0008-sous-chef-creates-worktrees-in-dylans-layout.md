# 0008: Sous chef creates worktrees for code-changing sessions, in Dylan's layout

**Date:** 2026-09-17
**Status:** Accepted

## Context
Claude Code refused edits by a background session in a normal clone until the session entered a worktree of its own making. The options were to let build sessions create worktrees that way, or have sous chef create them following the `repo-setup` layout (bare repo, sibling worktrees, env linked from `.local/`) and turn the isolation rule off for that session. The second was chosen so builds land where Dylan's tooling and env files expect.

A later test showed that in the bare-repo layout Claude Code did not refuse edits at all, because every folder there is already a linked worktree. The original reason (avoiding the forced worktree) does not apply to Dylan's layout and is withdrawn for it.

## Decision
Keep `sc worktree`. Its reasons are now: worktrees follow Dylan's layout and naming, branches start from `origin/<base>` without touching Dylan's local base, and only one active session can use a worktree. Turning isolation off for a session in its own worktree stays, and matters only for repos that are normal clones.

## Consequences
Sous chef creates the worktree before spawning code-changing work (`AGENTS.md`). Dependencies are installed by the session, not by `sc worktree`. Removing finished worktrees is not automated yet.
