# 0009: Scheduled jobs run inside the watcher, and reach their target as messages

**Date:** 2026-09-21
**Status:** Accepted

## Context
The owner wanted jobs on a schedule, for example sous chef reading their email a couple of times a day. They could run from a system scheduler such as launchd, or from the watcher sous chef already starts. Sous chef also has no inbox, so a job meant for sous chef needed somewhere durable to land.

## Decision
The owner's rulings: the watcher fires jobs, so they run only while sous chef runs; each job targets either sous chef or a spawned worker; and a firing is delivered like any message, waking the target if it is idle and queueing if it is mid-turn. Waking or queueing is not a setting on the job. A job for sous chef writes an event to one more event log, the cron log, read and acknowledged with `sc events` like a session's. A job whose previous worker is still going sends that session the task rather than launching a second one. Every firing is delivered, even when an earlier one is unread, so messages can stack up. Missed firings fire once when sous chef is back. Definitions sync through git, which is fine because sous chef only ever runs in one place.

## Consequences
No second process or messaging path. Jobs are missed while sous chef is down and fire once when it is back. The watcher's retries for a job must also wait while the target is mid-turn, or queueing would only delay the interruption. How it works: `docs/domains/cron.md`.
