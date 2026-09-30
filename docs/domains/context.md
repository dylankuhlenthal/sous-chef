# Context check: a warning before compaction

Sous chef runs in one long Claude Code session. When its context fills, Claude Code compacts the conversation, and anything sous chef was holding only in the conversation is lost. Nothing can trigger or put off a compaction from inside or outside the conversation, so the check does not try. It makes sure sous chef has been told to write its working state to `memory/` before the compaction that is coming anyway.

At the end of every sous chef turn, a Stop hook reads how full the context is. Past a configured percentage of the model's context window, it writes one warning into the context log, which sous chef reads with `sc events`. The warning never wakes sous chef.

Code: `lib/sc/context.py` (`read_usage`, `find_transcript`, `on_stop`, `status_lines`, `set_config`), `lib/sc/hooks.py` (`chef_stop`), `lib/sc/events.py` (`CONTEXT_LOG`, `CHEF_LOGS`), `lib/sc/cli.py` (`cmd_context`, `cmd_events`), `lib/sc/summary.py` (`build`), `.agents/settings.json` (the Stop hook).

Paths such as `state/...`, `memory/...` and `context.json` in this doc are in the owner's data folder, which the core reaches as `my/` (`docs/architecture.md`, "Two folders joined by one link").

## Where the number comes from

Claude Code does not publish how full a session's context is. It can be read from the session's transcript, which is undocumented but has held this shape in every transcript checked:

- The transcript is `~/.claude/projects/<project>/<session id>.jsonl`, one JSON object per line. Hook payloads carry its path as `transcript_path`.
- Every assistant line (`"type": "assistant"`) has `message.usage`, the API usage of the call that produced it, and `message.model`.
- The prompt that call sent is the whole context at that point: `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. `output_tokens` is left out; it becomes part of the next call's prompt.

`context.read_usage` reads the file backwards from the end, a megabyte at a time, and stops at the first line that settles the answer, so the cost does not grow with the file (sous chef's was 5.4 MB, read in about 50 ms). Going backwards it:

- skips lines that are not JSON (a line still being written), subagent lines (`isSidechain`), and messages Claude Code makes up itself (`model` `<synthetic>`, all-zero usage, for example an API error notice);
- returns "compacted" if it meets a compaction marker (`"subtype": "compact_boundary"`) before any assistant line, because no turn has run since;
- otherwise uses the newest assistant line. If that line has no `message`, no `usage`, or usage without the three fields, it fails, naming what is missing. It does not fall back to an older line, because that number would be out of date.

It fails too when the file is missing, or when 32 MB from the end hold no assistant line.

`find_transcript` uses the payload's `transcript_path`, and without it looks for `~/.claude/projects/*/<session id>.jsonl`, so it does not depend on how Claude Code names project folders.

## Configuration

Two things set the check, both in `context.json` at the top of the data folder (`my/context.json`). Like `cron/`, it is configuration the owner keeps, with their data, changed with a command rather than code.

| Setting | Meaning |
| --- | --- |
| `warn_at` | Warn when usage reaches this percentage of the window. Absent means the check is off. |
| `rearm_below` | After a warning, warn again only once usage has fallen below this percentage. Default: 10 points under `warn_at`. |
| `windows` | The context window in tokens, per model id as the transcript names it, for example `{"claude-opus-5": 1000000}`. |

`sc context` shows the settings and the last reading, `sc context set --warn-at N --window MODEL=TOKENS` changes them (`--rearm-below N` too), and `sc context off` removes `warn_at` and keeps the windows. `sc context check` reads sous chef's transcript now and prints the number, changing nothing; `--transcript PATH` reads another file. The startup summary has the same lines as `sc context` under "Context check", so after every start or compaction sous chef can see whether it is being watched.

**Why the window is set per model.** The transcript names the model but not its window, and the same model can run with different windows. A single window setting would stay silently wrong after the model changed. Keyed by model, a model with no window set is a failure the check reports, so switching model asks for its window instead of using the old one. The check also fails if a reading is larger than the window set, since the window must then be wrong.

## One warning per crossing

`state/context/state.json` records the last reading, a failure streak, and whether the warning is armed. It starts armed. A reading at or over `warn_at` while armed writes a `context-high` event and disarms it. It is armed again when a reading falls below `rearm_below`, when the transcript shows a compaction with no turn since, or when a different session becomes sous chef.

Context usage rises in uneven steps, as the prompt cache is written and then read. With a gap between the two levels, a reading hovering around `warn_at` gives one warning, not one per turn. In practice the only thing that brings usage back down is a compaction, which is exactly when the warning should be armed again.

The `context-high` event gives the percentage, the tokens and the window, and asks sous chef to write anything it is holding that is not in `memory/` yet into the right memory file, bring `memory/focus.md` up to date, and then acknowledge the event.

## How it fails

A hook must never break its session, so `on_stop` does not raise. The failure to guard against is the quiet one: the reader finds nothing, no warning is written, and sous chef assumes it is being watched. So every way of not getting a trusted number is a failure, and failures are reported:

- The first failed check of a streak writes a `context-unreadable` event with the reason, telling sous chef that nothing will warn it and to keep `memory/` current as it goes. Later failures in the same streak only update the count, so a broken reader does not write an event every turn.
- The next successful check writes `context-readable`, so the earlier event is not left standing.
- `sc context` and the startup summary show `FAILING since ...` with the reason and the number of failed checks in a row, for as long as it lasts.
- An unexpected error inside the check is reported the same way, with the exception. A `context.json` that is not valid JSON is reported even though it cannot be told whether the check is on, since someone wrote it.
- If the hook stops running at all, for example because it was removed from the settings, nothing can write an event. `sc context` and the summary show when it last ran ("Last check: ... ago", or "never" with a pointer to the settings).

While the check is off it writes no events, but it still records its reading and any failure for `sc context`.

## The context log

The warnings go into one more event log, `state/context/events.jsonl` (`events.CONTEXT_LOG`, `context`), written with the same functions as the cron log (`docs/domains/cron.md`):

- `sc events` lists unread entries under `[context]`, and `sc events ack context:<n>` acknowledges them.
- The startup summary counts unread entries with the events that need attention.
- Nothing wakes sous chef for them. The hook runs at the end of a turn, often while the owner and sous chef are talking, and an extra turn started by a wake-up would interrupt that. The watcher's wake for unread chef-log events (check 7 in `docs/domains/watcher.md`) covers the cron log only.

The Stop hook prints nothing, because a Stop hook's output can make Claude Code keep the turn going.

Only the registered sous chef session is checked (`chef.current()`). Every session started in the core runs the hook, including one the owner opens by hand and one spawned into a worktree of the core; for any session but sous chef it does nothing.

## Known limits

- **Sous chef sees a warning only when it next runs `sc events`**, or at its next start or compaction. It runs `sc events` on every wake-up from a session or a job, but during a long conversation with the owner and no wake-ups it may not look before the compaction. The way to lift this is a UserPromptSubmit hook for sous chef that adds unread context warnings to the next turn's context, which shows them without waking anyone.
- **The transcript format is undocumented** and could change in any Claude Code release. The reader fails loudly rather than guessing, as above; a change means updating `read_usage`.
- **Nothing warns while sous chef is not running a turn**, since the check runs at the end of turns. Context only grows during a turn, so nothing is missed between them.

## Verification

`tests/test_sc.py` (`ContextCheckTests`) drives the real hook with transcript files shaped like real ones: a reading over the level warns once with its numbers and instructions, one under it says nothing, crossing and staying over warns once until usage falls below the re-arm level or the transcript shows a compaction, the warning wakes nobody (also after watcher cycles), and each failure is reported once with its recovery once: a missing transcript, final lines with no usage, a usage block with other fields, an assistant line with no usage, a model with no window set, and a broken `context.json`. Also covered: synthetic, subagent and half-written lines are skipped, a line is found behind 3 MB written after it, only the registered sous chef is checked, the transcript is found by session id without a path, the check is off by default, and bad settings are refused.

Checked against real transcripts:

- On sous chef's own 5.4 MB transcript, `sc context check` gave 664,020 tokens (2 input + 1,259 cache creation + 662,759 cache read, `claude-opus-5`), the same as parsing the whole file and taking the last usable line. The figure recorded shortly before, by hand, was 625,689; the difference is the turns in between.
- A headless `claude -p` session with a Stop hook received `session_id` and `transcript_path` in the payload, and the reader, run from inside that hook, found the usage of the turn that had just ended. So the line is written before Stop fires.
- Synthetic messages (`<synthetic>`, all-zero usage) and compaction markers (with `compactMetadata.preTokens`) were seen in real transcripts.

Not yet verified: the hook running in the real sous chef background session, and a warning seen and acted on before an automatic compaction.
