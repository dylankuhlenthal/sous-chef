"""Keeping the owner's data folder committed and pushed, from the watcher (watch.cycle).

Only when the data folder is a git repo whose branch has an upstream (`sc setup`
sets one when it pushes). Otherwise this does nothing.

Each watcher cycle:

1. Changes to files git does not ignore start a quiet period. Once nothing has
   changed for SC_SYNC_QUIET seconds (2 minutes), it commits them all as
   `sync: <files>`. `state/` and `.env` are never committed, whatever the data
   folder's .gitignore says.
2. When the branch has commits the upstream lacks and no tracked file has an
   uncommitted edit (git would refuse to rebase over one), it fetches, rebases
   onto the upstream if the remote moved on, and pushes. It never force-pushes.
3. A rebase that conflicts (leaves unmerged files) is aborted, leaving the folder as it was, and syncing
   stops: `sync-stopped` in the sync log, which wakes sous chef. It starts again
   by itself on the first cycle where the folder has no rebase in progress, no
   unmerged files, and a different commit checked out than at the conflict (the
   owner rebased or merged by hand).
4. A failed fetch or push is retried later, backing off from SC_SYNC_RETRY
   seconds. After SC_SYNC_MAX_FAILURES (5) in a row, syncing stops the same way;
   it starts again by itself on the first cycle where a fetch succeeds.

Each restart appends `sync-resumed`, which does not wake sous chef. Git never
prompts (GIT_TERMINAL_PROMPT=0, SSH in batch mode) and every call times out.
While the owner is in the middle of a rebase or merge, a cycle does nothing.

Files:
  state/sync/state.json    written only by the watcher: stopped or not, why, failures
  state/sync/events.jsonl  the sync log (events.SYNC_LOG), read with `sc events`
"""
import hashlib
import os
import subprocess
from pathlib import Path

from . import events, util

GIT_TIMEOUT = 60
NEVER_COMMITTED_PATHS = ("state", ".env")
NEVER_COMMITTED = tuple(f":(exclude){p}" for p in NEVER_COMMITTED_PATHS)


def _cfg(name, default):
    return float(os.environ.get(name, default))


def _state_path() -> Path:
    return util.state_dir() / "sync" / "state.json"


def _git(*args, timeout=GIT_TIMEOUT) -> subprocess.CompletedProcess:
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    env.setdefault("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")
    try:
        return subprocess.run(["git", "-C", str(util.home()), *args], capture_output=True, text=True,
                              timeout=timeout, env=env, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(args, 124, "", f"git {args[0]} timed out after {timeout}s")
    except OSError as e:
        return subprocess.CompletedProcess(args, 127, "", str(e))


def _out(*args) -> str:
    r = _git(*args)
    return r.stdout.strip() if r.returncode == 0 else ""


def _err(r) -> str:
    return " ".join((r.stderr or r.stdout or "").split())[:500]


def _busy_by_hand() -> bool:
    """A rebase or merge in progress, or unmerged files: the owner is working in the folder."""
    git_dir = Path(_out("rev-parse", "--absolute-git-dir") or "/nonexistent")
    if any((git_dir / name).exists() for name in ("rebase-merge", "rebase-apply", "MERGE_HEAD")):
        return True
    return bool(_out("diff", "--name-only", "--diff-filter=U"))


def _changes():
    """(files, signature) for what is not committed. The signature changes whenever any of it does."""
    status = _git("status", "--porcelain", "-z", "--untracked-files=all", "--", ".", *NEVER_COMMITTED)
    if status.returncode != 0:
        return [], ""
    files = [entry[3:] for entry in status.stdout.split("\0") if len(entry) > 3]
    h = hashlib.sha1(status.stdout.encode())
    for rel in files:
        try:
            st = (util.home() / rel).stat()
            h.update(f"{rel}\0{st.st_mtime_ns}\0{st.st_size}\0".encode())
        except OSError:
            h.update(f"{rel}\0gone\0".encode())
    return files, h.hexdigest()


def _message(files) -> str:
    shown = ", ".join(files[:5])
    return f"sync: {shown}" + (f" and {len(files) - 5} more" if len(files) > 5 else "")


def _stop(st: dict, why: str, detail: str, **extra) -> str:
    st.update({"stopped": why, **extra})
    text = {"conflict": "rebasing onto the remote conflicted, so the rebase was aborted and nothing was lost",
            "push": f"{st.get('failures')} fetches or pushes in a row failed"}[why]
    events.append(events.SYNC_LOG, "sync", "sync-stopped",
                  f"Syncing the data folder stopped: {text}. Git said: {detail}")
    return f"sync: stopped ({why})"


def _resume(st: dict, why: str) -> str:
    events.append(events.SYNC_LOG, "sync", "sync-resumed", f"Syncing the data folder started again: {why}.")
    for k in ("stopped", "conflict_head", "retry_at"):
        st.pop(k, None)
    st["failures"] = 0
    return "sync: resumed"


def _failed(st: dict, now: float, r) -> str:
    st["failures"] = st.get("failures", 0) + 1
    if st["failures"] >= int(_cfg("SC_SYNC_MAX_FAILURES", 5)):
        return _stop(st, "push", _err(r))
    st["retry_at"] = now + min(1800, _cfg("SC_SYNC_RETRY", 60) * 2 ** (st["failures"] - 1))
    return f"sync: fetch or push failed ({st['failures']} in a row), retrying later: {_err(r)}"


def tick() -> dict:
    """One watcher cycle of syncing. Returns {"actions": [...]}; never raises for git failures."""
    top = _out("rev-parse", "--show-toplevel")
    if not top or Path(top).resolve() != util.home().resolve():
        return {"actions": []}  # not a repo, or the data folder sits inside some other repo: not ours to commit
    upstream = _out("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
    if not upstream:
        return {"actions": []}
    remote = upstream.partition("/")[0]
    now = util.now()
    actions = []
    with util.locked(util.state_dir() / "sync" / ".lock"):
        st = util.read_json(_state_path(), {}) or {}
        head = _out("rev-parse", "HEAD")

        if st.get("stopped") == "conflict":
            if _busy_by_hand() or head == st.get("conflict_head"):
                util.write_json(_state_path(), st)
                return {"actions": actions}
            actions.append(_resume(st, "the conflict was resolved in the data folder"))
        elif st.get("stopped") == "push":
            if now < st.get("retry_at", 0):
                return {"actions": actions}
            r = _git("fetch", "--quiet", remote)
            if r.returncode != 0:
                st["retry_at"] = now + _cfg("SC_SYNC_RETRY_STOPPED", 600)
                util.write_json(_state_path(), st)
                return {"actions": actions}
            actions.append(_resume(st, "the remote can be reached again"))

        if _busy_by_hand():
            util.write_json(_state_path(), st)
            return {"actions": actions}

        files, sig = _changes()
        if files:
            if sig != st.get("sig"):
                st.update({"sig": sig, "changed_at": now})
            elif now - st.get("changed_at", now) >= _cfg("SC_SYNC_QUIET", 120):
                add = _git("add", "-A")
                if add.returncode == 0:  # then take state/ and .env back out, whatever .gitignore says
                    add = _git("rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", *NEVER_COMMITTED_PATHS)
                commit = _git("commit", "-q", "-m", _message(files)) if add.returncode == 0 else add
                if commit.returncode == 0:
                    actions.append(f"sync: committed {len(files)} file(s)")
                    st.pop("sig", None)
                else:
                    actions.append(f"sync: commit failed: {_err(commit)}")
        else:
            st.pop("sig", None)

        # git refuses to rebase over uncommitted edits to tracked files, so a push waits
        # until they are committed (after their own quiet period).
        clean = _git("diff", "--quiet", "HEAD").returncode == 0
        ahead = _out("rev-list", "--count", f"{upstream}..HEAD")
        if ahead not in ("", "0") and clean and now >= st.get("retry_at", 0):
            actions.append(_push(st, now, upstream))
        util.write_json(_state_path(), st)
    return {"actions": actions}


def _push(st: dict, now: float, upstream: str) -> str:
    remote, _, branch = upstream.partition("/")
    r = _git("fetch", "--quiet", remote)
    if r.returncode != 0:
        return _failed(st, now, r)
    if _out("rev-list", "--count", f"HEAD..{upstream}") not in ("", "0"):
        r = _git("rebase", "--quiet", upstream)
        if r.returncode != 0:
            conflicted = bool(_out("diff", "--name-only", "--diff-filter=U"))
            _git("rebase", "--abort")
            if not conflicted:  # git refused for another reason: retried like a failed push
                return _failed(st, now, r)
            return _stop(st, "conflict", _err(r), conflict_head=_out("rev-parse", "HEAD"))
    r = _git("push", "--quiet", remote, f"HEAD:{branch}")
    if r.returncode != 0:
        return _failed(st, now, r)
    st["failures"] = 0
    st.pop("retry_at", None)
    return "sync: pushed"
