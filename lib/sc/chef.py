"""Which Claude session is sous chef, and how to wake it.

state/chef.json records which session is sous chef:
{"session_id": "...", "runtime": "claude-bg", "registered_at": ...}.
The SessionStart hook (hooks.chef_start) writes it on startup, resume, clear
and compaction, so it follows sous chef across restarts.

A session only takes the registration when no other live session holds it (see
`live_incumbent`). Any session started in this folder runs the hook -- one
the owner opens by hand, one spawned into a worktree of this repo -- and without
that check the newcomer would silently become sous chef and wake-ups would
start going to it instead.
"""
import os
import subprocess
from pathlib import Path

from . import runtimes, util, wake


def path():
    return util.state_dir() / "chef.json"


def current():
    return util.read_json(path())


def register(session_id: str, runtime: str = "claude-bg") -> dict:
    prev = current()
    data = {"session_id": session_id, "runtime": runtime, "registered_at": util.now()}
    util.write_json(path(), data)
    return prev


def worktree_of_home():
    """The real sous chef folder, when this copy of the code is a git worktree of it.

    Checks the code folder (`CODE_ROOT`), not the data folder: the data folder says
    nothing about where the code came from, and a worktree of the core has no `my`
    link, so this must work without one. Without this check a session started in a
    worktree would register as sous chef, start a second watcher and be handed the
    "you are sous chef" summary, while the real sous chef runs elsewhere and knows
    nothing of it. Returns None for the ordinary checkout, and for anything that is
    not a git worktree at all.

    Tests run from whatever checkout the suite is in, often a worktree, so with
    SC_TEST_HOME set the check is made only when SC_TEST_WORKTREE_CHECK is set too.
    """
    if os.environ.get("SC_TEST_HOME") and not os.environ.get("SC_TEST_WORKTREE_CHECK"):
        return None
    root = util.CODE_ROOT
    try:
        out = subprocess.run(["git", "-C", str(root), "rev-parse", "--git-dir", "--git-common-dir"],
                             capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    parts = out.stdout.split()
    if len(parts) != 2:
        return None
    git_dir, common = (p if Path(p).is_absolute() else Path(root) / p for p in parts)
    if "worktrees" not in Path(git_dir).parts:
        return None
    return Path(common).parent


def live_incumbent():
    """The registered sous chef session, if it may still be running.

    `None` means the registration is free to take: nothing is registered, or the
    session named is definitely gone. A runtime that cannot be asked counts as
    still running, so a failed check never hands sous chef's identity to another
    session; `sc chef --take` is the way to take it deliberately.
    """
    info = current()
    if not info or not info.get("session_id"):
        return None
    rt = runtimes.get(info.get("runtime", "claude-bg"))
    try:
        row = rt.listing().get(info["session_id"])
    except (util.SCError, OSError):
        return info
    return info if row and (row.get("pid") or row.get("alive")) else None


def status() -> dict:
    """{"alive", "busy"} for the registered sous chef session. `busy` None means unknown, never idle."""
    info = current()
    if not info or not info.get("session_id"):
        return {"alive": False, "busy": None}
    rt = runtimes.get(info.get("runtime", "claude-bg"))
    try:
        return rt.status_session_id(info["session_id"])
    except (util.SCError, OSError):
        return {"alive": False, "busy": None}


def wake_chef(text: str, rows=None) -> bool:
    """Try to wake sous chef. Returns False (never raises) when it cannot."""
    info = current()
    if not info or not info.get("session_id"):
        return False
    rt = runtimes.get(info.get("runtime", "claude-bg"))
    try:
        rt.wake_session_id(info["session_id"], text, rows)
        return True
    except (wake.WakeError, util.SCError):
        return False
