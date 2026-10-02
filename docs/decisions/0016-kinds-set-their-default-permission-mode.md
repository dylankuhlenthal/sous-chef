# 0016: Kinds set their default permission mode, and the skill kinds run in bypass

**Date:** 2026-09-28
**Status:** Accepted. Amends decision 0010 (permission mode chosen per spawn, `auto` by default).

## Context
Decision 0010 made `auto` the default for every spawned session, with `bypass` chosen per spawn, and said an orchestrator that can push to a shared repo should not run in `bypass`. The owner asked for shape, build, mega-shape and orchestrate sessions to launch in bypass by default, set in the kind files. Before they decided, the risk was put to them: build and orchestrate sessions push to shared repos and merge into integration branches, and the prompt that held an orchestrator session the owner ran (for a client's authentication work) was for a script that drops and restores the databases shared by every worktree of one of the owner's repos. Under `bypass` that script would have run with nobody seeing it. They ruled bypass for all four anyway.

## Decision
A kind file may set `permissions` in its front matter, with the values `sc spawn --permissions` takes. `sc spawn` uses the `--permissions` flag when it is given, otherwise the kind's `permissions`, otherwise `auto`. The flag overrides the kind in both directions, so `--permissions auto` still runs a build in `auto`. An unknown value in a kind file is an error when the kind is loaded or listed. `kinds/shape.md`, `kinds/build.md`, `kinds/mega-shape.md` and `kinds/orchestrate.md` set `permissions: bypass`; `general` and `investigate` set nothing and stay on `auto`.

## Consequences
The risk the owner accepted: a build or orchestrate session can now push, merge into an integration branch, or run a command that changes shared databases without any prompt, and the watcher's `prompt-waiting` report no longer catches those actions because there is no prompt. What stands in the way is the brief's rules (never merge into `main` or `staging`, ask before anything destructive or outward-facing) and the skills' own instructions. Branch protection on `main` and `staging` would add a guard that does not depend on a session following its instructions.

Scheduled worker jobs launch through `sc spawn`'s code path without a flag, so a job whose kind is one of these four inherits `bypass`. The only job today, `inbox-triage`, is kind `general`, so nothing changes for it.

Everything in decision 0010 not named here still holds: the mode is recorded per session, only the runtime maps it to Claude Code's setting, and sous chef names the mode it used when it tells the owner about a spawn. To go back, remove the `permissions` line from a kind file. How it works: "Permissions" in `docs/domains/sessions.md`.
