# 0034: The watcher resumes sous chef after an idle stop, with an off switch

**Date:** 2026-10-14
**Status:** Accepted

## Context
Sous chef's own session kept disappearing. Claude Code stops a background session that has been idle for about an hour, and its daemon log recorded this three times in two days for the first owner's sous chef (`bg retire <short id>: settled, idle 60m`, and `idle-prompt, idle 61m`). The owner reaches sous chef through Slack while away, so after each stop scheduled jobs were held and Slack wake-ups failed until the owner opened sous chef by hand the next morning. The watcher already resumed sessions sous chef launched when they stopped while waiting on someone (decision 0017, the watcher resumes sessions that stop while idle), but not sous chef itself.

## Decision
The owner asked for it, with an off switch. When there is work for sous chef (a wake-up about to go out, a scheduled job due, unread cron events) and Claude Code stopped its session for being idle, the watcher resumes it with its conversation and then wakes it. Nothing happens while there is no work: sous chef is not kept running.

It resumes only after an idle stop, which the runtime reports as `stopped.idle` (for Claude: Porch's `ended` with `endReason` `idle`, read from the daemon log, for both causes seen). A stop by a person (`claude stop`, `/exit`, Ctrl+C) or a kill is left alone, so stopping sous chef on purpose still works. This differs from decision 0017's rule for other sessions, which goes by who the session was waiting on: sous chef is not waiting on anyone, and a stop the owner made should stay made. The watcher remembers an idle stop until it sees the session running again, because Porch forgets an ended session a day later.

`sc chef off` stops the watcher resuming sous chef for any reason, and `sc chef on` or running `souschef` turns it back on. Limits: at most 24 tries in 24 hours and none within 10 minutes of the last; a failed resume and the daily limit are sent to the owner in Slack.

## Consequences
Sous chef answers Slack messages and runs scheduled jobs after an idle stop without the owner opening it, at the cost of a resume and a short turn each time there is work. It depends on Porch reading Claude Code's daemon log, whose format is observed, not documented: if the format changes, the stop reads as `gone` and sous chef is not resumed, as before this change. How it works: "Resuming sous chef itself" in `docs/domains/watcher.md`.
