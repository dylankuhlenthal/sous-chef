# Watcher

The watcher is a Python loop (`sc watch`) that checks all active sessions every 15 seconds, fires scheduled jobs that are due, collects the owner's Slack messages from the relay, and keeps the owner's data folder committed and pushed. It uses no tokens. It writes anything it finds into the affected session's event log, then wakes sous chef with one message per cycle.

Code: `lib/sc/watch.py` (`cycle`, `_auto_resume`, `_check_prompt`, `_idle`, `_in_flight`, `_quiet_since`, `_rewake_due`, `run_forever`, `_restart_if_code_changed`, `ensure`, `health`, `is_running`), `lib/sc/cron.py` (`tick`) for scheduled jobs, `lib/sc/slack.py` (`poll`) for Slack, and `lib/sc/sync.py` (`tick`) for syncing the data folder.

## What it checks

For every session in `state/sessions/`, `watch.cycle` gets the runtime's listing once and then:

1. **Gone.** The session has not been seen running for `SC_GONE_GRACE` seconds, sous chef did not stop it (`stopped_by_sc` is false), and it is not finished (waiting on is not `nobody`). It appends a `gone` event once, and not again until the session has been seen running.
   - The first poll that finds the session missing only records the time (`missing_since` in `state/watch.json`); a poll that finds it running clears it. A session restarting drops out of `claude agents` for a few seconds and comes back under the same session id with a new pid, which was seen live, so one missed poll is not enough.
   - The grace is 60 seconds (about four polls): long enough to cover the restart gap seen, which was seconds, and short enough that a session that really died is reported within about a minute. Nothing else waits on `gone`, so a minute's delay costs nothing.
   - The event tells sous chef to check `sc status` before resuming. `sc resume` refuses a session that is running, so following the advice cannot start a second copy.
   - **Resumed instead, when it was waiting on someone else.** When the session was waiting on the owner (`owner`), `sc` or `external` (`watch.AUTO_RESUME_WAITING`), the watcher resumes it itself (`watch._auto_resume`) instead of appending `gone`. It uses `ops.resume`, the same code as `sc resume`, which appends `auto-resumed` (author `watcher`). That event does not wake sous chef and does not change who the session is waiting on, so a shape session is still waiting on the owner afterwards. The watcher then sends the session an inbox message (from `watcher`): it was resumed after stopping while idle, anything tied to its old process has ended (for example a local page server, which targets the old process), so it should restart what it still needs and not report again unless its situation changed.
   - Why: background sessions waiting on the owner were seen to stop by themselves. One shape session stopped 62 minutes after its last activity three times in a row while the Mac stayed awake, and each time sous chef had to notice the `gone` event, resume it, and tell it to restart its page server. The likely cause is Claude Code stopping background sessions that stay idle for about an hour (a one-hour constant sits next to its background-session code; seen, not confirmed). A session waiting on someone else is idle by definition, and its work is unfinished, so resuming it is what sous chef did every time. See decision 0017 (the watcher resumes sessions that stop while idle).
   - Not resumed: a session waiting on `agent`, because it was working (or stopped without reporting within the last `SC_SILENT_GRACE`), so its stopping is unexplained and sous chef should look; a finished one (`nobody`); and one sous chef stopped.
   - Limits, so a session that keeps stopping is not resumed in a loop. Both are counted from the session's own `auto-resumed` events. At most `SC_AUTO_RESUME_MAX` automatic resumes (24) in any 24 hours: one an hour covers a session waiting on the owner all day and night. And none when the session went missing within `SC_AUTO_RESUME_MIN_UP` seconds (10 minutes) of the last automatic resume, since an idle stop takes about an hour, so a session stopping sooner is stopping for some other reason. This also means a session that fails to come up after a resume is never resumed twice in a row. When a limit applies, or the resume fails, the watcher appends `gone` as before, and its text says why it did not resume the session.
2. **Held at a prompt.** The runtime says the session is held mid-turn by something only a person can answer (its status has a `prompt`; see "How a prompt is detected" below), and the same prompt has been open for `SC_PROMPT_GRACE` seconds. It appends one `prompt-waiting` event per prompt. The event names what the prompt asks, when the runtime can tell, and the attach command, and tells sous chef that `sc send` does not answer it.
   - The first poll that sees the prompt only records it and the time (`prompt` in `state/watch.json`). A prompt with different text is a new prompt: its clock starts again, and it is reported on its own.
   - The grace is 180 seconds. The owner is often attached and answers a prompt within a minute, which needs no event; the case this exists for is a session left at a prompt for hours.
   - When a prompt it reported goes away while the session is still running, it appends `prompt-answered`, which does not wake sous chef. That event gives back the "waiting on" the session had before the prompt, unless something else was recorded in the log since (for example a report, or `sc mark`), so that a later silent stop is still noticed (check 3 needs "waiting on" to be `agent`). A session that stops while held is left to check 1.
   - It covers any dialog the runtime reports, not only permission prompts; for Claude those are listed below.
3. **Silent stop.** The session is running and idle (see "When a session counts as idle" below), its last Stop hook time is at or after its last prompt time (or there is no prompt time yet), that was at least `SC_SILENT_GRACE` seconds ago, and its waiting on is still `agent`. In other words, it ended a turn without reporting why. It appends one `silent-stop` event per stopped turn.
   - A session waiting on the owner (for example a shape session the owner is chatting in) never triggers this.
   - A session the owner is actively chatting with keeps starting new turns, so it does not stay idle for the grace period.
   - A session that ended its turn to wait for subagents or background commands it started is not reported while they run, and the grace counts from the last poll that saw them running. See "Work in flight" below.
4. **Unread inbox.** A message older than `SC_INBOX_GRACE` is still unhandled.
   - If the session is idle (as for check 3), it re-sends the wake-up, up to `SC_INBOX_RINGS` times, spaced by the grace period, then appends `inbox-unread`.
   - If the session is busy, it waits.
   - If the session is not running and sous chef stopped it, it leaves the message for when it is resumed. If sous chef did not stop it, it appends `inbox-unread` straight away.
5. **Unread events.** Sous chef has not acknowledged an event that needs attention (`events.WAKE_STATES`). The report already woke sous chef once; the watcher wakes it again after `SC_WAKE_RETRY` seconds, then doubles the wait each time, up to one hour. A newer event restarts the count, timed from the oldest unread event, so a new event on top of an old unread one is re-sent on the next cycle rather than after a fresh wait.

### When a session counts as idle

Checks 3 and 4 need to know whether a running session is between turns (`watch._idle`). There are two sources, and neither is trusted alone:

- The runtime's status (`claude agents --json`). When it says idle, the session is idle.
- `sc`'s own turn record (`turns.json`, written by the session's Stop and UserPromptSubmit hooks). When its last turn ended at least `SC_STALE_BUSY` seconds ago and no prompt has arrived since, the session is idle, whatever the runtime says.

The second rule exists because `claude agents` was seen reporting `busy` for a session whose last turn had ended 15 minutes before, so the silent-stop check never fired. It relies on every turn starting with a UserPromptSubmit hook. That was checked for the case most likely to break it: a session woken by its own background command finishing recorded a new prompt time at that moment. The 300-second wait keeps the runtime's word for the first minutes after a turn ends, which is below the silent-stop grace, so a silent stop is still reported after `SC_SILENT_GRACE`.

With neither source (the runtime cannot tell, and no turn has ended since the last prompt), the session is not idle: an unknown state never counts as idle.

A session held at a prompt counts as busy (the runtime reports it so), and its turn has not ended, so it is never idle: it is not re-sent inbox wake-ups and never reported as a silent stop. Before check 2 existed that was the whole problem. An orchestrator sat at a permission prompt for about two hours: `sc sessions` showed it as busy, check 3 could not fire because it never ended a turn, and check 4 left its three unread messages alone because it was busy. Nothing told the owner.

### Work in flight

An orchestrator launches subagents, ends its own turn, and is woken again when one of them finishes. Between those turns its Stop hook has fired and no prompt has arrived, so by the rules above it is idle, and check 3 used to report it as a silent stop every time a subagent ran for longer than the grace period. The TRV-1114 orchestrator (the Moodle auth work) produced one of these repeatedly for a whole day. It was not stuck, and each one had to be checked by hand.

The runtime's status can now include `activity`, with `in_flight`: how many subagents and background commands the session started are still running (`lib/sc/runtimes/__init__.py` describes the shape; `None` means the runtime cannot tell). `watch._in_flight` turns that into a number, and anything other than a whole number above zero counts as 0. Check 3 then uses `watch._quiet_since`:

1. While `in_flight` is above 0, no silent stop is reported, and the watcher records the time in `in_flight_seen_at` in `state/watch.json`.
2. Once nothing is in flight, the grace (`SC_SILENT_GRACE`) counts from the later of the Stop hook time and `in_flight_seen_at`. A subagent that has just finished normally wakes the session within seconds, so counting from the stop would report a session in the moment before it wakes. A session that really has stopped is reported one grace period after its last work finished.
3. After `SC_INFLIGHT_MAX` seconds (2 hours) since the turn ended, work in flight no longer holds the event back and the grace counts from the stop, so the event goes out on the next poll. Its text says the session still has work running, which may be stuck. Without this limit, a subagent that never finished would hide a stalled session for ever. Two hours is longer than any single subagent seen so far (a build subagent ran for about 17 minutes); a session woken by each finishing subagent starts a new turn, so the clock restarts with every result.

This only holds an event back; it never cancels one. With no activity (the runtime cannot read it, or its fields have changed), `in_flight` is 0 and `in_flight_seen_at` is never set, so check 3 behaves exactly as it did before.

**What counts as in flight, and why.** For Claude sessions, `in_flight` is `inFlight.tasks` from Claude Code's job file (`~/.claude/jobs/<short id>/state.json`), read by `claude_bg._activity`. That file is internal to Claude Code and undocumented; the fields were read live from version 2.1.278 and may change without warning. `inFlight` also has `queued` and `drainableMonitors`, which are deliberately not counted:

- `queued` is not work running. It was seen at 1 on a session whose job file said it was finished (`state: done`, `tempo: idle`), so counting it would hold back a silent stop for a session with nothing running.
- `drainableMonitors` was never seen above 0, so what it counts was not observed. A monitor can also watch something indefinitely, which would hold back the event until the 2-hour limit every time.
- `tasks` was seen to match the running subagents: on the TRV-1114 orchestrator it read 4 while it was falsely flagged, then 3 and 2 as the job file marked its reviewer subagents finished, matching the subagent entries in `fan` with no `doneAt` each time.

Each field is optional. `claude_bg._activity` accepts `inFlight.tasks` only as a whole number of 0 or more (not text, not `true`, not a fraction); anything else gives `in_flight: None`. A file that is missing, is not JSON, is not an object, or names a different `sessionId` from the listing row gives no activity at all.

`activity` also carries the session's own one-line `detail` and the entries in `fan` that have not finished, which `sc sessions` and `sc status` show (`docs/domains/sessions.md`, "What a session is doing"). The watcher does not use them. `fan` entries are not a count of work in flight: on the orchestrator, a shell command appeared in `fan` without `doneAt` while `inFlight.tasks` counted only its three running subagents.

### How a prompt is detected

For Claude sessions, `claude agents --json` gives each running session a `status`. It has three values: `idle`, `busy`, and `waiting`. `waiting` means a dialog is holding the session mid-turn, and the row then has a `waitingFor` field saying what kind. `claude_bg.status` reports a session as held (`prompt` set) exactly when its status is `waiting`, and adds the exact ask from Claude Code's own job file (`~/.claude/jobs/<short id>/state.json`, field `needs`, for example `approve Bash: ./scripts/db-reset.sh`) when that file can be read. Sous chef's earlier code treated every status other than `idle` as busy, which is why a waiting session looked busy.

What was verified, with Claude Code 2.1.278:

- **Run live:** a background session launched in manual mode and asked to run a shell command showed `"status": "waiting", "waitingFor": "permission prompt", "state": "blocked"` for as long as the prompt was open, and its job file held `"tempo": "blocked", "needs": "approve Bash: <the command>"`. The command never ran. `claude_bg.status` on that session returned `prompt: "permission prompt (approve Bash: touch live-probe.txt)"`.
- **Read from Claude Code's code, not run:** the `waitingFor` values are `permission prompt` (every tool permission prompt: Bash, file edits, web fetch, skills, MCP tools and the rest), `dialog open`, `input needed`, `sandbox request`, `worker request` and `goal proposal`. The code that builds the listing maps a process status of `waiting` to `state: blocked`, and a process status of `busy` always to `state: working`.
- **Not observed:** the moment a prompt is answered and the session carries on. Answering one needs a person in the session. The watcher's handling of it (`prompt-answered`) is covered by the tests against the fake runtime only.

Why the watcher does not use the row's `state` field, although it reads `blocked` at a permission prompt: `state` is also `blocked` for a session that has ended its turn with a question to the user. Claude Code decides that by classifying the session's last message (a pattern match, or a model call), and the job file then has `"tempo": "blocked"`. Seen live: a shape session that had asked the owner to review a page showed `state: blocked` with `status` `idle`, and later `busy` while a background command of its ran. That session had already reported `waiting` through `sc report`, so sous chef knew; an event from the watcher would say it twice. `state` is also `working` whenever the status is `busy`, whatever else is true. So `state: blocked` mixes two different things, and only one of them, the prompt, is something sous chef cannot learn any other way.

After the sessions, once per cycle:

6. **Scheduled jobs.** `cron.tick` archives worker sessions that reported `nothing-new`, then fires the jobs that are due, but only while the registered sous chef session is running. A job for a worker launches a session, or sends its task to the job's session that is still in flight, waking it at once if it is idle; a session that is mid-turn is woken later by check 4, once it is idle. A job for sous chef, or a worker that could not be launched, leaves an event in the cron log.
7. **Unread cron events.** When the cron log has unread events and sous chef is idle (`chef.status`; unknown counts as busy), it wakes sous chef. Nothing wrote a wake-up when the event was written, so the first one goes out straight away rather than after `SC_WAKE_RETRY`; after that it backs off as in check 5. While sous chef is mid-turn it waits, however long the turn lasts, so a job never interrupts a turn.

How jobs are defined, fired and caught up: `docs/domains/cron.md`.

8. **Slack.** When the data folder has a Slack config (`my/.env`), `slack.poll` reads the relay's queue, writes each new message to the slack log, and only then acknowledges it to the relay. If it wrote anything, sous chef is woken in this cycle, whether it is idle or mid-turn: a message from the owner should not wait for a turn that may itself be about Slack. After that it backs off as in check 5 until the slack log is acknowledged. An unreachable relay is logged once and shown in the startup summary; the other checks carry on, and a failing poll never stops the cycle. How messages are labelled: `docs/domains/slack.md`.

9. **Syncing the data folder.** When the data folder is a git repo whose branch has an upstream (`sc setup` sets one when it pushes), `sync.tick` keeps it committed and pushed. Nothing else commits memory, so without this the owner's notes would only ever live on one machine.
   - **Commit.** Any change to a file git does not ignore starts a quiet period. When nothing has changed for `SC_SYNC_QUIET` seconds, everything is committed as `sync: <files>` (the first five named). `state/` and `.env` are taken back out before the commit whatever the folder's `.gitignore` says, so the relay key and session records are never pushed.
   - **Push.** When the branch has commits its upstream lacks, and no tracked file has an uncommitted edit (git refuses to rebase over one, so the push waits for that edit's own commit), it fetches, rebases onto the upstream if the remote moved on (another machine pushed), and pushes. It never force-pushes. Git never prompts (`GIT_TERMINAL_PROMPT=0`, SSH in batch mode) and each call times out after 60 seconds.
   - **A conflict** during the rebase (it leaves unmerged files; a rebase git refuses for any other reason is retried like a failed push): the rebase is aborted, so the folder is left exactly as it was, and syncing stops. `sync-stopped` goes into the sync log (`[sync]` in `sc events`) with the git error, and wakes sous chef, which tells the owner. The owner, or a session they ask for, resolves it in the data folder (a rebase or merge by hand). Syncing starts again by itself on the first cycle where the folder has no rebase or merge in progress, no unmerged files, and a different commit checked out than at the conflict; that last condition is what stops it retrying the same conflict every cycle.
   - **Failed fetches or pushes** (offline, or the remote refuses) are retried, backing off from `SC_SYNC_RETRY` and doubling, up to 30 minutes. After `SC_SYNC_MAX_FAILURES` in a row syncing stops the same way; it starts again by itself on the first cycle where a fetch succeeds, tried every `SC_SYNC_RETRY_STOPPED` seconds.
   - Each restart appends `sync-resumed`, which does not wake sous chef. While the owner is in the middle of a rebase or merge in the folder, a cycle does nothing.
   - Whether syncing is stopped, why, and the failure count are in `state/sync/state.json`, written only by the watcher. The first wake-up for `sync-stopped` goes out in the cycle that wrote it; after that it backs off as in check 5 until the sync log is acknowledged.

A failing `cron.tick`, Slack poll or sync is logged in the cycle's actions and does not stop the session checks.

A session whose launch failed has no runtime handle, and the watcher skips it entirely; it stays listed in `sc sessions` until `sc cleanup`.

All wake-ups for sous chef in a cycle are sent as one line naming the sessions, and saying when scheduled jobs or Slack messages are waiting, or syncing stopped. Watcher bookkeeping (what was flagged, when a session went missing, re-send counts) lives in `state/watch.json`, with the cron, slack and sync logs' retry counts under `cron`, `slack` and `sync`; entries for cleaned-up sessions are dropped. What jobs did is kept separately, in `state/cron/runs.json`.

## Settings

Environment variables. `SC_WATCH_POLL` is read once when the watcher starts; the rest are read on every cycle, which is what lets `sc watch --once` be run with different values:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SC_WATCH_POLL` | 15 | Seconds between cycles |
| `SC_SILENT_GRACE` | 600 | Seconds idle after a turn before a silent stop is reported |
| `SC_INBOX_GRACE` | 120 | Seconds before an unhandled message is re-sent, and between re-sends |
| `SC_INBOX_RINGS` | 3 | Re-sends before `inbox-unread` |
| `SC_WAKE_RETRY` | 120 | First retry delay for unread events |
| `SC_GONE_GRACE` | 60 | Seconds a session must stay missing before it is reported `gone` or resumed |
| `SC_AUTO_RESUME_MAX` | 24 | Automatic resumes allowed per session in any 24 hours; 0 turns automatic resuming off |
| `SC_AUTO_RESUME_MIN_UP` | 600 | Seconds a session must stay running after an automatic resume before it may be resumed automatically again |
| `SC_PROMPT_GRACE` | 180 | Seconds the same prompt must stay open before `prompt-waiting` is reported |
| `SC_INFLIGHT_MAX` | 7200 | Seconds after a turn ended during which work in flight holds a silent stop back (see "Work in flight") |
| `SC_SLACK_LATE` | 3600 | Seconds after Slack delivered a message past which `sc events` marks it late (read when `sc events` runs, not by the watcher) |
| `SC_SYNC_QUIET` | 120 | Seconds with no change in the data folder before it is committed |
| `SC_SYNC_RETRY` | 60 | First delay before retrying a failed fetch or push; doubles, up to 30 minutes |
| `SC_SYNC_MAX_FAILURES` | 5 | Failed fetches or pushes in a row before syncing stops |
| `SC_SYNC_RETRY_STOPPED` | 600 | Seconds between fetches that check whether a stopped sync can start again |
| `SC_STALE_BUSY` | 300 | Seconds after a turn ended, with no prompt since, after which the session counts as idle even if the runtime says busy |

## Running it

- Sous chef's SessionStart hook calls `watch.ensure`, which starts `sc watch` in the background if no watcher holds `state/watch.lock`, and replaces a running watcher that is not on the current code (below). `sc watch --ensure` does the same by hand and says what it did.
- Only one watcher runs per home: `run_forever` takes the lock and exits if another watcher has it. It retries for 2 seconds first, because `is_running` checks by taking the lock for an instant.
- It logs actions and errors to `state/watch.log`, writes its pid to `state/watch.pid`, records the code it loaded in `state/watch.code` (pid, a hash of `bin/sc` and `lib/sc/`, poll interval, start time), and touches `state/watch.beat` every cycle. The log is cleared when it is over 1 MB **at startup**, so a watcher running for weeks does not truncate until it restarts.
- A failing cycle is logged and the loop continues.
- `sc watch --once` runs a single cycle and prints what it did; the tests use this with a controlled clock (`SC_FAKE_NOW`).

### When the code changes

A watcher runs the code it loaded when it started. A watcher that ran for three days on the code from before scheduled jobs existed never fired a job, and nothing said why. So a change to `sc` now reaches a running watcher in two ways:

- **The watcher restarts itself.** After each cycle, with that cycle's state written, it hashes its code on disk (`watch.code_fingerprint`). If the hash differs from the one it started with, it checks the new code loads (`sc --help` in a separate process) and then replaces itself with it in the same process (`os.execv`). The new code takes the lock the way any starting watcher does. New code that does not load, for example a file caught half written, is logged once and the watcher keeps running what it has.
- **`ensure` replaces a watcher it cannot vouch for.** That is one whose `watch.code` is missing or names a different pid (it was started by code from before this check), or one still on old code after a cycle's chance to restart itself. It waits for the watcher to finish a cycle (its heartbeat changes), sends it SIGTERM while it sleeps, waits for the lock to be free, and only then starts a new one. A watcher on the current code handles SIGTERM by stopping between cycles, never inside one; one from before this change has no handler and dies where it is, which is asleep. `ensure` never kills a watcher outright: if it does not finish a cycle within its poll interval plus 10 seconds, or keeps the lock for more than 10 seconds after SIGTERM, it is left running and `ensure` says so. All of `ensure`'s waiting before the SIGTERM fits in 30 seconds, so the whole replacement stays inside the SessionStart hook's 60-second timeout. The lock keeps it to one watcher even if two `ensure`s race.

`watch.health` says whether the running watcher is on the current code. The startup summary shows it under "Watcher", and `sc cron list` uses it (`docs/domains/cron.md`).

It is not a system service, so it does not come back after a reboot until sous chef starts again. The startup summary says when it is not running. See the shortcuts table in `docs/architecture.md`.

## Verification

Syncing (check 9) is covered by `tests/test_sc.py` (`SyncTests`) against local bare repos standing in for GitHub, with the fake clock: nothing without an upstream, the quiet period (and a new change restarting it), commit and push, `state/` and `.env` kept out with no `.gitignore`, rebasing onto a remote that moved on, a conflict stopping syncing (folder untouched, sous chef woken, no retry until the owner resolves it, then `sync-resumed` and a push), five failed pushes with back-off stopping it and a later successful fetch restarting it, and nothing done while a merge is in progress. Not verified: syncing against GitHub itself over SSH.

Each check is covered by `tests/test_sc.py` (`WatcherTests`, `PromptWatcherTests` for check 2, and `CronTests` for checks 6 and 7) against the fake runtime. For check 2 the tests cover: reported once after the grace period and not on later polls, not before it, a prompt answered within the grace period never reported, `prompt-answered` giving back "waiting on" (and a silent stop still noticed after it) but not overwriting a later `sc mark`, a different prompt reported on its own, a held session not re-sent messages or called a silent stop, and a session that stops while held reported as `gone`. Making the event fire on every poll, or before the grace period, makes those tests fail. `ClaudeRuntimeParsingTests` checks `claude_bg.status` against the listing row and job file captured live at a permission prompt. For work in flight, `WatcherTests` covers: no silent stop while work is in flight however long the turn has been over, one reported a grace period after the work finishes (not straight away) and only once, the 2-hour limit, a new turn judged on its own stop, and activity the watcher cannot use (none, an unknown count, a malformed value) leaving check 3 as it was. `ClaudeRuntimeParsingTests` checks `claude_bg._activity` against the orchestrator's job file as read live, and against missing, malformed and reshaped files, `queued` alone, and a file for another session. Removing the hold, counting the grace from the stop, or removing the limit each makes a test fail. `claude_bg.status` was also run against the live TRV-1114 orchestrator and returned its detail, `in_flight: 2` and its two running reviewer subagents. Not verified: the watcher holding back a real silent stop for a real session, and whether every finishing subagent wakes the session with a new prompt (if one does not, the session is reported one grace period after its work ends, as for any stop). For automatic resuming, `WatcherTests` and `PromptWatcherTests` cover: a session waiting on the owner resumed rather than reported, sent the message, still waiting on the owner, with no wake-up for sous chef and no silent stop for its old turn afterwards; sessions waiting on `sc` (an open question), `external` (paused) and at a prompt resumed; ones working, finished or stopped by sous chef not resumed; a failed resume reported as `gone` once; the 10-minute and 24-hour limits; and `SC_AUTO_RESUME_MAX=0`. Not verified: the watcher resuming a real Claude session that stopped while idle, and whether a resumed session acts on the message (for example restarting its page server) without further help. `WatcherCodeTests` starts real watcher processes (no Claude sessions) from a copy of the code in a temporary folder, changes that copy, and checks the watcher restarts itself, refuses code that does not load, and is replaced by `ensure` when it cannot vouch for its code. Replacing a watcher running the code from before this change was also done by hand: it was running, the new code was copied over it, and `sc watch --ensure` waited for its cycle (about 15 seconds), stopped it, and left exactly one watcher on the new code. Removing the "waiting on agent" condition or the re-send limit makes those tests fail. The checks have not yet been exercised by a running watcher against real Claude sessions: only the watcher starting from the live hook was observed. For check 2, the runtime side was run against real sessions held at a permission prompt (see "How a prompt is detected"); the watcher cycle on top of it was not.
