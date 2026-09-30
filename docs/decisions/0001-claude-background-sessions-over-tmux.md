# 0001: Run sessions as Claude Code background sessions, not tmux

**Date:** 2026-09-17
**Status:** Accepted

## Context
Sessions have to be resumable and openable by Dylan at any time. tmux or herdr would work for any agent tool, but tools like firstmate spend most of their code typing into terminal windows and guessing from screen contents whether an agent is busy. Claude Code 2.1.274 has background sessions (`claude --bg`) with listing, attach, stop, resume, a busy/idle status and a local message socket, verified by running them.

## Decision
Sessions run as Claude Code background sessions. Dylan opens one with `claude attach <id>`.

## Consequences
No screen reading or terminal typing for Claude sessions. Sous chef depends on Claude Code features that are not all documented (the socket path, the `claude agents --json` fields), recorded as shortcuts in `docs/architecture.md`. Other agent tools need their own runtime (decision 0004, Claude only behind a runtime layer).
