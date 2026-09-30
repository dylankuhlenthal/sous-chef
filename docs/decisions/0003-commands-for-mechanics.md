# 0003: Mechanics are commands; judgment is instructions

**Date:** 2026-09-17
**Status:** Accepted

## Context
Sessions and sous chef could follow written instructions to write event lines and move inbox files themselves. That leaves every agent handling paths and formats, and a runtime for another tool would need every instruction rewritten.

## Decision
Everything done the same way every time is an `sc` command: spawning, reporting, reading and acknowledging events and messages, stopping, resuming, cleanup. Instructions (`AGENTS.md`, the brief, kinds) cover only judgment: what to launch, what to report when, what needs asking. Files under `state/` are never edited by hand: a hook blocks the file-editing tools there for sous chef and for every session it launches, with each session's own report file as the one exception. The hook does not cover shell commands, so the rule is also written in the instructions.

## Consequences
Agents need to know a handful of commands and no file formats. Formats and runtimes can change behind the commands. Sous chef's own notes in `memory/` stay plain file edits, because writing them is judgment.
