# 0013: Standing instructions live with the thing they are about

**Date:** 2026-09-22
**Status:** Accepted

## Context
The owner wants to say "slack me when the orchestrate is ready" or "slack me about important email" once and have it hold. The instruction has to be kept somewhere and reach sous chef when the event it is about arrives. Claude first proposed rules stored by `sc` in `state/`. Also considered: a list in memory with nothing mechanical behind it, and canned messages the watcher sends by itself.

## Decision
The owner's proposal: an instruction is written under a `## Slack me` heading in the memory file that already holds that thing's context. A session's thread file (through the session record's `thread`), a scheduled job's memory file (through a new `memory` field in its definition), or `memory/slack.md` for instructions about nothing in particular. `sc` stores no instructions. `sc events` prints the linked section under every event from that session or job, and `memory/slack.md`'s under the open questions. Sous chef writes and sends the message and makes the judgement call.

## Consequences
There is one home for everything sous chef knows about a thing, so the rule and the context cannot disagree, while `sc` still puts the instruction in front of sous chef when the event arrives. A session with no thread has nowhere to hang an instruction, so `sc spawn` warns about it. The watcher never sends a Slack message by itself. How it works: `docs/domains/slack.md`, "Standing instructions".
