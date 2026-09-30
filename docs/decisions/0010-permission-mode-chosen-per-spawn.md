# 0010: Permission mode is chosen per spawn, and stays `auto` by default

**Date:** 2026-09-22
**Status:** Accepted

## Context
Every session ran in Claude Code's `auto` permission mode, which was fixed in the Claude runtime. The TRV-1114 orchestrator (the Moodle auth work) then sat at a permission prompt for about two hours without anyone being told. Dylan asked whether sessions could run with bypass permissions instead. The prompt itself had been right: it was for a script that drops and restores the shared Postgres and Mongo databases every studio-api worktree uses, and under bypass it would have run while Dylan was busy elsewhere. The failure was that nobody was told.

## Decision
Dylan's rulings: `sc spawn --permissions` chooses the mode for each session (`auto`, `accept-edits`, `bypass`, `ask`), and `auto` stays the default, so nothing changes for any existing caller or for the system as a whole. A build in a fresh, empty directory can opt into `bypass`; an orchestrator that can push to a shared repo should not. Alongside it, the watcher reports a session held at a prompt (`prompt-waiting`), so the failure that prompted this is fixed directly.

## Consequences
The values are sous chef's own; only the runtime maps them to the tool's setting, and the record keeps the value so `sc status` shows it. Choosing `bypass` is a judgment made at spawn time, by sous chef or Dylan, for that task. Scheduled worker jobs (`sc cron add`) still launch with the default. How it works: "Permissions" in `docs/domains/sessions.md`.
