"""Runtimes: how a session is actually run.

Everything else in sous chef talks to a session only through the runtime named
in its record, so adding another agent tool (for example Codex in tmux) means
adding a module here with the same functions:

  NAME                                   the value stored in record["runtime"]
  launch(rec, prompt, env, settings)     start the session; return a handle dict
  resume(rec, env, settings)             start a stopped session again
  stop(rec)                              stop it, verifying it stopped
  status(rec, rows=None)                 {"alive": bool, "busy": bool|None, "pid": ...,
                                          "prompt": str|None}
                                         busy None means the runtime cannot tell; no
                                         caller may treat that as idle. prompt is set
                                         while the session is held mid-turn by something
                                         only a person can answer (for Claude, a
                                         permission prompt or another dialog), saying
                                         what; a session held there counts as busy.
                                         Optionally also "activity": None when the runtime
                                         cannot tell, else {"detail": str|None, "in_flight":
                                         int|None, "running": [{"kind", "label", "since"}]}:
                                         what the session says it is doing, how many
                                         subagents and background commands it started are
                                         still running (None: cannot tell), and which
                                         (for display only). Callers read it with .get()
  listing()                              one snapshot of all sessions, for batching
  wake(rec, text, rows=None)             deliver a short wake-up line; raise WakeError
                                         whose message says why, since callers print it
  wake_session_id(id, text, rows=None)   wake any session by the tool's own session id
  status_session_id(id, rows=None)       `status` for any session by the tool's own session id
                                         (these two only if sous chef itself runs on this runtime)
  start_named(name, prompt, cwd, env, permissions)
                                         start sous chef's own session; return its short id
  resume_session_id(id, cwd, env)        continue it by the tool's own session id; return its
                                         short id, or None if it did not come back
  stop_short(short_id)                   stop it
  attach_exec(short_id, cwd, env)        attach this terminal to it
                                         (these four, used by `souschef`, only if sous chef itself
                                         runs on this runtime; `souschef` uses claude-bg unless
                                         SC_CHEF_RUNTIME names another, which only tests do)
  attach_command(rec)                    the command the owner runs to open the session
  skill_available(name, cwd)             whether a session in cwd can run the skill `name`:
                                         True, False, or None when the runtime cannot tell.
                                         cwd None means no project (`sc kinds`): check only
                                         what every session gets. Only False refuses a spawn
  skill_places(cwd)                      where skill_available looks, as a list of strings
                                         for the refusal message

`settings` is the hook configuration sous chef wants for the session, in Claude
Code settings shape. A runtime for another tool translates it or ignores it.

`rec["permissions"]` is how much the session may do without asking, as one of
PERMISSIONS below; a record without it means DEFAULT_PERMISSIONS. `launch` turns it
into the tool's own setting, and `resume` must keep it. A runtime that cannot honour
a value raises SCError from `launch` rather than running with another.
"""
from ..util import SCError
from . import claude_bg, fake

# What a session may do without asking a person. Chosen per spawn (`sc spawn --permissions`).
PERMISSIONS = {
    "auto": "a classifier decides each action; anything it judges risky waits for a person",
    "accept-edits": "file edits go ahead; other actions wait for a person",
    "bypass": "everything goes ahead; nothing ever asks",
    "ask": "every action that needs permission waits for a person",
}
DEFAULT_PERMISSIONS = "auto"

_RUNTIMES = {m.NAME: m for m in (claude_bg, fake)}
DEFAULT = claude_bg.NAME


def get(name: str):
    try:
        return _RUNTIMES[name]
    except KeyError:
        raise SCError(f"unknown runtime '{name}' (known: {', '.join(sorted(_RUNTIMES))})")
