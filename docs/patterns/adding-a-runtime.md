# Adding a runtime

A runtime is how a session actually runs. Today there is `claude-bg` (Claude Code background sessions) and `fake` (tests). A runtime for another agent tool, for example Codex in tmux, goes in `src/runtimes/` and nothing outside that folder should need to change.

In the TypeScript sc, `claude-bg` is still a stub (`src/runtimes/claude-bg.ts`): it refuses everything except `attachCommand` and the skill lookup (`src/runtimes/claude-skills.ts`). The Claude runtime itself arrives with TRV-1155 (the Claude runtime on Porch); until then `lib/sc/runtimes/claude_bg.py`, the Python one, shows how each part works against Claude Code.

## The contract

A runtime is an object implementing the `Runtime` interface in `src/runtimes/types.ts`. Every method that touches the tool is `async`, so the watcher never blocks while it waits (see `docs/domains/watcher.md`, "Running it"):

| Name | Must |
| --- | --- |
| `NAME` | The value stored in `record.runtime` |
| `listing()` | Return one snapshot of all sessions, so a watcher cycle calls the tool once. Code outside the runtime reads only `pid`, `alive`, `kind`, `id` and `name` from its rows |
| `status(rec, rows?)` | Return a `Status`: `{alive, busy, pid, prompt}`; `busy` is `null` when unknown, and unknown must never be reported as idle. `prompt` is `null`, or text saying what the session is held at mid-turn that only a person can answer (such a session is busy); a runtime that cannot tell returns `null`, and then the watcher cannot report held sessions. It may also return `activity` (the `Activity` shape), or `null`; without it, `sc sessions` shows no detail and the watcher cannot hold back a silent stop for a session waiting on its own subagents |
| `launch(rec, prompt, env, settings)` | Start the session in `rec.cwd` with `env` added to its environment, honouring `rec.permissions` (one of `PERMISSIONS`; missing means `auto`), and return a handle object; throw `SCError` if it did not start, or if it cannot honour the permissions value, rather than running with another |
| `resume(rec, env, settings)` | Continue the stopped session itself, with the permissions it was launched with. The Claude runtime ignores `env` and `settings`, because the session kept its own and passing them would start a copy; another tool may need them |
| `stop(rec)` | Stop it and check that it stopped |
| `wake(rec, text, rows?)` | Deliver a one-line wake-up, throwing `WakeError` that says why, since callers print the reason |
| `wakeSessionId(sessionId, text, rows?)` | Only meaningful if sous chef itself can run on this runtime; otherwise throw `SCError` |
| `statusSessionId(sessionId, rows?)` | The same as `status`, by the tool's own session id. Only meaningful if sous chef itself can run on this runtime; scheduled jobs use it to wake sous chef only when it is idle |
| `attachCommand(rec)` | Return the command the owner runs to open the session |
| `skillAvailable(name, cwd)` | Say whether a session of this runtime in `cwd` can run the skill `name`: `true`, `false`, or `null` when the runtime cannot tell. `cwd` is `null` for `sc kinds`, which has no working directory: check only what every session gets. Only `false` makes `sc spawn` refuse, so answer `false` only when the skill is definitely not there; a runtime whose tool has no skills, or that cannot look, returns `null` |
| `skillPlaces(cwd)` | Return where `skillAvailable` looks, as a list of strings, for the refusal message |

The interface also has the four methods `souschef` uses besides `listing` and `attachCommand`: `startNamed(name, prompt, cwd, env, permissions)` (start sous chef's session, return its short id), `resumeSessionId(sessionId, cwd, env)` (continue it, return its short id or `null` if it did not come back), `stopShort(shortId)` and `attachExec(shortId, cwd, env)` (attach this terminal, return the exit code). A runtime sous chef itself cannot run on throws `SCError` from them. Its `listing` rows must carry `pid` while running and `kind` (`background` or not), which `souschef` decides from. `souschef` runs on `claude-bg` unless `SC_CHEF_RUNTIME` names another runtime, which only tests do; the fake runtime (`src/runtimes/fake.ts`) implements the four for them. Nothing outside `src/runtimes/` runs the agent tool directly.

## What a new runtime has to provide for the rest to work

- **The `sc` command inside the session.** The brief gives its full path, so nothing is needed from the environment.
- **Turn times**: something that runs `sc hook worker-prompt --session <id>` when a turn starts and `sc hook worker-stop --session <id>` when it ends. Without them the watcher cannot notice silent stops. `settings` carries these as Claude Code hooks; a runtime for another tool translates them into that tool's equivalent, or documents that silent stops are not detected.
- **A reminder after a restart**: the equivalent of `sc hook worker-start`, so a resumed session reads its brief and inbox.
- **A wake-up path**: for a terminal-based tool this is typically typing one line into its window (for example `tmux send-keys`). The message itself is already in the inbox, so the line only has to prompt the agent to run `sc inbox`.
- **Identity**: `currentSessionRecord` in `src/ops.ts` finds the calling session from `CLAUDE_CODE_SESSION_ID`, which Claude Code sets itself. Another tool needs an id the tool itself sets inside the session and that the runtime records at launch. Do not use a variable sous chef passes at launch; see "Which session is calling" in `docs/domains/sessions.md`.

## Steps

1. Add `src/runtimes/<name>.ts`, exporting an object that implements `Runtime`, and add it to `RUNTIMES` in `src/runtimes/index.ts`. Run any program through `run` in `src/proc.ts` (it never blocks and never throws on a non-zero exit), and do not import anything dynamically: a rebuild replaces `dist/` while the watcher runs.
2. Decide how `sc spawn` selects it. Today the only way is the hidden `--runtime` flag, which the tests use.
3. Verify the tool's behaviour by running it, and record what was verified in `docs/domains/sessions.md` in the same form as the Claude section, including how `sc spawn` selects the runtime (today only the hidden `--runtime` flag).
