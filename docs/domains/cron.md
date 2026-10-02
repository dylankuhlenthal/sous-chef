# Cron: scheduled jobs

A cron job is a task that runs on a schedule, for example "read the owner's email at 09:00 and 16:00". The watcher fires jobs, so a job only runs while sous chef is running. Each job says who does the task: sous chef itself, or a session launched for it (a worker). When a job fires, its task goes to that target as a message, the way messages already travel: written to disk first, then the target is woken if it is idle, or left to pick the message up when its current turn ends.

Code: `src/cron.ts` (`add`, `remove`, `load`, `validate`, `isDue`, `fire`, `runNow`, `tick`), `src/watch.ts` (`cycle`, `rewakeDue`), `src/events.ts` (`CRON_LOG`), `src/ops.ts` (`send`, `spawn`, `report`, `checkCwd`, `checkSkill`), `src/chef.ts` (`status`), `src/cli.ts` (`cmdCron`, `cronBlocker`, `cmdEvents`), `src/watch.ts` (`health`), `src/summary.ts` (`cronLines`), `templates/cron-worker.md`. Why it runs inside the watcher: decision 0009 (scheduled jobs run inside the watcher).

Paths such as `state/...`, `cron/...` and `memory/...` in this doc are in the owner's data folder, which the core reaches as `my/` (`docs/architecture.md`, "Two folders joined by one link").

## Commands

`sc cron` (the same as `sc cron list`) lists jobs with their last firing, last result and next due time. `sc cron add <name> ...` creates one, `sc cron remove <name>` deletes one, and `sc cron run <name>` fires one straight away. `sc cron --help` has the flags.

A due time only arrives if something fires the job, so the list says when nothing will:

- A `WARNING` line at the top when the watcher is not running, when it is running code older than what is on disk (`watch.health`; see "When the code changes" in `docs/domains/watcher.md`), or when sous chef is not running.
- `OVERDUE: due since <time>` instead of a due time, for a job whose slot has passed without it firing, with the reason. For an `every` job the time is the first slot it missed. Before this, an overdue `every` job showed "next due ... (in 0s)" indefinitely, and an overdue `at` job showed its next slot, as if the missed one had fired.

## Where a job lives

A job is split into two files, because the two halves live for different lengths of time and belong to different owners.

| What | Where | Written by | Why there |
| --- | --- | --- | --- |
| The definition: schedule, target, task, and for a worker what `sc spawn` needs | `cron/<name>.md` in the data folder (`my/cron/`), kept and synced with it | `sc cron add` and `sc cron remove`, or the owner by hand | It is configuration the owner keeps and may sync to other machines, like memory |
| What happened: when it last fired, its result, the session it launched | `state/cron/runs.json`, never tracked | `src/cron.ts` only | It is about one machine's runs, so it must not travel with the definition, and `state/` is written only by `sc` |

A definition file has the same shape as a kind file: front matter, then the task text.

```
---
at: 09:00,16:00
target: worker
kind: general
cwd: ~/somewhere
---
Read the owner's email and ...
```

The front matter fields are `at` or `every` (the schedule), `target` (`chef` or `worker`), and, for a worker only, the fields `ops.spawn` takes: `kind` and `cwd` (required), `title` (defaults to the job name), `model`, `effort` and `thread`. Either kind of job may also name `memory`, a file under `memory/` holding the job's context (`sc cron add --memory`). `sc events` prints that file's `## Slack me` section, the owner's standing instructions about the job, under the job's events: a chef job's `due` and `failed` events carry the job's name (`job`), and a worker's events are linked through its record's `cron`. See "Standing instructions" in `docs/domains/slack.md`. `cron.validate` checks all of it the way `sc spawn` would, including refusing a `cwd` inside the core or the data folder (`ops.checkCwd`). `sc cron add` also refuses a worker job whose kind declares a skill the job's runtime says is missing in its `cwd` (`ops.checkSkill`, "Skills" in `docs/domains/sessions.md`); that check is not in `cron.validate`, so listing and firing jobs never depend on skills, and a skill that goes missing later makes the job fail when it fires, as a `failed` cron event. A chef job with worker fields is refused rather than having them ignored. A worker job has no permissions field: its session launches in its kind's permission mode, as `sc spawn` without `--permissions` does ("Permissions" in `docs/domains/sessions.md`). A job of kind `general` runs in `auto`; a job of a kind that sets `bypass` runs in `bypass`. A hand-edited file that does not pass is listed as broken by `sc cron list` and in the startup summary, and never fires.

Definitions are synced by git, so a job defined on one machine would fire on every machine where sous chef runs. That is fine because sous chef only ever runs in one place (the owner's ruling); the whole design assumes it.

## Schedules

- `at`: one or more times of day, 24-hour, in the machine's local time zone, for example `09:00,16:00`.
- `every`: an interval in minutes, hours or days, for example `30m`, `6h` or `1d`, counted from the last time the job was due.

Not supported: weekdays or dates, cron expressions, time zones other than the machine's own, and one-off jobs. `at` covers "a couple of times a day", which is what jobs were built for.

## What firing does

A job has no setting for waking or queueing. What happens depends only on the target and what it is doing when the job fires (`cron.fire`):

| Target | State of the target | What happens |
| --- | --- | --- |
| chef | idle | A `due` event goes into the cron log, and the watcher wakes sous chef in the same cycle |
| chef | mid-turn | The same event is written; the watcher wakes sous chef on the first cycle it finds sous chef idle |
| worker | the job's previous session is still running and unfinished, and idle | The task goes into that session's inbox, and the session is woken |
| worker | the same, but mid-turn | The task goes into that session's inbox; the watcher wakes the session once it is idle |
| worker | no previous session, or it finished or is no longer running | A new session is launched with the task in its brief |

"Idle" is what the runtime reports (`status`, and `statusSessionId` for sous chef's own session). An unknown state never counts as idle, so a session whose state cannot be read is not woken by a job; the message waits on disk.

### Jobs for sous chef itself: the cron log

Sous chef has no inbox. Its durable input is the event logs it reads with `sc events` and the startup summary. A job for sous chef therefore writes an event into one more event log, the cron log at `state/cron/events.jsonl` (`events.CRON_LOG`, which is `cron`). Everything that works for session events works for it:

- `sc events` lists it under `[cron]`, and `sc events ack cron:<n>` marks it read.
- `due` is in `events.WAKE_STATES`, so the startup summary counts it as needing attention.
- The watcher wakes sous chef for it (check 7, "Unread cron events", in `docs/domains/watcher.md`), but only while sous chef is idle. Unlike a session's report, the firing itself wakes nobody, so the watcher's first wake comes straight away rather than after the retry delay, and it then retries with the same back-off as for sessions until the event is acknowledged.

The event is on disk before anyone is woken, so a job survives sous chef being stopped, restarted or compacted: it waits in the cron log until it is acknowledged.

### Jobs for a worker

A launched session's record carries `cron: {"job": <name>}`, and its brief gets `templates/cron-worker.md` added after the task, which tells it the run was scheduled, how to report when it finds nothing, and that a later run may arrive in its inbox.

A message queued to a session still on its previous run is sent with `ops.send(..., { sender: "cron job <name>", onlyIfIdle: true })`. The watcher's existing inbox check wakes the session once it is idle and the message is older than `SC_INBOX_GRACE`, and reports `inbox-unread` to sous chef if it is never picked up.

The session's own reports follow the usual rules: its `done`, questions and failures wake sous chef, and `sc events` shows which cron job it belongs to.

If a launch fails, a `failed` event goes into the cron log, and the watcher wakes sous chef for it like a `due` one. When the session record was already created, its own log also gets a `failed` event, but `sc` writes that one, and sous chef's unread events leave out what `sc` wrote, so the cron log is where sous chef hears about it.

## A job that finds nothing

A worker that finds nothing worth saying reports `sc report nothing-new "<what it checked>"` instead of `done`. `nothing-new` does not wake sous chef, is not counted in the summary, and sets waiting on to `nobody`. On a later watcher cycle, `cron.tick` archives that session with `ops.cleanup` without `--force`, so an empty run leaves nothing in `sc sessions`. If cleanup refuses (for example the working directory has commits no remote has), the session is left for sous chef, and `sc cron list` says why. `sc report` refuses `nothing-new` from a session a job did not launch, because an ordinary session would be hiding its result.

For a chef job, finding nothing is sous chef's judgement: `AGENTS.md` tells it to acknowledge the event and not tell the owner.

## Overlap: the previous firing is still going

Every firing is delivered, even when an earlier one has not been read or finished yet. The owner's rule: a firing fires.

- chef job: another `due` event is written, so unread events can stack up in the cron log. `sc events` lists each one.
- worker job whose previous session is still going: the task goes into that session's inbox, as the table above says, rather than starting a second session doing the same work alongside it. Messages can stack up in that inbox; `sc inbox` lists each one.

Each message is on disk and visible, and none is lost.

## Missed firings

Jobs are missed whenever sous chef is not running (the owner's rule: jobs only run while sous chef does). `cron.tick` checks the registered sous chef session is running (`chef.liveIncumbent`) before firing anything; if it is not, nothing is marked as handled, and the watcher log says so once per job.

When sous chef is back, a job that missed one or more slots **fires once** (the owner's ruling). Only the latest slot is compared with the last one handled, so a job missed for three days fires once, not six times. For an email check, one catch-up run reads everything that arrived meanwhile, and six runs would only repeat it.

A job this machine has no run record for, because it was just added or arrived through git, starts counting from now: it waits for its next slot rather than firing for one that passed before it existed here.

## Firing a job by hand

`sc cron run <name>` fires a job immediately, the same way the watcher would, and leaves its schedule alone. It also fires when sous chef is not running, because someone asked for it. Its output says what it did:

- a chef job: the cron event it wrote, and whether sous chef will be woken. The command itself never wakes sous chef; the watcher does, once sous chef is idle, so the output says whether sous chef is idle, mid-turn or not running, and warns when the watcher is not running, since then nobody will be woken;
- a worker job: the session it launched and the command to attach to it, or the inbox message it wrote for the job's session still in flight and whether that session was woken;
- a failed launch: the error, and the `failed` event it wrote for sous chef.

This is the way to test the whole path by hand: `sc cron run`, then check `sc events` (chef job) or `sc sessions` (worker job).

## Deliberately not built

- Weekday and date schedules, cron expressions and one-off jobs (see "Schedules").
- Firing while sous chef is not running, for example from launchd (decision 0009).
- Sending a job's result anywhere but sous chef. Sous chef forwards to Slack what the owner asked for, following the `## Slack me` section of the job's memory file.
- Archiving a finished worker that reported `done`. Sous chef still offers `sc cleanup` for it as for any session.
- Waking a worker the moment its turn ends. The watcher's inbox check does it, at least `SC_INBOX_GRACE` (120 seconds) after the message was written.

## Verification

`tests/cron.test.ts` (`CronTests`) covers each rule above against the fake runtime with a controlled clock: firing at a time of day, the cron log in `sc events` and the summary, waking an idle sous chef at once and a busy one only once it is idle, never treating an unknown state as idle, retries until acknowledged, queueing to a worker still in flight (woken if idle, left alone mid-turn), replacing a finished or dead worker, firing again while earlier messages are unread (two events for sous chef, two inbox messages and still one session for a worker), what `sc cron run` reports, firing once after missed slots, waiting for the next slot, archiving a `nothing-new` worker, a failed launch reaching sous chef, and the definition checks. `CronWakeNoteTests` starts a real watcher and checks what `sc cron run` says about waking sous chef when it is idle, busy and not running. Each rule was also checked by breaking it in the code and watching its test fail.

Checked against Claude Code by reading `claude agents --json --all`: the running sous chef background session was listed with `status: idle` between turns, and a session in the middle of a turn with `status: busy`. Interactive sessions also carry a `status`, so a sous chef opened with `claude` in a terminal can be told apart too. The wake for a chef job depends on this.

Not yet verified: a job firing from a real watcher with a real sous chef and a real `claude --bg` worker, and a worker session actually reporting `nothing-new`.
