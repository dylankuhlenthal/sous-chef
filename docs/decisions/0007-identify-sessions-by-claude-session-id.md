# 0007: Identify sessions by the Claude session id, never by launch environment

**Date:** 2026-09-17
**Status:** Accepted

## Context
Sessions first identified themselves to `sc` through `SC_SESSION_ID`, passed at launch, with `SC_HOME` for the data folder. In a live test, a session launched straight after another started with the first session's variables: Claude Code starts background sessions in spare processes that can carry an earlier launch's environment. A cross-check against the Claude session id refused the misdirected report, but the design relied on a value that could be wrong.

## Decision
`sc report` and `sc inbox` find the calling session from `CLAUDE_CODE_SESSION_ID`, set by Claude Code, matched against the ids recorded at launch. Sous chef passes no identity or paths through the environment: the brief carries `sc`'s full path, and hooks carry the session id as an argument. The data folder is always the folder `sc` lives in; `SC_TEST_HOME` exists for tests only.

## Consequences
A stale environment cannot send a report to the wrong session or the wrong folder. Testing a real sous chef against scratch state needs a separate copy of the folder (a git worktree), not a variable. Right after launch a report may wait a few seconds for the record to get its Claude id.
