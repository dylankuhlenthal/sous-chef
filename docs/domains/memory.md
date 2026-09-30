# Memory and the startup summary

Sous chef is meant to run in one Claude Code session for as long as the owner likes. Claude Code compacts long conversations, and sessions restart. Sous chef survives both by keeping everything that matters in files and reloading a bounded summary of them whenever a session starts, resumes or is compacted.

Code: `lib/sc/summary.py` (`build`, `sessions_table`), `lib/sc/hooks.py` (`chef_start`, `chef_stop`), `lib/sc/chef.py`, `lib/sc/context.py`, `.agents/settings.json`. Rules for what sous chef writes: `AGENTS.md`, "Memory: write things down as they happen".

## Memory files

`my/memory/` (the `memory/` folder in the owner's data folder, reached through the `my` link in the core) is sous chef's own space, edited directly by sous chef without asking the owner. When the data folder is a git repo with a remote, the watcher commits and pushes it (`docs/domains/watcher.md`, check 9); nothing else does.

| File | Holds |
| --- | --- |
| `focus.md` | What sous chef and the owner are in the middle of, and the next step. Rewritten when the focus changes. |
| `threads/index.md` and `threads/<slug>.md` | One file per ongoing topic, with dated entries and links (Linear, PRs, sessions, reports); the index has one line per thread. |
| `ideas.md` | Ideas that are not a thread yet. |
| `pocs.md` | PoCs: where they live, what they proved, what is open. |
| `repos.md` | Short pointers to repos and their own docs. |

The owner's standing Slack instructions ("slack me when ...") live under a `## Slack me` heading in the memory file for the thing they are about: a thread file, a scheduled job's memory file (named by the job's `memory` field, a path in the data folder such as `memory/inbox-triage.md`), or `my/memory/slack.md` for anything general. `sc events` prints them under the events they concern; see "Standing instructions" in `docs/domains/slack.md`.

Other places stay canonical for their content, and memory links to them instead of copying: each repo's docs for how the repo works, and the places the owner's instructions name (their issue tracker, say). Sous chef asks before writing to a repo unless the owner asked for exactly that.

## The owner's instructions

The owner's own rules for sous chef live in `my/instructions.md`, not in the core's `AGENTS.md`, which names nothing specific to one owner (decision 0020). They include where the owner's notes on how to work with them are. Their rules for every session live in `my/worker-instructions.md`, which goes into each brief (`docs/domains/sessions.md`). In both files, `<!-- comments -->` are left out, so a starter file can explain itself without adding anything.

## The startup summary

`summary.build` produces:

- **Owner line**, first: `Owner: <name>. Branch prefix: <prefix>.` from `my/owner.json` (`summary.owner_line`, `util.owner`), or `No owner set: run sc owner set ...` when there is none, or why the file cannot be used. The summary never refuses: without an owner it still shows everything below, because this line is how sous chef learns the owner is missing.
- **The owner's instructions**, right after it: `my/instructions.md` in full up to `INSTRUCTIONS_CAP` (12,000 characters), under a heading telling sous chef to follow them as it follows `AGENTS.md`; `ABSENT` when there is no file (`summary.instructions_section`).
- **Sessions:** one line per active session with kind, running or stopped, waiting on, last event, open questions and unhandled messages.
- **Attention:** the count of unread events that need attention (`events.WAKE_STATES`, across the sessions, the cron log, the slack log and the sync log, plus every unread entry in the context log, so a session that only reported `working` is not counted here although `sc events` still lists it), the count of open questions, and, when there are any, the count of unread notes shown separately as needing no action. Any of the three prompts an instruction to run `sc events`. An unread job for sous chef (`docs/domains/cron.md`) is counted with the events that need attention, so a job that fired while sous chef was down is picked up here.
- **Watcher:** whether it is running.
- **Cron jobs:** one line per scheduled job (`summary.cron_lines`), and any broken definition.
- **Context check:** whether sous chef is warned before compaction, its settings, the last reading, and any failure to read (`context.status_lines`; `docs/domains/context.md`).
- **Slack:** off (no `.env`), or on with the relay's address, and whether the relay answered the watcher's last poll or since when it has not (`slack.status_lines`; `docs/domains/slack.md`).
- **Memory:** each memory file above, in full up to `FILE_CAP` (6,000 characters) each, headed with its path as `my/memory/<file>`.

The whole summary is capped at `TOTAL_CAP` (42,000 characters, roughly 10,500 tokens), so it stays affordable in a very long session. It is cut from the end, where the memory sections are, so the cap grew by the instructions' own cap when they were added (from 30,000) rather than letting them push memory out. Anything cut is marked with the file to read. `sc summary` prints the same text.

## The hook

`.agents/settings.json` (reachable as `.claude/settings.json`) runs `sc hook chef-start` on every SessionStart, with no matcher, so it fires for `startup`, `resume`, `clear` and `compact`. `hooks.chef_start`:

0. Before anything that needs the data folder: if the code folder is a git worktree of the core, tells the session it is not sous chef (`chef.worktree_of_home`); if there is no usable data folder, says what to run and stops (`util.home_problem`).
1. Checks whether another session already holds the role and is still running (`chef.live_incumbent`). If so it stops here, telling this session it is not sous chef and naming the one that is. Wake-ups follow the registration, so taking it from a running owner would leave that session unheard.
2. Otherwise registers the session in `my/state/chef.json` (`chef.register`), so wake-ups reach whichever session is sous chef now.
3. Starts the watcher if it is not running, or replaces it if it is not on the current code (`watch.ensure`); the summary gets a note when it replaced one or could not. Replacing waits for the old watcher to finish a cycle, so this step can take up to about 45 seconds, inside the hook's 60-second timeout.
4. On `startup`, notes if a dead session held the role before, so the takeover is visible.
5. Returns the startup summary as additional context, headed with the source and an instruction to trust the summary and files over conversation memory.

Step 1 compares session ids, not just "is something registered": the hook fires again on `resume` and `compact` for sous chef itself, and skipping the summary there would defeat the point of having one. A runtime that cannot be asked counts as still running, so a failed check never hands the role over by accident. `sc chef --take`, run inside the session that should have it, is the deliberate override for when the registered one is wedged.

This matters because **every** session started in the core runs the hook, including one the owner opens by hand and one spawned into a worktree of this repo. Before the check existed, the newcomer silently became sous chef and wake-ups started going to it.

The same settings file:

- runs `sc hook chef-stop` on every Stop, at the end of each turn, which checks how full sous chef's context is and warns it before compaction (`docs/domains/context.md`). It acts only for the registered sous chef session, and is off until a warning level is set;
- adds a PreToolUse hook (`sc hook guard-edit`) that denies Edit, Write, MultiEdit and NotebookEdit on anything under `my/state/` (checked on the resolved path, so through the link or in the data folder directly) and under the core's own `state/`; it keeps guarding the core's `state/` when there is no data folder. Spawned sessions run the same hook (`ops.worker_settings`), with their own `report.md` as the one allowed path. It does **not** cover Bash in either place, so a shell redirect or `sed -i` into `state/` still works; the rule is kept by instruction as well as by the hook;
- sets `"worktree": {"bgIsolation": "none"}` so sous chef can edit its own files when it runs as a background session;
- pre-approves four Bash patterns so sous chef is not asked every time: `sc`, `bin/sc`, `claude agents` and `claude logs`.

## Verified by running it

With a sous chef session running as a Claude Code background session (started directly, and later through `souschef`):

- On startup, the hook registered the session and the session reported receiving the summary with the watcher running.
- After stopping it, compacting it with `claude -p --resume <id> "/compact"`, and resuming it, the session could see summaries from both `resume` and `compact`, and quoted a `focus.md` marker it had never read in conversation.
- A Write into `state/` was denied by the guard with its message. A Write into `memory/` succeeded.
- `souschef` started sous chef, found it running on a second run, and after it was stopped resumed the same session, which then handled wake-ups from two sessions and acknowledged them.

After the split into a core and a data folder (TRV-1147), with a fresh install in a temporary folder: a plain `claude -p` in the core, in a folder Claude Code had not trusted, printed that it was ignoring `.agents/settings.local.json` because the workspace is not trusted, and its edit of `my/memory/focus.md` was refused as outside the allowed folders. The switch-over was rehearsed on a copy of the owner's folder, and the rehearsed core's summary opened with the owner and their instructions.

Not yet verified: automatic compaction (only manual), attaching with `souschef` in a real terminal, the owner running sous chef interactively with `claude` in the core, a plain `claude` in a **trusted** core editing `my/memory/` without asking (Claude Code only reads `additionalDirectories` from a trusted folder, and trusting a scratch folder would have meant editing the owner's `~/.claude.json`), and sous chef itself, as a bypass background session, editing `my/memory/` through the link.
