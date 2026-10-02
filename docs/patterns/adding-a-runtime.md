# Adding a runtime

A runtime is how a session actually runs. Today there is `claude-bg` (Claude Code background sessions) and `fake` (tests). A runtime for another agent tool, for example Codex in tmux, goes in `src/runtimes/` and nothing outside that folder should need to change.

`claude-bg` (`src/runtimes/claude-bg.ts`) reaches Claude Code through Porch used as a library: listing, status, waking, launching, turn times and the session's self status go through Porch, and resume, stop and attach run `claude` directly (`docs/domains/sessions.md`, "The Claude runtime"). A runtime for a tool Porch has an adapter for (Porch also knows Pi) is best built the same way, on Porch's `list`, `observe`, `deliver` and `launchPlan`; `createClaudeRuntime` takes Porch's harness name as an option, which its tests use to run it on Porch's fake adapter.

## The contract

A runtime is an object implementing the `Runtime` interface in `src/runtimes/types.ts`. Every method that touches the tool is `async`, so the watcher never blocks while it waits (see `docs/domains/watcher.md`, "Running it"):

| Name | Must |
| --- | --- |
| `NAME` | The value stored in `record.runtime` |
| `listing()` | Return one snapshot of all sessions, so a watcher cycle calls the tool once. Code outside the runtime reads only `pid`, `alive`, `kind`, `id` and `name` from its rows |
| `status(rec, rows?)` | Return a `Status`: `{alive, busy, pid, prompt}`; `busy` is `null` when unknown, and unknown must never be reported as idle. `prompt` is `null`, or text saying what the session is held at mid-turn that only a person can answer (such a session is busy); a runtime that cannot tell returns `null`, and then the watcher cannot report held sessions. It may also return `activity` (the `Activity` shape), or `null`; without it, `sc sessions` shows no detail and the watcher cannot hold back a silent stop for a session waiting on its own subagents. It may return `turns` (`{last_prompt_at, last_stop_at}` in epoch seconds) when the tool keeps its own turn record for this session; the watcher and `sc status` then use it instead of `turns.json`. For a session that is not running it may return `stopped` (`{source, status, reason}`: who says so, and the tool's own words), which only appears in the text of the watcher's `gone` event, as `<source> reports it as <status> (<reason>).` (the Claude runtime's source is `Porch`): no decision may use it, and whether sous chef stopped a session is the record's `stopped_by_sc`, never the runtime's |
| `launch(rec, prompt, env, settings)` | Start the session in `rec.cwd` with `env` added to its environment, honouring `rec.permissions` (one of `PERMISSIONS`; missing means `auto`), and return a handle object; throw `SCError` if it did not start, or if it cannot honour the permissions value, rather than running with another |
| `resume(rec, env, settings)` | Continue the stopped session itself, with the permissions it was launched with. The Claude runtime ignores `env` and `settings`, because the session kept its own and passing them would start a copy; another tool may need them |
| `stop(rec)` | Stop it and check that it stopped |
| `wake(rec, text, rows?)` | Deliver a one-line wake-up, throwing `WakeError` that says why, since callers print the reason |
| `wakeSessionId(sessionId, text, rows?)` | Only meaningful if sous chef itself can run on this runtime; otherwise throw `SCError` |
| `statusSessionId(sessionId, rows?)` | The same as `status`, by the tool's own session id. Only meaningful if sous chef itself can run on this runtime; scheduled jobs use it to wake sous chef only when it is idle |
| `attachCommand(rec)` | Return the command the owner runs to open the session |
| `reportStatus(rec, state, text)` | Optional. Tell the tool the state a session just reported with `sc report`, for a tool that keeps such a status (the Claude runtime sets Porch's self status). `sc report` calls it after the event is written and sous chef is woken. On failure it throws an `Error` whose message is the whole line, in the runtime's own words (the Claude runtime's start `porch status not updated: `); `sc report` prints that line on stderr and changes nothing else. A runtime without it is simply not told |
| `skillAvailable(name, cwd)` | Say whether a session of this runtime in `cwd` can run the skill `name`: `true`, `false`, or `null` when the runtime cannot tell. `cwd` is `null` for `sc kinds`, which has no working directory: check only what every session gets. Only `false` makes `sc spawn` refuse, so answer `false` only when the skill is definitely not there; a runtime whose tool has no skills, or that cannot look, returns `null` |
| `skillPlaces(cwd)` | Return where `skillAvailable` looks, as a list of strings, for the refusal message |

The interface also has the four methods `souschef` uses besides `listing` and `attachCommand`: `startNamed(name, prompt, cwd, env, permissions)` (start sous chef's session, return its short id), `resumeSessionId(sessionId, cwd, env)` (continue it, return its short id or `null` if it did not come back), `stopShort(shortId)` and `attachExec(shortId, cwd, env)` (attach this terminal, return the exit code). A runtime sous chef itself cannot run on throws `SCError` from them. Its `listing` rows must carry `pid` while running and `kind` (`background` or not), which `souschef` decides from. The Claude runtime starts sous chef through Porch's launch plan with no settings of its own, resumes it with `claude --bg --resume <session id>` and no other flags (a session Porch does not find counts as stopped), and attaches with Porch's `runLaunchPlan`. `souschef` runs on `claude-bg` unless `SC_CHEF_RUNTIME` names another runtime, which only tests do; the fake runtime (`src/runtimes/fake.ts`) implements the four for them. Nothing outside `src/runtimes/` runs the agent tool directly.

## What a new runtime has to provide for the rest to work

- **The `sc` command inside the session.** The brief gives its full path, so nothing is needed from the environment.
- **Turn times**: either the runtime's own record, returned as `turns` in `status` (the Claude runtime reads Porch's, recorded by Porch's hooks, and drops the two hooks below before launching), or something that runs `sc hook worker-prompt --session <id>` when a turn starts and `sc hook worker-stop --session <id>` when it ends, which write `turns.json`. Without either the watcher cannot notice silent stops. `settings` carries the two hooks as Claude Code hooks; a runtime for another tool translates them into that tool's equivalent, or documents that silent stops are not detected.
- **A reminder after a restart**: the equivalent of `sc hook worker-start`, so a resumed session reads its brief and inbox.
- **A wake-up path**: for a terminal-based tool this is typically typing one line into its window (for example `tmux send-keys`). The message itself is already in the inbox, so the line only has to prompt the agent to run `sc inbox`.
- **Identity**: `currentSessionRecord` in `src/ops.ts` finds the calling session from `CLAUDE_CODE_SESSION_ID`, which Claude Code sets itself. Another tool needs an id the tool itself sets inside the session and that the runtime records at launch. Do not use a variable sous chef passes at launch; see "Which session is calling" in `docs/domains/sessions.md`.

## Steps

1. Add `src/runtimes/<name>.ts`, exporting an object that implements `Runtime`, and add it to `RUNTIMES` in `src/runtimes/index.ts`. Run any program through `run` in `src/proc.ts` (it never blocks, never throws on a non-zero exit, and returns at its timeout even when the program's own children keep its output open), and do not import anything dynamically: a rebuild replaces `dist/` while the watcher runs.
2. Decide how `sc spawn` selects it. Today the only way is the hidden `--runtime` flag, which the tests use.
3. Verify the tool's behaviour by running it, and record what was verified in `docs/domains/sessions.md` in the same form as the Claude section, including how `sc spawn` selects the runtime (today only the hidden `--runtime` flag).
