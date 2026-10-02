# 0011: Slack messages land in a third sous chef log

**Date:** 2026-09-22
**Status:** Accepted

## Context
Messages from Slack reach sous chef through the relay, which the watcher polls. Sous chef has no inbox of its own, and there is no session behind a Slack message, so they needed somewhere durable to land before anyone is woken (decision 0002, files are the record and wake-ups are best effort). The options were a made-up session per Slack conversation, a wake-up carrying the message, or one more of sous chef's own event logs, as scheduled jobs and the context check already use.

## Decision
The owner's ruling: messages are written to a third sous chef log, `state/slack/events.jsonl`, read and acknowledged through `sc events` under `[slack]` like the cron and context logs. It has no waiting on and no open questions of its own: acknowledging a message means sous chef handled it, and questions stay open in the sessions' own logs. Each message is written before it is acknowledged to the relay. Unlike the cron log, the watcher wakes sous chef as soon as it writes a message, idle or mid-turn, because sous chef may be mid-turn on Slack itself (for example handling a message the owner sent seconds earlier).

## Consequences
No fake sessions, so no session command has to learn that some sessions are not real, and nothing is carried only by a wake-up. The events carry one extra field (`slack`) that the other logs do not. A Slack message can reach sous chef mid-turn; Claude Code holds the wake-up until the turn's next step. How it works: `docs/domains/slack.md`.
