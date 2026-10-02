# 0005: The task decides who drives, not a session type

**Date:** 2026-09-17
**Status:** Accepted

## Context
An early design split sessions into interactive (shaping) and autonomous (building). The owner's view: from their side there is no difference; they should be able to open any session, and whether they are expected to drive depends on the task.

## Decision
All sessions are the same and can be attached to. Each kind only sets who the session starts waiting on (`starts_waiting_on`: the owner or the agent). After that, "waiting on" is worked out from the session's events, so it changes as the work does (an orchestrate session asking a question now waits on sous chef or the owner).

## Consequences
Sous chef's launch message and the watcher's silent-stop check use "waiting on" instead of a fixed type. A kind that needs the owner says so in one front matter field.
