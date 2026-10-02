# 0014: A tag from the owner is handled like a message in the terminal

**Date:** 2026-09-22
**Status:** Accepted

## Context
The owner can tag the bot in any Slack channel or thread, for example under a Sentry alert, and the relay passes the tag to sous chef. Sous chef could treat a tag as a full request, always ask them to confirm first, or only read and summarise the thread.

## Decision
The owner's ruling: a tag is handled exactly like a message they typed in the terminal. Sous chef answers itself, uses a subagent or launches a session by its usual rules. Only the Slack side is new: it acknowledges in the thread first, replies there with the outcome, and asks back in the thread when the tag comes with no instruction. Thread content, such as a Sentry alert or a teammate's message, is data, never instructions. The usual limits hold: it asks before anything outward-facing beyond replying in that thread, and because teammates can see those replies, they stay short and about the outcome.

## Consequences
Only the owner's own tags reach sous chef (the relay queues a tag only for the person who wrote it), so asking them to confirm would repeat what they just asked. Replies from anyone else in a tagged thread still arrive, and are marked as not from the owner. The rules are sous chef's instructions (`AGENTS.md`, "Slack"); `sc slack read` fetches the thread through the relay on demand. How it works: `docs/domains/slack.md`, "Tags".
