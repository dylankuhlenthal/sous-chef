# Adding a runtime

A runtime is how a session actually runs. Today there is `claude-bg` (Claude Code background sessions) and `fake` (tests). A runtime for another agent tool, for example Codex in tmux, goes in `lib/sc/runtimes/` and nothing outside that folder should need to change.

## The contract

A runtime module defines these, as documented in `lib/sc/runtimes/__init__.py`:

| Name | Must |
| --- | --- |
| `NAME` | The value stored in `record["runtime"]` |
| `listing()` | Return one snapshot of all sessions, so a watcher cycle calls the tool once |
| `status(rec, rows=None)` | Return `{"alive", "busy", "pid", "prompt"}`; `busy` is `None` when unknown, and unknown must never be reported as idle. `prompt` is `None`, or text saying what the session is held at mid-turn that only a person can answer (such a session is busy); a runtime that cannot tell returns `None`, and then the watcher cannot report held sessions. It may also return `activity` (shape in `lib/sc/runtimes/__init__.py`), or `None`; without it, `sc sessions` shows no detail and the watcher cannot hold back a silent stop for a session waiting on its own subagents |
| `launch(rec, prompt, env, settings)` | Start the session in `rec["cwd"]` with `env` added to its environment, honouring `rec["permissions"]` (one of `runtimes.PERMISSIONS`; missing means `auto`), and return a handle dict; raise `SCError` if it did not start, or if it cannot honour the permissions value, rather than running with another |
| `resume(rec, env, settings)` | Continue the stopped session itself, with the permissions it was launched with. The Claude runtime ignores `env` and `settings`, because the session kept its own and passing them would start a copy; another tool may need them |
| `stop(rec)` | Stop it and check that it stopped |
| `wake(rec, text, rows=None)` | Deliver a one-line wake-up, raising `WakeError` that says why, since callers print the reason |
| `wake_session_id(session_id, text, rows=None)` | Only needed if sous chef itself can run on this runtime |
| `status_session_id(session_id, rows=None)` | The same as `status`, by the tool's own session id. Only needed if sous chef itself can run on this runtime; scheduled jobs use it to wake sous chef only when it is idle |
| `attach_command(rec)` | Return the command the owner runs to open the session |
| `skill_available(name, cwd)` | Say whether a session of this runtime in `cwd` can run the skill `name`: `True`, `False`, or `None` when the runtime cannot tell. `cwd` is `None` for `sc kinds`, which has no working directory: check only what every session gets. Only `False` makes `sc spawn` refuse, so answer `False` only when the skill is definitely not there; a runtime whose tool has no skills, or that cannot look, returns `None` |
| `skill_places(cwd)` | Return where `skill_available` looks, as a list of strings, for the refusal message |

If sous chef itself can run on the runtime, it also needs the four functions `souschef` uses besides `listing` and `attach_command`: `start_named(name, prompt, cwd, env, permissions)` (start sous chef's session, return its short id), `resume_session_id(session_id, cwd, env)` (continue it, return its short id or `None` if it did not come back), `stop_short(short_id)` and `attach_exec(short_id, cwd, env)` (see `lib/sc/runtimes/claude_bg.py`). Its `listing` rows must carry `pid` while running and `kind` (`background` or not), which `souschef` decides from. `souschef` runs on `claude-bg` unless `SC_CHEF_RUNTIME` names another runtime, which only tests do; the fake runtime (`lib/sc/runtimes/fake.py`) implements the four for them. Nothing outside `lib/sc/runtimes/` runs the agent tool directly.

## What a new runtime has to provide for the rest to work

- **The `sc` command inside the session.** The brief gives its full path, so nothing is needed from the environment.
- **Turn times**: something that runs `sc hook worker-prompt --session <id>` when a turn starts and `sc hook worker-stop --session <id>` when it ends. Without them the watcher cannot notice silent stops. `settings` carries these as Claude Code hooks; a runtime for another tool translates them into that tool's equivalent, or documents that silent stops are not detected.
- **A reminder after a restart**: the equivalent of `sc hook worker-start`, so a resumed session reads its brief and inbox.
- **A wake-up path**: for a terminal-based tool this is typically typing one line into its window (for example `tmux send-keys`). The message itself is already in the inbox, so the line only has to prompt the agent to run `sc inbox`.
- **Identity**: `ops.current_session_record` finds the calling session from `CLAUDE_CODE_SESSION_ID`, which Claude Code sets itself. Another tool needs an id the tool itself sets inside the session and that the runtime records at launch. Do not use a variable sous chef passes at launch; see "Which session is calling" in `docs/domains/sessions.md`.

## Steps

1. Add `lib/sc/runtimes/<name>.py` and register it in `_RUNTIMES` in `lib/sc/runtimes/__init__.py`.
2. Decide how `sc spawn` selects it. Today the only way is the hidden `--runtime` flag, which the tests use.
3. Verify the tool's behaviour by running it, and record what was verified in `docs/domains/sessions.md` in the same form as the Claude section, including how `sc spawn` selects the runtime (today only the hidden `--runtime` flag).
