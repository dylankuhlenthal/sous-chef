#!/usr/bin/env python3
"""Switch the live sous chef from the Python core to the TypeScript core, or back.

A one-off (TRV-1156; docs/decisions/0028). It lives only in the core's history, never in
its tree: get it with `git show <commit>:switch-over/switch_over.py > /tmp/switch_over.py`
and run it from a plain terminal, never from inside a Claude session.

  python3 switch_over.py --core ~/.sous-chef --check     checks and the staged suite; changes nothing live
  python3 switch_over.py --core ~/.sous-chef             the switch (asks once before changing anything)
  python3 switch_over.py --core ~/.sous-chef --rollback  back to the Python sous chef (the last-python tag)

The switch, in order (nothing live changes before step 5):
  1. refuse inside a Claude session; check git, claude, node 22 or later, npm
  2. the core: a clean checkout on main, with its `my` link; HEAD is the Python core;
     fetch origin; the target is origin/main, which HEAD is behind and which holds the
     TypeScript core; the last-python tag absent, or already on HEAD
  3. no session on record running (stopped ones listed: --accept-stopped to go on);
     sous chef stopped, or idle in the background
  4. stage the target in a temporary clone: npm ci, npm run build, the full suite
     against the TypeScript sc (--check ends here)
  5. confirm, then tag HEAD last-python and push the tag to origin
  6. stop sous chef (`claude stop`), then the watcher (SIGTERM, then wait)
  7. `git merge --ff-only <target>`, the update step from docs/operations/running.md
     ("after every pull"), and `bin/sc --help` as a load check
  8. `bin/souschef --print`, which resumes the same sous chef, whose startup hook starts
     the TypeScript watcher; then check both, and print the attach command

Run again after `--rollback` (with `git -C <core> checkout main` first), the switch goes
forward again: HEAD is then the TypeScript core and last-python already names an older
Python commit, so no new tag is made.

Python 3 standard library only: it runs while the Python sous chef is live, and checks the
Python watcher's lock with fcntl exactly as the Python sc does.
"""
import argparse
import fcntl
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

TAG = "last-python"
TAG_MESSAGE = "the last Python sous chef, before the TypeScript switch-over"
TARGET_REF = "origin/main"
WATCHER_STOP_WAIT = 90  # seconds; the watcher only stops between cycles
SESSION_ENV = ("CLAUDE_CODE_SESSION_ID", "CLAUDECODE")


class Refusal(Exception):
    """Stop the run with this message. Nothing after it runs."""


def say(msg=""):
    print(msg, flush=True)


def step(msg):
    say(f"\n[{time.strftime('%H:%M:%S')}] {msg}")


def run(args, cwd=None, env=None, timeout=120, input=None, log=None):
    """Run a program. With `log`, its output goes to that file and is returned as ""."""
    try:
        if log:
            with open(log, "w") as f:
                r = subprocess.run(args, cwd=cwd, env=env, timeout=timeout, input=input, text=True, stdout=f,
                                   stderr=subprocess.STDOUT, stdin=None if input is not None else subprocess.DEVNULL)
            return subprocess.CompletedProcess(args, r.returncode, "", "")
        return subprocess.run(args, cwd=cwd, env=env, timeout=timeout, input=input, text=True, capture_output=True,
                              stdin=None if input is not None else subprocess.DEVNULL)
    except FileNotFoundError:
        raise Refusal(f"'{args[0]}' was not found on PATH")
    except subprocess.TimeoutExpired:
        raise Refusal(f"timed out after {timeout}s running: {' '.join(str(a) for a in args[:4])} ...")


def git(core, *args, timeout=120):
    return run(["git", "-C", str(core), *args], timeout=timeout)


def git_out(core, *args, timeout=120):
    r = git(core, *args, timeout=timeout)
    if r.returncode != 0:
        raise Refusal(f"git {' '.join(args)} failed in {core}: {(r.stderr or r.stdout).strip()}")
    return r.stdout.strip()


def interpreter(core, rev):
    """'python' or 'node' from the first line of bin/sc at `rev`, or None."""
    r = git(core, "show", f"{rev}:bin/sc")
    if r.returncode != 0:
        return None
    first = r.stdout.splitlines()[0] if r.stdout else ""
    if not first.startswith("#!"):
        return None
    if "python" in first:
        return "python"
    if "node" in first:
        return "node"
    return None


# --- Claude Code ---------------------------------------------------------------

def claude_rows():
    """Every Claude session, from `claude agents --json --all`. A failed listing refuses."""
    r = run(["claude", "agents", "--json", "--all"], timeout=60)
    if r.returncode != 0:
        raise Refusal(f"`claude agents --json --all` failed, so it cannot tell which sessions run: "
                      f"{(r.stderr or r.stdout).strip()[-400:]}")
    try:
        rows = json.loads(r.stdout or "[]")
    except ValueError:
        raise Refusal("`claude agents --json --all` did not print JSON, so it cannot tell which sessions run")
    if not isinstance(rows, list):
        raise Refusal("`claude agents --json --all` did not print a list")
    return [x for x in rows if isinstance(x, dict)]


def keyed(rows):
    out = {}
    for r in rows:
        for key in (r.get("id"), r.get("sessionId")):
            if key:
                out[key] = r
    return out


def chef_info(state):
    try:
        return json.loads((state / "chef.json").read_text())
    except (OSError, ValueError):
        return None


def chef_row(info, rows):
    if not info or not info.get("session_id"):
        return None
    return keyed(rows).get(info["session_id"])


def chef_problem(row):
    """Why sous chef's session cannot be stopped now, or None (stopped, or idle in the background)."""
    if not row or not row.get("pid"):
        return None
    if row.get("kind") != "background":
        return (f"sous chef is open in a terminal (pid {row.get('pid')}); close it there (exit Claude Code), "
                f"then run this again")
    if row.get("status") != "idle":
        return (f"sous chef is in the middle of a turn (status: {row.get('status') or 'unknown'}); let it finish "
                f"(attach with `claude attach {row.get('id')}` to see), then run this again")
    return None


# --- the core --------------------------------------------------------------------

def check_tools(need_node=True):
    missing = [t for t in (["git", "claude"] + (["node", "npm"] if need_node else [])) if not shutil.which(t)]
    if missing:
        raise Refusal(f"not found on PATH: {', '.join(missing)}")
    if need_node:
        version = run(["node", "--version"]).stdout.strip()
        m = re.match(r"v(\d+)\.", version)
        if not m or int(m.group(1)) < 22:
            raise Refusal(f"the TypeScript sous chef needs Node 22 or later; `node --version` says "
                          f"{version or 'nothing'} ({shutil.which('node')}). Put Node 22 or later first on PATH "
                          f"(for example `nvm use 22`), then run this again")
        say(f"  node {version} at {shutil.which('node')}; npm at {shutil.which('npm')}")


def tag_commit(core, where):
    """The commit last-python names locally ('local') or on origin ('origin'), or None."""
    if where == "local":
        r = git(core, "rev-parse", "-q", "--verify", f"refs/tags/{TAG}^{{commit}}")
        return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else None
    r = git(core, "ls-remote", "--tags", "origin", f"refs/tags/{TAG}", f"refs/tags/{TAG}^{{}}", timeout=120)
    if r.returncode != 0:
        raise Refusal(f"could not read the tags on origin: {r.stderr.strip()}")
    plain = peeled = None
    for line in r.stdout.splitlines():
        sha, _, ref = line.partition("\t")
        if ref.endswith("^{}"):
            peeled = sha
        else:
            plain = sha
    return peeled or plain


def is_ancestor(core, a, b):
    return git(core, "merge-base", "--is-ancestor", a, b).returncode == 0


def check_core(core):
    """Step 2. Returns {head, target, forward_again}."""
    if not (core / ".git").exists():
        raise Refusal(f"{core} is not a git checkout")
    branch = git_out(core, "rev-parse", "--abbrev-ref", "HEAD")
    if branch != "main":
        raise Refusal(f"{core} is on {branch}, not main; run `git -C {core} checkout main` (after a rollback too), "
                      f"then run this again")
    dirty = git_out(core, "status", "--porcelain")
    if dirty:
        raise Refusal(f"{core} has uncommitted or untracked changes; commit, move or remove them first:\n{dirty}")
    my = core / "my"
    if not my.is_dir():
        raise Refusal(f"{my} does not reach a data folder (missing or broken link); fix the link first")
    head = git_out(core, "rev-parse", "HEAD")
    lang = interpreter(core, "HEAD")
    say(f"  {core} is on main at {head[:12]} ({lang or 'unknown'} core); data folder {os.path.realpath(my)}")

    say(f"  fetching origin ...")
    r = git(core, "fetch", "origin", timeout=300)
    if r.returncode != 0:
        raise Refusal(f"`git fetch origin` failed: {r.stderr.strip()}")
    target = git_out(core, "rev-parse", f"{TARGET_REF}^{{commit}}")
    if interpreter(core, target) != "node" or git(core, "cat-file", "-e", f"{target}:package.json").returncode != 0:
        raise Refusal(f"{TARGET_REF} ({target[:12]}) does not hold the TypeScript core yet (no package.json, or its "
                      f"bin/sc is not the Node launcher); merge the final pull request into main first")
    if not is_ancestor(core, head, target):
        raise Refusal(f"HEAD ({head[:12]}) is not behind {TARGET_REF} ({target[:12]}): it has commits main on origin "
                      f"does not have; sort that out by hand first")

    local, remote = tag_commit(core, "local"), tag_commit(core, "origin")
    if lang == "python":
        for where, sha in (("here", local), ("on origin", remote)):
            if sha and sha != head:
                raise Refusal(f"the tag {TAG} already exists {where} on {sha[:12]}, not on HEAD ({head[:12]}). It must "
                              f"name the Python commit that is running; check which is right and delete the wrong one "
                              f"(`git tag -d {TAG}`, `git push origin :refs/tags/{TAG}`)")
        forward_again = False
        say(f"  target {TARGET_REF} is {target[:12]}; {TAG} will name {head[:12]}"
            + (" (already tagged)" if local or remote else ""))
    elif lang == "node":
        tagged = local or remote
        if not tagged or interpreter(core, tagged) != "python" or not is_ancestor(core, tagged, head):
            raise Refusal(f"HEAD ({head[:12]}) is already the TypeScript core, and no {TAG} tag names an earlier Python "
                          f"commit, so this is not a switch back after a rollback. Check out the last Python commit "
                          f"first (`git -C {core} log -- lib/sc` shows it), then run this again")
        forward_again = True
        say(f"  HEAD is already the TypeScript core and {TAG} names {tagged[:12]}: switching forward again after a "
            f"rollback, no new tag; target {TARGET_REF} is {target[:12]}")
    else:
        raise Refusal(f"HEAD's bin/sc ({head[:12]}) is neither the Python nor the Node one; check {core} by hand")
    return {"head": head, "target": target, "forward_again": forward_again, "tag_local": local, "tag_remote": remote}


def record_sessions(state):
    """(running, stopped) sessions on record whose runtime is Claude Code, from the data and the listing."""
    rows = keyed(claude_rows())
    running, stopped = [], []
    for path in sorted((state / "sessions").glob("*/record.json")):
        try:
            rec = json.loads(path.read_text())
        except (OSError, ValueError):
            raise Refusal(f"cannot read {path}")
        if rec.get("runtime", "claude-bg") != "claude-bg":
            continue
        handle = rec.get("handle") or {}
        by_sid = rows.get(handle.get("session_id")) if handle.get("session_id") else None
        by_short = rows.get(handle.get("short_id")) if handle.get("short_id") else None
        # Running when either names a process (stricter than the sc's own rule, never looser).
        live = next((r for r in (by_sid, by_short) if r and r.get("pid")), None)
        (running if live else stopped).append((rec.get("id") or path.parent.name, rec.get("title", ""), live))
    return running, stopped


def check_sessions(core, state, accept_stopped):
    """Step 3, the sessions sous chef launched."""
    running, stopped = record_sessions(state)
    if running:
        names = "\n".join(f"    {sid}  {title}  (pid {row.get('pid')})" for sid, title, row in running)
        raise Refusal(f"sessions on record are running; stop each (`sc stop <id>`) or let it finish, then run this "
                      f"again:\n{names}")
    if stopped:
        say(f"  {len(stopped)} session(s) on record, all stopped. `sc sessions` says:")
        r = run([str(core / "bin" / "sc"), "sessions"], cwd=str(core), timeout=120)
        for line in (r.stdout or r.stderr).rstrip().splitlines():
            say(f"    {line}")
        if not accept_stopped:
            raise Refusal("stopped sessions are on record. Clean up the ones you are done with (`sc cleanup <id>`), "
                          "and run this again with --accept-stopped to keep the rest (they can be resumed after the "
                          "switch with `sc resume <id>`)")
    else:
        say("  no session on record")


def check_chef(state, wait_for_idle=0):
    """Step 3, sous chef itself. Returns its chef.json (or None). Waits up to `wait_for_idle` s for a turn to end."""
    info = chef_info(state)
    deadline = time.time() + wait_for_idle
    while True:
        row = chef_row(info, claude_rows())
        problem = chef_problem(row)
        if not problem:
            break
        if time.time() >= deadline or (row and row.get("kind") != "background"):
            raise Refusal(problem)
        time.sleep(5)
    if not info or not info.get("session_id"):
        say("  no sous chef registered (my/state/chef.json): nothing to stop, and souschef will start a new one")
    elif row and row.get("pid"):
        say(f"  sous chef {info['session_id']} ({row.get('id')}) is idle in the background")
    else:
        say(f"  sous chef {info['session_id']} is stopped")
    return info


# --- staging -----------------------------------------------------------------------

def suite_env(stage_core):
    env = {k: v for k, v in os.environ.items() if not k.startswith("SC_")}
    env.update({"SC_UNDER_TEST": str(stage_core), "PYTHONDONTWRITEBYTECODE": "1"})
    return env


def stage(core, target, stage_dir):
    """Step 4: the target in a clone, installed, built and run through the full suite."""
    if stage_dir:
        base = Path(stage_dir).expanduser().resolve()
        if base.exists() and any(base.iterdir()):
            raise Refusal(f"--stage-dir {base} is not empty")
        base.mkdir(parents=True, exist_ok=True)
    else:
        base = Path(tempfile.mkdtemp(prefix="sc-switch-stage-")).resolve()
    clone = base / "core"
    say(f"  staging {target[:12]} in {clone} (logs in {base})")
    r = run(["git", "clone", "--quiet", "--no-local", "--no-checkout", str(core), str(clone)], timeout=600)
    if r.returncode != 0:
        raise Refusal(f"could not clone {core}: {r.stderr.strip()}")
    git_out(clone, "fetch", "--quiet", str(core), f"+refs/remotes/{TARGET_REF}:refs/heads/switch-target", timeout=600)
    if git_out(clone, "rev-parse", "switch-target") != target:
        raise Refusal(f"{TARGET_REF} moved while staging; run this again")
    git_out(clone, "checkout", "--quiet", "-B", "main", target)
    env = {k: v for k, v in os.environ.items() if not k.startswith("SC_")}
    for name, args, timeout in (("npm-ci", ["npm", "ci"], 1800), ("build", ["npm", "run", "build"], 900)):
        say(f"  {' '.join(args)} ...")
        r = run(args, cwd=str(clone), env=env, timeout=timeout, log=base / f"{name}.log")
        if r.returncode != 0:
            raise Refusal(f"`{' '.join(args)}` failed in the staged copy (exit {r.returncode}):\n"
                          f"{tail(base / f'{name}.log')}\nFull output: {base / f'{name}.log'}")
    say("  the full suite against the staged TypeScript sc (about two and a half minutes) ...")
    log = base / "suite.log"
    r = run([sys.executable, "-m", "unittest", "discover", "-s", "tests"], cwd=str(clone), env=suite_env(clone),
            timeout=3600, log=log)
    summary = [line for line in log.read_text(errors="replace").splitlines()
               if line.startswith(("Ran ", "OK", "FAILED"))]
    if r.returncode != 0 or not any(line.startswith("OK") for line in summary):
        raise Refusal(f"the suite failed against the staged TypeScript sc ({'; '.join(summary) or 'no summary'}):\n"
                      f"{tail(log, 40)}\nFull output: {log}")
    say(f"  suite: {'; '.join(summary)}")
    return base


def tail(path, n=20):
    try:
        lines = Path(path).read_text(errors="replace").rstrip().splitlines()
    except OSError:
        return ""
    return "\n".join("    " + line for line in lines[-n:])


# --- stopping ----------------------------------------------------------------------

def stop_chef(state, info):
    """Stop sous chef's own session with `claude stop`, keeping its conversation."""
    row = chef_row(info, claude_rows())
    if not row or not row.get("pid"):
        say("  sous chef is not running")
        return
    problem = chef_problem(row)
    if problem:
        raise Refusal(problem)
    short = row.get("id")
    for attempt in range(2):
        say(f"  claude stop {short}")
        run(["claude", "stop", short], timeout=60)
        for _ in range(10):
            row = chef_row(info, claude_rows())
            if not row or not row.get("pid"):
                say("  sous chef stopped; its conversation is kept")
                return
            time.sleep(1)
    raise Refusal(f"sous chef ({short}) is still running after two `claude stop` attempts")


def watcher_processes(core):
    """[(pid, language, command)] for every process running `<core>/bin/sc watch`."""
    suffix = f" {core}/bin/sc watch"
    out = run(["ps", "-axww", "-o", "pid=,command="], timeout=30).stdout
    found = []
    for line in out.splitlines():
        pid, _, command = line.strip().partition(" ")
        command = command.strip()
        if not command.endswith(suffix) or not pid.isdigit():
            continue
        program = os.path.basename(command[: -len(suffix)].strip().split(" ")[0]).lower()
        lang = "python" if "python" in program else "node" if "node" in program else None
        found.append((int(pid), lang, command))
    return found


def python_lock_free(state):
    """The Python watcher's own test (lib/sc/watch.py is_running): a non-blocking flock on state/watch.lock."""
    path = state / "watch.lock"
    if not path.exists():
        return True
    with open(path, "a") as f:
        try:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        fcntl.flock(f.fileno(), fcntl.LOCK_UN)
        return True


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def read_pid(state):
    try:
        return int((state / "watch.pid").read_text().strip())
    except (OSError, ValueError):
        return None


def stop_watcher(core, state, languages):
    """SIGTERM the watcher named in watch.pid, if it is this core's, in one of `languages`; wait; check it is gone.

    Never SIGKILL: a watcher stops between cycles, so a cycle's writes are never cut short.
    """
    pid = read_pid(state)
    running = {p: (lang, cmd) for p, lang, cmd in watcher_processes(core)}
    if pid and pid_alive(pid) and pid not in running:
        # A pid left behind by a watcher that is gone, now used by something else: never signal it.
        command = run(["ps", "-ww", "-o", "command=", "-p", str(pid)], timeout=30).stdout.strip()
        say(f"  state/watch.pid names pid {pid}, which is not this core's watcher (`{command}`); not touching it")
        pid = None
    if pid and pid_alive(pid):
        lang = running[pid][0]
        if lang not in languages:
            raise Refusal(f"the watcher (pid {pid}) runs under {lang or 'an unknown program'}, not "
                          f"{' or '.join(languages)}: `{running[pid][1]}`")
        say(f"  stopping the {lang} watcher (pid {pid}) with SIGTERM; it stops between cycles ...")
        os.kill(pid, signal.SIGTERM)
        deadline = time.time() + WATCHER_STOP_WAIT
        while pid_alive(pid) and time.time() < deadline:
            time.sleep(0.5)
        if pid_alive(pid):
            raise Refusal(f"the watcher (pid {pid}) did not stop within {WATCHER_STOP_WAIT}s; it was not killed. "
                          f"Look at {state / 'watch.log'}, then run this again")
    else:
        say("  the watcher is not running (state/watch.pid names no live process)")
    left = watcher_processes(core)
    if left:
        raise Refusal("other watcher processes for this core are still running; stop them by hand "
                      "(`kill <pid>`) and run this again:\n" + "\n".join(f"    {p} {c}" for p, _, c in left))
    if not python_lock_free(state):
        raise Refusal(f"something still holds the Python watcher's lock ({state / 'watch.lock'})")
    say("  no watcher runs for this core, and the Python watcher's lock is free")


# --- moving and resuming -------------------------------------------------------------

def update_step(core, old, target):
    """The update step docs/operations/running.md names "after every pull", after the merge.

    Its `git diff --quiet ORIG_HEAD HEAD -- package-lock.json || npm ci` compares the commit
    before the pull with the one after; here `old` is that commit (what `git merge` records
    as ORIG_HEAD), named explicitly so nothing else can have moved ORIG_HEAD.

    One addition: npm ci also runs when node_modules/.package-lock.json is missing or older
    than package-lock.json. Switching forward again after a rollback checks package-lock.json
    out afresh (last-python has none), so it is newer than the installed dependencies while
    its content is unchanged; the build then records no lock hash and bin/sc refuses until
    npm ci runs (found by the rehearsal).
    """
    env = {k: v for k, v in os.environ.items() if not k.startswith("SC_")}
    same_lock = git(core, "diff", "--quiet", old, target, "--", "package-lock.json").returncode == 0
    lock, installed = core / "package-lock.json", core / "node_modules" / ".package-lock.json"
    stale = not installed.exists() or installed.stat().st_mtime < lock.stat().st_mtime
    steps = ([] if same_lock and not stale else [["npm", "ci"]]) + [["npm", "run", "build"]]
    if same_lock and not stale:
        say("  package-lock.json is unchanged and the installed dependencies are newer, so no npm ci")
    elif same_lock:
        say("  package-lock.json is unchanged, but the installed dependencies are older than it, so npm ci")
    for args in steps:
        say(f"  {' '.join(args)} ...")
        log = Path(tempfile.mkstemp(prefix=f"sc-switch-{args[-1]}-", suffix=".log")[1])
        r = run(args, cwd=str(core), env=env, timeout=1800, log=log)
        if r.returncode != 0:
            raise Refusal(f"`{' '.join(args)}` failed in {core} (exit {r.returncode}):\n{tail(log)}\nFull output: {log}")


def resume_and_check(core, state, before, language):
    """Run `souschef --print`, then check sous chef and the watcher. Returns (attach command, problems)."""
    r = run([str(core / "bin" / "souschef"), "--print"], cwd=str(core), timeout=600)
    out = (r.stdout + r.stderr).strip()
    for line in out.splitlines():
        say(f"    {line}")
    if r.returncode != 0:
        return None, [f"`souschef --print` failed (exit {r.returncode})"]
    attach = next((line for line in reversed(out.splitlines()) if line.startswith("claude attach ")), None)
    problems = []
    deadline = time.time() + 60
    while True:
        problems = check_running(core, state, before, language)
        if not problems or time.time() >= deadline:
            break
        time.sleep(3)
    return attach, problems


def check_running(core, state, before, language):
    problems = []
    info = chef_info(state) or {}
    sid = info.get("session_id")
    if before and before.get("session_id") and sid != before["session_id"]:
        problems.append(f"sous chef is now session {sid}, not {before['session_id']}: souschef could not resume the "
                        f"old one. Its conversation still exists: `claude --resume {before['session_id']}`")
    row = chef_row(info, claude_rows())
    if not row or not row.get("pid"):
        problems.append(f"sous chef ({sid}) is not running in `claude agents`")
    procs = watcher_processes(core)
    pid = read_pid(state)
    try:
        code = json.loads((state / "watch.code").read_text())
    except (OSError, ValueError):
        code = {}
    if len(procs) != 1:
        problems.append(f"{len(procs)} watcher processes run for this core, not one: {procs}")
    elif procs[0][1] != language:
        problems.append(f"the watcher runs under {procs[0][1]}, not {language}: {procs[0][2]}")
    elif procs[0][0] != pid:
        problems.append(f"state/watch.pid says {pid}, but the watcher is pid {procs[0][0]}")
    elif code.get("pid") != pid:
        problems.append(f"state/watch.code names pid {code.get('pid')}, not the watcher's {pid}")
    summary = run([str(core / "bin" / "sc"), "summary"], cwd=str(core), timeout=120)
    m = re.search(r"^## Watcher\n(.*)$", summary.stdout, re.MULTILINE)
    if not m or m.group(1).strip() != "running":
        problems.append(f"`sc summary` says the watcher is: {m.group(1).strip() if m else '(no watcher section)'}")
    return problems


CHECKLIST = """\
After-switch checklist (docs/operations/running.md, "Switching from the Python sous chef to TypeScript"):
  1. Sous chef is the same conversation; `sc chef` shows the same session id, running.
  2. The startup summary has no watcher warning; `pgrep -fl "bin/sc watch"` shows one watcher,
     under Node; my/state/watch.log shows it started.
  3. Ask sous chef to spawn a small session that reports done; sous chef is woken by it, and
     `sc sessions` shows it.
  4. A session stopped before the switch (`sc resume <id>`) reports through its old hook commands.
  5. DM the bot in Slack; sous chef answers there. `sc slack` says it works.
  6. `sc cron` shows the next scheduled job; after its slot, it shows it fired.
  7. After a memory edit and two quiet minutes, `git -C <data folder> log -1` shows the sync commit,
     and `git -C <data folder> status -sb` is not ahead.
If one fails and is not quickly fixable: python3 {script} --core {core} --rollback"""


# --- the modes -------------------------------------------------------------------------

def refuse_inside_claude():
    found = [k for k in SESSION_ENV if os.environ.get(k)]
    if found:
        raise Refusal(f"this runs inside a Claude session ({', '.join(found)} is set). It stops sous chef, so run it "
                      f"from a plain terminal")


def switch(core, args):
    state = core / "my" / "state"
    script = os.path.abspath(sys.argv[0])
    step("1. checks: not inside a Claude session; the tools")
    refuse_inside_claude()
    check_tools()
    step("2. the core")
    c = check_core(core)
    step("3. sessions and sous chef")
    check_sessions(core, state, args.accept_stopped)
    before = check_chef(state)
    say("  worktrees of the core (not changed):")
    for line in git_out(core, "worktree", "list").splitlines():
        say(f"    {line}")
    step("4. staging the target and running the suite against it")
    base = stage(core, c["target"], args.stage_dir)
    if args.check:
        say(f"\n--check passed: the switch can go ahead. Nothing live was changed. (Staged copy: {base}; delete it "
            f"when done.)")
        return 0

    step("5. confirm, then tag and push last-python")
    if not args.yes:
        say(f"This tags {c['head'][:12]} as {TAG} and pushes the tag, stops sous chef and the watcher, moves {core} "
            f"to {c['target'][:12]} and starts sous chef again on TypeScript.")
        try:
            answer = input("Type yes to go on: ")
        except EOFError:
            answer = ""
        if answer.strip() != "yes":
            say("Stopped; nothing was changed.")
            return 1
    # Things may have moved while the suite ran: check again before changing anything.
    check_sessions(core, state, args.accept_stopped)
    before = check_chef(state, wait_for_idle=120)
    if not c["forward_again"]:
        if not c["tag_local"] and c["tag_remote"] == c["head"]:
            git_out(core, "fetch", "origin", f"refs/tags/{TAG}:refs/tags/{TAG}", timeout=300)
            say(f"  fetched {TAG} from origin")
        elif not c["tag_local"]:
            git_out(core, "tag", "-a", TAG, "-m", TAG_MESSAGE, c["head"])
            say(f"  tagged {c['head'][:12]} as {TAG}")
        if tag_commit(core, "origin") != c["head"]:
            r = git(core, "push", "origin", f"refs/tags/{TAG}", timeout=300)
            if r.returncode != 0:
                raise Refusal(f"could not push the tag: {r.stderr.strip()}. Nothing else was changed; fix it and run "
                              f"this again")
            say(f"  pushed {TAG} to origin")
        else:
            say(f"  {TAG} is already on origin")

    rollback_hint = f"python3 {script} --core {core} --rollback"
    try:
        step("6. stopping sous chef, then the watcher")
        stop_chef(state, before)
        stop_watcher(core, state, ("python", "node"))
        step("7. moving the core to the target, and the update step")
        old = git_out(core, "rev-parse", "HEAD")
        git_out(core, "merge", "--ff-only", c["target"], timeout=300)
        say(f"  {core} is at {git_out(core, 'rev-parse', 'HEAD')[:12]}")
        update_step(core, old, c["target"])
        r = run([str(core / "bin" / "sc"), "--help"], cwd=str(core), timeout=120)
        if r.returncode != 0:
            raise Refusal(f"`bin/sc --help` failed after the update: {(r.stderr or r.stdout).strip()[-800:]}")
        say("  bin/sc --help works (load check)")
        step("8. souschef --print, then checking sous chef and the watcher")
        attach, problems = resume_and_check(core, state, before, "node")
    except Refusal as e:
        say(f"\nswitch_over: {e}")
        say(f"\nThe switch stopped part way. Run this again once the cause is fixed (it is safe to), or go back to "
            f"the Python sous chef:\n  {rollback_hint}")
        return 1
    if problems:
        for p in problems:
            say(f"  PROBLEM: {p}")
        say(f"\nThe core is switched, but the checks above failed. Fix them, or go back:\n  {rollback_hint}")
        return 1
    say("  sous chef is the same session, running; one watcher runs, under Node, and the summary shows no warning")
    say(f"\nSwitched. Attach with: {attach or 'souschef'}\n")
    say(CHECKLIST.format(script=script, core=core))
    return 0


def rollback(core, args):
    state = core / "my" / "state"
    step("1. checks")
    refuse_inside_claude()
    check_tools(need_node=False)
    tagged = tag_commit(core, "local")
    if not tagged:
        raise Refusal(f"there is no {TAG} tag in {core}; nothing to go back to")
    # The TypeScript build's folders are untracked, not ignored, on a Python commit (its .gitignore
    # predates them), so a second rollback must not count them as changes.
    dirty = "\n".join(line for line in git_out(core, "status", "--porcelain").splitlines()
                      if line not in ("?? dist/", "?? node_modules/"))
    if dirty:
        raise Refusal(f"{core} has uncommitted or untracked changes; commit, move or remove them first:\n{dirty}")
    if not (core / "my").is_dir():
        raise Refusal(f"{core / 'my'} does not reach a data folder; fix the link first")
    running, _ = record_sessions(state)
    if running:
        say("  WARNING: sessions on record are running. Sessions the TypeScript sc launched run their hooks "
            "with Node, which cannot run the Python bin/sc, so their hooks fail after the rollback (sc report "
            "still works). Stop them (`sc stop <id>`) first if you can, and relaunch any you still need:")
        for sid, title, row in running:
            say(f"    {sid}  {title}  (pid {row.get('pid')})")
    before = check_chef(state)
    if not args.yes:
        say(f"This stops sous chef and the watcher, checks out {TAG} ({tagged[:12]}) in {core} and starts the Python "
            f"sous chef again.")
        try:
            answer = input("Type yes to go on: ")
        except EOFError:
            answer = ""
        if answer.strip() != "yes":
            say("Stopped; nothing was changed.")
            return 1
    step("2. stopping sous chef, then the watcher")
    stop_chef(state, before)
    stop_watcher(core, state, ("node", "python"))
    step(f"3. checking out {TAG}")
    git_out(core, "checkout", "--quiet", TAG)
    say(f"  {core} is at {git_out(core, 'rev-parse', 'HEAD')[:12]} ({TAG}, detached); dist/ and node_modules/ are "
        f"left in place")
    step("4. souschef --print, then checking sous chef and the watcher")
    attach, problems = resume_and_check(core, state, before, "python")
    for p in problems:
        say(f"  PROBLEM: {p}")
    if problems:
        return 1
    say("  sous chef is the same session, running; one watcher runs, under Python")
    say(f"\nBack on the Python sous chef. Attach with: {attach or 'souschef'}")
    say("Sessions the TypeScript sc launched cannot run their hooks on the Python code (their hooks run "
        "bin/sc with Node), and keep their turn times in Porch, not turns.json, so the Python watcher's "
        "silent-stop check never fires for them; relaunch the ones you still need (docs/operations/running.md).")
    say(f"To switch forward again later: git -C {core} checkout main, then run this script without --rollback.")
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(prog="switch_over.py", description=__doc__.split("\n\n")[0])
    p.add_argument("--core", required=True, help="the sous chef core folder, e.g. ~/.sous-chef (its data folder is "
                                                 "always <core>/my)")
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="run every check and the staged suite; change nothing live")
    mode.add_argument("--rollback", action="store_true", help="go back to the Python sous chef (the last-python tag)")
    p.add_argument("--yes", action="store_true", help="do not ask before changing anything")
    p.add_argument("--accept-stopped", action="store_true", help="go on although stopped sessions are on record")
    p.add_argument("--stage-dir", help="an empty folder for the staged copy (default: a new temporary folder)")
    args = p.parse_args(argv)
    core = Path(os.path.realpath(os.path.expanduser(args.core)))
    try:
        return rollback(core, args) if args.rollback else switch(core, args)
    except Refusal as e:
        say(f"\nswitch_over: {e}")
        return 1
    except KeyboardInterrupt:
        say("\nswitch_over: interrupted")
        return 130


if __name__ == "__main__":
    sys.exit(main())
