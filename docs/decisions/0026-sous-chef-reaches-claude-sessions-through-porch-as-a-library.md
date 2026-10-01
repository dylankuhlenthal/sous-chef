# 0026: Sous chef reaches Claude sessions through Porch, as a library

**Date:** 2026-10-01
**Status:** Accepted

## Context
The Python sc read `claude agents --json` and Claude Code's job files itself and posted wake-ups to Claude Code's message socket itself (`lib/sc/wake.py`). Porch now does all of that, for any harness, and is tested against real Claude Code. The TypeScript rewrite had to choose between porting sous chef's own code and moving onto Porch, and how to call Porch.

## Decision
The TypeScript Claude runtime (`src/runtimes/claude-bg.ts`) is written on Porch from the start: the listing parser, the job-file reader and the socket code were never ported. Sous chef calls Porch as a library (`new Porch()`, `list`, `observe`, `deliver`, `statusSet`, `launchPlan`), not the `porch` command. Listing, status, waking, launching (with Porch's hooks merged into the one `--settings`) and turn times go through Porch; resume, stop, attach and reading the short id stay in sous chef, because resume must run `claude --bg --resume <id>` with no other flags. The runtime interface (decision 0004) and sous chef's own fake runtime for the behaviour suite stay as they were.

Set aside: porting the Python runtime as it was and moving onto Porch later (writes and then throws away the code Porch replaces, and the behaviour suite never exercises it anyway); running the `porch` command (a process per call, no types).

## Consequences
Porch declares its command's JSON output its stable contract, not the library, so sous chef depends on a surface Porch has not declared stable; the pinned version (decision 0025) covers that until Porch declares its library surface supported (a line on TRV-1146). Sous chef also reads two things Porch documents loosely: the listing's `kind` from an observation's `raw.listing`, and a failed listing told apart from one unreadable record by Porch's error text; both are pinned by tests against the pinned version. Every delivered message starts with Porch's label, `[from sous chef] `.
