"""Worktrees sous chef creates for sessions, following the owner's repo layout.

The owner's repos keep git data at the repo root (a `.bare/` folder with a `.git`
file, or a bare repo at the root) with worktrees as sibling folders, and shared
env files in `<root>/.local/` (see the repo-setup skill). `sc worktree` makes a
new branch and worktree there and records it in state/worktrees.json:

  {"<worktree path>": {"repo": ..., "branch": ..., "base": ..., "created_at": ...,
                       "session": "<id of the session using it, or null>"}}

That record is what lets `sc spawn` turn off Claude Code's background worktree
isolation for a session: only a worktree sous chef created, and no other active
session is using, counts as the session's own. Everywhere else the default stays.

Every change to the record also drops entries whose folder no longer exists and
that no active session holds (`_prune`), so worktrees removed by hand do not stay
listed. An entry whose folder exists is never dropped.
"""
import os
import re
import subprocess
from pathlib import Path

from . import records, util

_DIR_NAME = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def _path():
    return util.state_dir() / "worktrees.json"


def registry() -> dict:
    return util.read_json(_path(), {}) or {}


def _prune(data: dict) -> bool:
    """Drop entries whose folder is gone and no active session holds. True if any were dropped.

    Called with the lock held, before the record is written.
    """
    active = set(records.all_ids())
    gone = [path for path, entry in data.items()
            if not Path(path).exists() and entry.get("session") not in active]
    for path in gone:
        del data[path]
    return bool(gone)


def _git(*args, cwd=None) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)


def create(repo: str, branch: str, dir_name: str, base: str = None) -> dict:
    root = Path(repo).expanduser().resolve()
    if not root.is_dir():
        raise util.SCError(f"repo root does not exist: {root}")
    if not _DIR_NAME.match(dir_name) or dir_name in (".bare", ".local"):
        raise util.SCError("--dir must be a short lowercase kebab-case name (not .bare or .local)")
    common = _git("-C", str(root), "rev-parse", "--git-common-dir")
    if common.returncode != 0:
        raise util.SCError(f"{root} is not a git repository")
    target = root / dir_name
    if target.exists():
        raise util.SCError(f"{target} already exists")
    if _git("-C", str(root), "show-ref", "--verify", "--quiet", f"refs/heads/{branch}").returncode == 0:
        raise util.SCError(f"branch {branch} already exists; pick another name or use its existing worktree")

    fetch = _git("-C", str(root), "fetch", "origin")
    if fetch.returncode != 0:
        raise util.SCError(f"git fetch origin failed: {fetch.stderr.strip()}")
    if not base:
        head = _git("-C", str(root), "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
        base = head.stdout.strip().split("/", 1)[-1] if head.returncode == 0 else "main"
    start = f"origin/{base}"
    if _git("-C", str(root), "rev-parse", "--verify", "--quiet", start).returncode != 0:
        raise util.SCError(f"{start} does not exist")

    # Branch from origin's base, not from a local base worktree the owner may be using,
    # and without tracking: the first push sets the upstream.
    add = _git("-C", str(root), "worktree", "add", "--no-track", "-b", branch, str(target), start)
    if add.returncode != 0:
        raise util.SCError(f"git worktree add failed: {add.stderr.strip()}")

    linked, local = [], root / ".local"
    if local.is_dir():
        for f in sorted(local.iterdir()):
            if f.name.startswith(".env") and f.is_file() and not (target / f.name).exists():
                os.symlink(f"../.local/{f.name}", target / f.name)
                linked.append(f.name)

    entry = {"repo": str(root), "branch": branch, "base": base, "created_at": util.now(), "session": None}
    with util.locked(util.state_dir() / ".worktrees.lock"):
        data = registry()
        _prune(data)
        data[str(target)] = entry
        util.write_json(_path(), data)
    return {"path": str(target), "branch": branch, "base": base, "env_linked": linked,
            "has_local": local.is_dir()}


def release(sid: str) -> None:
    """Give up any worktree a session held, so it can be used again."""
    with util.locked(util.state_dir() / ".worktrees.lock"):
        data = registry()
        changed = False
        for entry in data.values():
            if entry.get("session") == sid:
                entry["session"] = None
                changed = True
        # After freeing it: the session is still active while it is cleaned up.
        if _prune(data) or changed:
            util.write_json(_path(), data)


def claim_for(cwd: str, sid: str) -> bool:
    """Claim a sous chef worktree for a new session. True if cwd is one and is now claimed.

    Refuses when another active session already uses it. A worktree whose
    previous session was cleaned up can be claimed again.
    """
    key = str(Path(cwd).resolve())
    with util.locked(util.state_dir() / ".worktrees.lock"):
        data = registry()
        if _prune(data):
            util.write_json(_path(), data)
        entry = data.get(key)
        if entry is None:
            return False
        holder = entry.get("session")
        if holder and holder != sid and holder in records.all_ids():
            raise util.SCError(f"worktree {key} is already used by active session {holder}")
        entry["session"] = sid
        util.write_json(_path(), data)
    return True
