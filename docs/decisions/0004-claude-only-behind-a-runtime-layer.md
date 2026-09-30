# 0004: Claude only for now, behind a runtime layer

**Date:** 2026-09-17
**Status:** Accepted

## Context
Dylan wants to use other agent tools later, but only Claude Code now. Supporting several tools from the start (as firstmate does) multiplies the code that deals with each tool's quirks.

## Decision
Only Claude Code is supported. All knowledge of how a session runs lives in `lib/sc/runtimes/`, behind a small set of functions (`launch`, `resume`, `stop`, `status`, `listing`, `wake`, `wake_session_id`, `attach_command`). Each session record stores its runtime name.

## Consequences
Adding a tool means adding one runtime module (`docs/patterns/adding-a-runtime.md`). Hooks are expressed in Claude Code's settings shape, which another runtime has to translate.
