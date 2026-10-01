#!/usr/bin/env python3
"""Rehearse the switch-over end to end on a scratch install (TRV-1156). Never touches the live one.

  python3 rehearse.py <integration head> [--repo <core repo>] [--scratch <empty folder>] [--keep]

It makes a scratch install of the Python core from the Python main the integration head
started from, uses it the way a Python sous chef does (sous chef registered, the real
Python watcher running, two worker sessions, a chef cron job, memory), merges the
integration head into a stand-in `main`, and then runs switch_over.py (next to this file)
against it: every refusal, `--check`, the switch, the result checks, `--rollback` and the
switch forward again. It prints one PASS or FAIL line per check, and exits 1 on any FAIL.

Stand-ins: a local bare repo for GitHub (and one for the data folder's remote); a stub
`claude` (stub_claude.py, next to this file) first on PATH and in PORCH_CLAUDE_BIN, so no
real Claude Code session is ever reached; PORCH_HOME and CLAUDE_CONFIG_DIR in the scratch
folder. The real HOME stays (npm ci needs the owner's git credentials and npm cache; the
tag needs their git identity). Every program runs with a curated environment: no SC_*
variables except SC_SYNC_QUIET (shortened so the sync check is quick), no Claude session
variables. Before and after, it checks it did not touch the live install: ~/.local/bin's
sc and souschef links, ~/.sous-chef's HEAD, tags and worktrees, the live watcher's pid,
and ~/.porch.

To re-run it from the core's history (switch-over/ is not in main's tree):
  d=$(mktemp -d) && for f in rehearse.py switch_over.py stub_claude.py; do
    git -C <core repo> show <commit>:switch-over/$f > "$d/$f"; done &&
  python3 "$d/rehearse.py" --repo <core repo> <integration head>
"""
import argparse
import calendar
import hashlib
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

HERE = Path(os.path.realpath(__file__)).parent
SCRIPT = HERE / "switch_over.py"
STUB = HERE / "stub_claude.py"
REAL_HOME = Path(os.path.expanduser("~"))
LIVE_CORE = REAL_HOME / ".sous-chef"

results = []  # (ok, name, detail)


def say(msg=""):
    print(msg, flush=True)


def check(ok, name, detail=""):
    results.append((bool(ok), name, detail))
    detail = " ".join(str(detail).split())
    say(f"{'PASS' if ok else 'FAIL'} {name}" + (f": {detail[-400:]}" if detail and not ok else
                                               (f" ({detail[:160]})" if detail else "")))
    return bool(ok)


def info(msg):
    say(f"INFO {msg}")


def section(title):
    say(f"\n=== {title} [{time.strftime('%H:%M:%S')}]")


class H:
    """The rehearsal's paths and environment."""

    def __init__(self, scratch, repo, head, base):
        self.s = scratch
        self.repo = repo
        self.head = head
        self.base = base
        self.origin = scratch / "origin.git"
        self.data_origin = scratch / "data-origin.git"
        self.core = scratch / "core"
        self.data = scratch / "data"
        self.state = self.data / "state"
        self.bin = scratch / "bin"
        self.stub_dir = scratch / "stub"
        self.stub = self.stub_dir / "claude"
        self.porch = scratch / "porch"
        self.claude_config = scratch / "claude-config"
        self.work = scratch / "work"
        self.merger = scratch / "merger"
        node = shutil.which("node")
        if not node:
            sys.exit("rehearse: node is not on PATH")
        self.node_dir = str(Path(node).parent)
        self.path = ":".join([str(self.stub_dir), self.node_dir, "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin",
                              "/sbin"])
        keep = ("HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SSH_AUTH_SOCK")
        self.env = {k: os.environ[k] for k in keep if k in os.environ}
        self.env.update({"PATH": self.path, "PORCH_HOME": str(self.porch), "PORCH_CLAUDE_BIN": str(self.stub),
                         "CLAUDE_CONFIG_DIR": str(self.claude_config), "SC_SYNC_QUIET": "10",
                         "GIT_TERMINAL_PROMPT": "0"})

    def run(self, args, cwd=None, env=None, timeout=300, input=None, extra_env=None):
        e = dict(env or self.env)
        e.update(extra_env or {})
        try:
            return subprocess.run([str(a) for a in args], cwd=str(cwd) if cwd else None, env=e, text=True,
                                  capture_output=True, timeout=timeout, input=input,
                                  stdin=None if input is not None else subprocess.DEVNULL)
        except subprocess.TimeoutExpired as ex:
            return subprocess.CompletedProcess(args, 124, ex.stdout or "", f"TIMED OUT after {timeout}s")

    def git(self, *args, cwd=None, timeout=300):
        return self.run(["git", *args], cwd=cwd, timeout=timeout)

    def must(self, r, what):
        if r.returncode != 0:
            say(f"rehearse: {what} failed (exit {r.returncode}):\n{r.stdout[-3000:]}\n{r.stderr[-3000:]}")
            raise SystemExit(2)
        return r.stdout

    def sc(self, *args, input=None, extra_env=None, timeout=300):
        return self.run([self.core / "bin" / "sc", *args], cwd=self.core, input=input, extra_env=extra_env,
                        timeout=timeout)

    def switch(self, *args, extra_env=None, env=None, timeout=3600, label=""):
        """Run switch_over.py; its output goes to a numbered log, and its last lines to the screen."""
        r = self.run([sys.executable, SCRIPT, "--core", self.core, *args], env=env, extra_env=extra_env,
                     timeout=timeout)
        n = len(list(self.s.glob("switch-*.log"))) + 1
        log = self.s / f"switch-{n:02d}{('-' + label) if label else ''}.log"
        log.write_text(f"$ switch_over.py --core <core> {' '.join(map(str, args))}\nexit {r.returncode}\n\n{r.stdout}\n{r.stderr}")
        info(f"switch_over.py {' '.join(map(str, args))} -> exit {r.returncode} (log {log.name})")
        return r

    # --- reading the scratch install ---------------------------------------------

    def stub_state(self):
        try:
            return json.loads((self.stub_dir / "state.json").read_text())
        except (OSError, ValueError):
            return {"sessions": []}

    def stub_session(self, key):
        return next((s for s in self.stub_state()["sessions"] if key in (s["id"], s["sessionId"])), None)

    def stub_calls(self):
        out = []
        try:
            for line in (self.stub_dir / "calls.jsonl").read_text().splitlines():
                out.append(json.loads(line))
        except (OSError, ValueError):
            pass
        return out

    def stubctl(self, *args):
        return self.must(self.run([self.stub, "_stub", *args]), f"claude _stub {' '.join(args)}")

    def chef(self):
        try:
            return json.loads((self.state / "chef.json").read_text())
        except (OSError, ValueError):
            return {}

    def watch_pid(self):
        try:
            return int((self.state / "watch.pid").read_text().strip())
        except (OSError, ValueError):
            return None

    def watchers(self):
        """[(pid, language, command)] for every process running <core>/bin/sc watch."""
        suffix = f" {self.core}/bin/sc watch"
        out = subprocess.run(["ps", "-axww", "-o", "pid=,command="], capture_output=True, text=True).stdout
        found = []
        for line in out.splitlines():
            pid, _, command = line.strip().partition(" ")
            command = command.strip()
            if command.endswith(suffix) and pid.isdigit():
                prog = os.path.basename(command[: -len(suffix)].strip().split(" ")[0]).lower()
                found.append((int(pid), "python" if "python" in prog else "node" if "node" in prog else prog, command))
        return found

    def head_of(self, folder=None):
        return self.git("rev-parse", "HEAD", cwd=folder or self.core).stdout.strip()

    def origin_tag(self):
        r = self.git("--git-dir", self.origin, "rev-parse", "-q", "--verify", "refs/tags/last-python^{commit}")
        return r.stdout.strip() or None

    def local_tag(self):
        r = self.git("rev-parse", "-q", "--verify", "refs/tags/last-python^{commit}", cwd=self.core)
        return r.stdout.strip() or None


def alive(pid):
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def read_beat(h):
    try:
        return (h.state / "watch.beat").read_text()
    except OSError:
        return None


def wait_for(condition, seconds, every=1.0):
    deadline = time.time() + seconds
    while time.time() < deadline:
        v = condition()
        if v:
            return v
        time.sleep(every)
    return condition()


# --- what must not be touched ----------------------------------------------------------

def live_snapshot(h):
    snap = {}
    for name in ("sc", "souschef"):
        link = REAL_HOME / ".local" / "bin" / name
        snap[f"link {name}"] = os.readlink(link) if link.is_symlink() else ("file" if link.exists() else None)
    if (LIVE_CORE / ".git").exists():
        g = lambda *a: subprocess.run(["git", "-C", str(LIVE_CORE), *a], capture_output=True, text=True).stdout
        snap["live HEAD"] = g("rev-parse", "HEAD").strip()
        snap["live tags"] = g("show-ref", "--tags").strip()
        porcelain = g("worktree", "list", "--porcelain")
        snap["live worktree paths"] = sorted(l[len("worktree "):] for l in porcelain.splitlines() if l.startswith("worktree "))
    try:
        pid = int((LIVE_CORE / "my" / "state" / "watch.pid").read_text().strip())
    except (OSError, ValueError):
        pid = None
    snap["live watcher pid"] = pid
    porch = {}
    real_porch = REAL_HOME / ".porch"
    if real_porch.is_dir():
        for p in real_porch.rglob("*"):
            if p.is_file():
                st = p.stat()
                porch[str(p)] = (st.st_mtime, st.st_size)
    snap["porch"] = porch
    jobs = REAL_HOME / ".claude" / "jobs"
    snap["claude jobs"] = sorted(p.name for p in jobs.iterdir()) if jobs.is_dir() else []
    return snap


def check_live_untouched(h, before):
    after = live_snapshot(h)
    for key in ("link sc", "link souschef", "live HEAD", "live tags", "live worktree paths", "live watcher pid"):
        check(before.get(key) == after.get(key), f"untouched: {key}", f"before {before.get(key)!r}, after {after.get(key)!r}"
              if before.get(key) != after.get(key) else str(after.get(key))[:100])
    pid = after.get("live watcher pid")
    check(pid is None or alive(pid), "untouched: the live watcher is still alive", f"pid {pid}")
    ids = [s[k] for s in h.stub_state()["sessions"] for k in ("id", "sessionId")]
    changed = [p for p, v in after["porch"].items() if before["porch"].get(p) != v]
    ours = []
    for p in changed:
        try:
            text = Path(p).read_text(errors="replace")
        except OSError:
            text = ""
        if str(h.s) in text or any(i in p or i in text for i in ids):
            ours.append(p)
    check(not ours, "untouched: nothing of the rehearsal in the real ~/.porch",
          f"{len(changed)} file(s) there changed meanwhile, none naming a rehearsal session or the scratch folder"
          if not ours else f"rehearsal files: {ours[:5]}")
    new_jobs = set(after["claude jobs"]) - set(before["claude jobs"])
    stub_shorts = {s["id"] for s in h.stub_state()["sessions"]}
    check(not (new_jobs & stub_shorts), "untouched: no rehearsal session in the real ~/.claude/jobs")


# --- setting up ----------------------------------------------------------------------

def setup(h):
    section("setting up the scratch install (Python core, stub claude)")
    for d in (h.stub_dir, h.porch, h.claude_config, h.work):
        d.mkdir(parents=True)
    shutil.copy2(STUB, h.stub)
    h.stub.chmod(0o755)
    which = shutil.which("claude", path=h.path)
    others = [d for d in h.path.split(":")[1:] if (Path(d) / "claude").exists()]
    check(which == str(h.stub) and not others, "the only claude on the rehearsal PATH is the stub", which or "none")
    h.must(h.git("init", "-q", "--bare", h.origin), "git init origin")
    h.must(h.git("init", "-q", "--bare", h.data_origin), "git init data origin")
    h.must(h.git("push", "-q", h.origin, f"{h.base}:refs/heads/main", f"{h.head}:refs/heads/integration", cwd=h.repo),
           "push the stand-in main and the integration head")
    h.must(h.git("clone", "-q", h.origin, h.core), "clone the core")
    url = h.git("remote", "get-url", "origin", cwd=h.core).stdout.strip()
    if os.path.realpath(url) != str(h.origin):
        sys.exit(f"rehearse: the scratch core's origin is {url}, not the scratch bare repo; refusing")
    check(h.head_of() == h.base, "the scratch core is the Python main", h.base[:12])
    r = h.run([h.core / "install.sh", "--data", h.data, "--name", "Alex", "--branch-prefix", "alx/", "--git",
               "--push-url", h.data_origin, "--bin-dir", h.bin, "--yes"], cwd=h.core)
    check(r.returncode == 0, "the Python install.sh makes the scratch install", (r.stdout + r.stderr).strip()[-300:])
    if r.returncode != 0:
        raise SystemExit(2)

    # Sous chef, as the Python souschef starts it: the stub runs the core's chef-start hook.
    r = h.run([h.core / "bin" / "souschef", "--print"], cwd=h.core)
    info("python souschef --print: " + " | ".join((r.stdout + r.stderr).strip().splitlines()))
    chef = h.chef()
    h.chef_sid = chef.get("session_id")
    h.chef_short = (h.stub_session(h.chef_sid) or {}).get("id")
    check(h.chef_sid and h.chef_short, "the Python chef-start hook registered the stub sous chef", str(h.chef_sid))
    ws = wait_for(lambda: [w for w in h.watchers() if w[1] == "python"], 15)
    check(len(h.watchers()) == 1 and ws and ws[0][0] == h.watch_pid(), "the real Python watcher runs on the scratch data",
          str(h.watchers()))

    # Two workers launched by the Python sc against the stub.
    h.workers = []
    for n in (1, 2):
        r = h.sc("spawn", "--kind", "general", "--title", f"rehearsal worker {n}", "--cwd", h.work,
                 input=f"Rehearsal worker {n}: do nothing.\n")
        m = re.search(r"launched (\S+) ", r.stdout)
        if not m:
            say(r.stdout + r.stderr)
            raise SystemExit(2)
        rec = json.loads((h.state / "sessions" / m.group(1) / "record.json").read_text())
        h.workers.append(rec)
        sid = rec["handle"]["session_id"]
        h.must(h.sc("report", "working", f"worker {n} started", extra_env={"CLAUDE_CODE_SESSION_ID": sid}),
               f"report from worker {n}")
    w1, w2 = h.workers
    r = h.sc("send", w1["id"], "a message from sous chef, before the switch")
    info("python sc send: " + (r.stdout + r.stderr).strip().splitlines()[0])
    h.must(h.sc("stop", w1["id"]), "sc stop worker 1")
    h.stubctl("kill", w2["handle"]["short_id"])  # stopped by "Claude Code", not by sc
    check(all(not (h.stub_session(w["handle"]["short_id"]) or {}).get("pid") for w in h.workers),
          "two worker sessions on record, one stopped by sc stop and one stopped by Claude Code")

    h.must(h.sc("cron", "add", "rehearsal-tick", "--every", "1m", "--target", "chef",
                input="Rehearsal: a chef job every minute.\n"), "sc cron add")
    (h.data / "memory" / "rehearsal.md").write_text("# Rehearsal\n\nWritten before the switch.\n")
    info("letting the Python watcher run a few cycles over this data (cron, sync, gone check) ...")
    beats = set()
    wait_for(lambda: beats.add(read_beat(h)) or len(beats) >= 4, 90)
    h.data_branch = h.git("rev-parse", "--abbrev-ref", "HEAD", cwd=h.data).stdout.strip()
    pushed = wait_for(lambda: "rehearsal.md" in h.git("--git-dir", h.data_origin, "log", "--name-only",
                                                      h.data_branch).stdout, 90, every=3)
    check(pushed, "the Python watcher synced the memory edit to the data remote before the switch")
    leftovers = sorted(p.name for p in h.state.rglob("*.lock"))
    info(f"Python lock files left in state/: {', '.join(leftovers)}")


def merge_integration(h):
    section("stand-in for merging the final pull request into main")
    h.must(h.git("clone", "-q", h.origin, h.merger), "clone for merging")
    h.must(h.git("merge", "-q", "--no-ff", "origin/integration", "-m", "Merge the final pull request (rehearsal stand-in)",
                 cwd=h.merger), "merge the integration head")
    h.must(h.git("push", "-q", "origin", "main", cwd=h.merger), "push the stand-in main")
    h.target = h.head_of(h.merger)
    info(f"stand-in origin/main is now {h.target[:12]}, a merge of {h.head[:12]}")


# --- the checks ----------------------------------------------------------------------

def fingerprint(h):
    chef_row = h.stub_session(h.chef_sid) or {}
    return {"core HEAD": h.head_of(), "branch": h.git("rev-parse", "--abbrev-ref", "HEAD", cwd=h.core).stdout.strip(),
            "local tag": h.local_tag(), "origin tag": h.origin_tag(), "watcher pid": h.watch_pid(),
            "chef pid": chef_row.get("pid"), "stops": sum(1 for c in h.stub_calls() if (c.get("argv") or [""])[0] == "stop")}


def refusal(h, name, expect, args=("--accept-stopped", "--yes"), extra_env=None, env=None, expect_ok=False):
    before = fingerprint(h)
    r = h.switch(*args, extra_env=extra_env, env=env, label=re.sub(r"\W+", "-", name)[:30])
    out = r.stdout + r.stderr
    after = fingerprint(h)
    alive_ok = alive(after["watcher pid"]) and alive(after["chef pid"])
    exit_ok = r.returncode == 0 if expect_ok else r.returncode != 0
    ok = exit_ok and re.search(expect, out) and before == after and alive_ok
    detail = (f"{'passed' if expect_ok else 'refused'}: {re.search(expect, out).group(0)[:90]!r}" if ok else
              f"exit {r.returncode}, expected /{expect}/, changed: "
              f"{ {k: (before[k], after[k]) for k in before if before[k] != after[k]} }, alive {alive_ok}; "
              f"last output: {out.strip()[-600:]}")
    check(ok, f"{'' if expect_ok else 'refusal, '}changes nothing: {name}", detail)
    return r


def refusals_before_merge(h):
    section("refusal before the stand-in merge")
    refusal(h, "the target without the TypeScript core", r"does not hold the TypeScript core yet")


def refusals(h):
    section("refusals (each must change nothing)")
    refusal(h, "inside a Claude session", r"runs inside a Claude session",
            extra_env={"CLAUDE_CODE_SESSION_ID": "00000000-0000-0000-0000-000000000000"})
    fake = h.s / "old-node"
    fake.mkdir(exist_ok=True)
    (fake / "node").write_text("#!/bin/sh\necho v20.11.1\n")
    (fake / "node").chmod(0o755)
    refusal(h, "node older than 22", r"needs Node 22 or later", extra_env={"PATH": f"{fake}:{h.path}"})
    (h.core / "stray.txt").write_text("not committed\n")
    refusal(h, "the core dirty", r"uncommitted or untracked changes")
    (h.core / "stray.txt").unlink()
    h.must(h.git("checkout", "-q", "-b", "side", cwd=h.core), "checkout side")
    refusal(h, "the core not on main", r"is on side, not main")
    h.must(h.git("checkout", "-q", "main", cwd=h.core), "checkout main")
    h.must(h.git("branch", "-q", "-D", "side", cwd=h.core), "delete side")
    h.must(h.git("fetch", "-q", "origin", cwd=h.core), "fetch")
    h.must(h.git("reset", "-q", "--hard", "origin/main", cwd=h.core), "reset to the TypeScript main")
    refusal(h, "HEAD:bin/sc already the Node one", r"already the TypeScript core, and no last-python tag")
    h.must(h.git("reset", "-q", "--hard", h.base, cwd=h.core), "reset back to the Python main")
    w1 = h.workers[0]["handle"]["short_id"]
    h.stubctl("start", w1)
    refusal(h, "a worker session running", r"sessions on record are running")
    h.stubctl("kill", w1)
    refusal(h, "stopped sessions without --accept-stopped", r"stopped sessions are on record", args=("--yes",))
    h.stubctl("set", h.chef_short, "status=busy")
    refusal(h, "sous chef mid-turn", r"in the middle of a turn")
    h.stubctl("set", h.chef_short, "status=idle", "kind=interactive")
    refusal(h, "sous chef open in a terminal", r"open in a terminal")
    h.stubctl("set", h.chef_short, "kind=background")
    other = h.git("rev-parse", f"{h.base}^", cwd=h.core).stdout.strip()
    h.must(h.git("tag", "-a", "last-python", "-m", "wrong", other, cwd=h.core), "tag the wrong commit")
    refusal(h, "last-python on another commit", r"already exists here on")
    h.must(h.git("tag", "-d", "last-python", cwd=h.core), "delete the wrong tag")

    # A failing suite: a throwaway commit on the stand-in main that breaks one test, staged
    # through the same code path; then the stand-in main is put back.
    good = h.target
    captured = sorted((h.merger / "tests" / "captured").iterdir())[0]
    captured.write_text(captured.read_text() + "a line the sc never prints\n")
    h.must(h.git("commit", "-q", "-am", "breaks one captured-output test (rehearsal only)", cwd=h.merger), "commit")
    h.must(h.git("push", "-q", "origin", "main", cwd=h.merger), "push the broken main")
    refusal(h, "a failing staged suite", r"the suite failed against the staged TypeScript sc",
            args=("--accept-stopped", "--yes", "--stage-dir", h.s / "stage-failing"))
    h.must(h.git("reset", "-q", "--hard", good, cwd=h.merger), "reset the merger")
    h.must(h.git("push", "-q", "-f", "origin", "main", cwd=h.merger), "put the stand-in main back")

    section("--check on a good setup")
    refusal(h, "--check on a good setup passes", r"--check passed: the switch can go ahead",
            args=("--check", "--accept-stopped", "--stage-dir", h.s / "stage-check"), expect_ok=True)


def data_snapshot(h):
    """Every file in the data folder outside state/ and .git/, by content hash."""
    out = {}
    for p in sorted(h.data.rglob("*")):
        rel = p.relative_to(h.data).as_posix()
        if rel.startswith(("state/", ".git/")) or rel in ("state", ".git") or not p.is_file():
            continue
        out[rel] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


def result_checks(h, label, old_head, started_at, data_before, link_before):
    section(f"result checks after {label}")
    w1, w2 = h.workers
    check(h.origin_tag() == old_head, "last-python on origin names the old Python HEAD", (h.origin_tag() or "none")[:12])
    check(h.head_of() == h.target, "the core is at the target", h.head_of()[:12])
    r = h.sc("--help")
    check(r.returncode == 0, "bin/sc --help works, so the build is current (no stale-build refusal)",
          (r.stdout + r.stderr).strip()[-200:] if r.returncode else "")
    calls = [c for c in h.stub_calls() if c["t"] >= started_at]
    stop_t = next((c["t"] for c in calls if (c.get("argv") or [])[:2] == ["stop", h.chef_short]), None)
    log = (h.state / "watch.log").read_text()
    stopped_lines = [l for l in log.splitlines() if "watcher stopped between cycles (SIGTERM)" in l]
    stop_line_t = calendar.timegm(time.strptime(stopped_lines[-1][:19], "%Y-%m-%dT%H:%M:%S")) if stopped_lines else None
    check(stop_t is not None and stop_line_t is not None and stop_t < stop_line_t + 1,
          "claude stop for sous chef came before the old watcher stopped",
          f"stop at {stop_t}, watcher stop logged {stopped_lines[-1][:25] if stopped_lines else 'never'}")
    ws = h.watchers()
    check(not [w for w in ws if w[1] == "python"], "no Python watcher runs for the scratch core", str(ws))
    chef = h.chef()
    row = h.stub_session(chef.get("session_id")) or {}
    check(chef.get("session_id") == h.chef_sid and alive(row.get("pid")), "chef.json names the same sous chef, running",
          str(chef.get("session_id")))
    check(len(ws) == 1 and ws[0][1] == "node" and ws[0][0] == h.watch_pid(), "exactly one watcher runs, under Node, "
          "the pid in watch.pid", str(ws))
    try:
        code = json.loads((h.state / "watch.code").read_text())
    except (OSError, ValueError):
        code = {}
    check(code.get("pid") == h.watch_pid() and alive(h.watch_pid()), "watch.code names the running watcher's pid",
          str(code.get("pid")))
    node_started = code.get("started_at") or time.time()
    beats = []
    wait_for(lambda: (beats.append(read_beat(h)) or len(set(beats)) >= 4), 75, every=2)
    start = log.rfind(f"watcher started (pid {h.watch_pid()}")
    after = (h.state / "watch.log").read_text()[start:] if start >= 0 else ""
    check(len(set(beats)) >= 4 and start >= 0 and "cycle failed" not in after,
          "the Node watcher ran three more cycles with new watch.beat times and no 'cycle failed'",
          f"{len(set(beats))} beats")
    r = h.sc("summary")
    m = re.search(r"^## Watcher\n(.*)$", r.stdout, re.MULTILINE)
    check(m and m.group(1) == "running", "sc summary shows no watcher warning", m.group(1) if m else r.stderr[-200:])
    r = h.sc("sessions")
    check(r.returncode == 0 and w1["id"] in r.stdout and w2["id"] in r.stdout,
          "sc sessions reads the Python-written records", "")
    r = h.sc("events")
    check(r.returncode == 0, "sc events reads the Python-written logs", (r.stderr or "")[-200:])
    r = h.sc("status", w1["id"])
    check(r.returncode == 0 and "worker 1 started" in r.stdout, "sc status reads a Python-written record and its events",
          r.stdout[-200:] if r.returncode else "")

    # A pre-switch worker's saved hook commands, run as Claude Code would run them.
    stub_row = h.stub_session(w2["handle"]["short_id"])
    hooks = json.loads(stub_row["settings"])["hooks"]
    commands = {ev: hooks[ev][0]["hooks"][0]["command"] for ev in ("UserPromptSubmit", "Stop")}
    turns = h.state / "sessions" / w2["id"] / "turns.json"
    before_turns = json.loads(turns.read_text()) if turns.exists() else {}
    session_path = f"{h.node_dir}:/usr/bin:/bin"
    hook_env = {k: h.env[k] for k in ("HOME", "USER", "TMPDIR", "PORCH_HOME", "CLAUDE_CONFIG_DIR") if k in h.env}
    hook_env["PATH"] = session_path
    outs = [h.run(["/bin/sh", "-c", commands[ev]], env=hook_env, input="{}", cwd=h.work) for ev in ("UserPromptSubmit", "Stop")]
    after_turns = json.loads(turns.read_text()) if turns.exists() else {}
    check(all(o.returncode == 0 for o in outs) and after_turns.get("last_prompt_at")
          and after_turns.get("last_stop_at") and after_turns != before_turns,
          "a pre-switch worker's saved hook commands run under the TypeScript sc and update turns.json",
          f"PATH={session_path}; {commands['UserPromptSubmit']}" if all(o.returncode == 0 for o in outs)
          else str([(o.returncode, o.stderr[-200:]) for o in outs]))
    bare = h.run(["/bin/sh", "-c", commands["Stop"]], env={**hook_env, "PATH": "/usr/bin:/bin"}, input="{}", cwd=h.work)
    info(f"the same Stop hook command with PATH=/usr/bin:/bin (no Node on it) exits {bare.returncode}: "
         f"{(bare.stderr or bare.stdout).strip()[-120:]} -- the documented known limit (hooks find Node through PATH)")
    events_file = h.state / "sessions" / w2["id"] / "events.jsonl"
    n_before = len(events_file.read_text().splitlines())
    r = h.run([h.core / "bin" / "sc", "report", "note", f"a report after {label}"], cwd=h.work,
              extra_env={"CLAUDE_CODE_SESSION_ID": w2["handle"]["session_id"]})
    lines = events_file.read_text().splitlines()
    check(r.returncode == 0 and len(lines) == n_before + 1 and f"a report after {label}" in lines[-1],
          "sc report from a pre-switch worker adds its event", (r.stdout + r.stderr).strip()[-200:])

    cron_log = h.state / "cron" / "events.jsonl"
    def fired():
        try:
            return [e for e in map(json.loads, cron_log.read_text().splitlines())
                    if e.get("state") == "due" and e.get("ts", 0) >= node_started]
        except (OSError, ValueError):
            return []
    got = wait_for(fired, 150, every=3)
    check(got, "the chef cron job fired under the TypeScript watcher (a due event in the cron log)",
          f"{len(got)} due event(s) since the Node watcher started" if got else "")

    mem = h.data / "memory" / "rehearsal.md"
    mem.write_text(mem.read_text() + f"Edited after {label}.\n")
    def synced():
        log_out = h.git("--git-dir", h.data_origin, "log", "-p", "-1", h.data_branch, "--", "memory/rehearsal.md").stdout
        status = h.git("status", "-sb", cwd=h.data).stdout.splitlines()[0]
        return f"Edited after {label}." in log_out and "ahead" not in status
    check(wait_for(synced, 180, every=3), "a memory edit is committed and pushed by the TypeScript watcher's sync",
          h.git("--git-dir", h.data_origin, "log", "--oneline", "-1", h.data_branch).stdout.strip())

    data_after = data_snapshot(h)
    changed = sorted(k for k in set(data_before) | set(data_after) if data_before.get(k) != data_after.get(k))
    check(changed == ["memory/rehearsal.md"], "the data folder outside state/ is byte for byte unchanged, apart from "
          "the check's own memory edit", f"changed: {changed}")
    check(os.readlink(h.core / "my") == link_before, "the my link target is unchanged", link_before)


def rollback_checks(h, started_at):
    section("rollback")
    r = h.switch("--rollback", "--yes", label="rollback")
    check(r.returncode == 0, "--rollback finishes", "" if r.returncode == 0 else (r.stdout + r.stderr).strip()[-800:])
    calls = [c for c in h.stub_calls() if c["t"] >= started_at]
    check(any((c.get("argv") or [])[:2] == ["stop", h.chef_short] for c in calls), "--rollback stopped the stub sous chef")
    check(h.head_of() == h.origin_tag(), "the core is at last-python", h.head_of()[:12])
    ws = h.watchers()
    check(not [w for w in ws if w[1] == "node"], "the TypeScript watcher is gone", str(ws))
    chef = h.chef()
    row = h.stub_session(chef.get("session_id")) or {}
    check(chef.get("session_id") == h.chef_sid and alive(row.get("pid")),
          "the Python souschef resumed the same sous chef session", str(chef.get("session_id")))
    check(len(ws) == 1 and ws[0][1] == "python" and ws[0][0] == h.watch_pid(),
          "exactly one watcher runs, the Python one the chef-start hook started", str(ws))
    log = (h.state / "watch.log").read_text()
    start = log.rfind(f"watcher started (pid {h.watch_pid()}")
    beats = []
    wait_for(lambda: (beats.append(read_beat(h)) or len(set(beats)) >= 3), 60, every=2)
    after = (h.state / "watch.log").read_text()[start:] if start >= 0 else ""
    check(start >= 0 and len(set(beats)) >= 3 and "cycle failed" not in after,
          "the Python watcher took its lock among the TypeScript leftovers and runs cycles cleanly",
          f"{len(set(beats))} beats")


def cleanup(h, keep):
    section("cleanup")
    for pid, lang, _ in h.watchers():
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    wait_for(lambda: not h.watchers(), 60)
    left = h.watchers()
    if h.stub.exists():
        h.run([h.stub, "_stub", "killall"])
    stray = [l for l in subprocess.run(["ps", "-axww", "-o", "pid=,command="], capture_output=True,
                                       text=True).stdout.splitlines() if str(h.s) in l]
    for line in stray:
        try:
            os.kill(int(line.split()[0]), signal.SIGTERM)
        except (ProcessLookupError, ValueError):
            pass
    check(not left, "every scratch watcher stopped", str(left))
    if not keep:
        shutil.rmtree(h.s, ignore_errors=True)
        info(f"removed {h.s}")
    else:
        info(f"kept {h.s}")


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("head", help="the integration branch head to switch to (a commit in --repo)")
    p.add_argument("--repo", help="the core repo holding the commits (default: the repo this file is in)")
    p.add_argument("--python-base", help="the Python main to install first (default: merge-base of head and "
                                         "origin/main in --repo)")
    p.add_argument("--scratch", help="an empty folder to work in (default: a new one in $TMPDIR)")
    p.add_argument("--keep", action="store_true", help="keep the scratch folder")
    args = p.parse_args()
    repo = Path(args.repo or subprocess.run(["git", "-C", str(HERE), "rev-parse", "--show-toplevel"],
                                            capture_output=True, text=True).stdout.strip()).resolve()
    g = lambda *a: subprocess.run(["git", "-C", str(repo), *a], capture_output=True, text=True).stdout.strip()
    head = g("rev-parse", f"{args.head}^{{commit}}")
    base = g("rev-parse", f"{args.python_base}^{{commit}}") if args.python_base else g("merge-base", head, "origin/main")
    if not head or not base:
        sys.exit("rehearse: cannot resolve the head or the Python base in " + str(repo))
    if "python" not in g("show", f"{base}:bin/sc").splitlines()[0]:
        sys.exit(f"rehearse: {base[:12]}'s bin/sc is not the Python one")
    if args.scratch:
        scratch = Path(args.scratch).resolve()
        if scratch.exists() and any(scratch.iterdir()):
            sys.exit(f"rehearse: {scratch} is not empty")
        scratch.mkdir(parents=True, exist_ok=True)
    else:
        scratch = Path(tempfile.mkdtemp(prefix="sc-switch-rehearsal-")).resolve()
    h = H(scratch, repo, head, base)
    say(f"Rehearsal of the switch-over: integration head {head}, Python main {base}")
    say(f"script {SCRIPT}, sha256 {hashlib.sha256(SCRIPT.read_bytes()).hexdigest()[:16]}")
    say(f"scratch {scratch}; node {shutil.which('node')}; PATH {h.path}")
    before_live = live_snapshot(h)
    try:
        setup(h)
        refusals_before_merge(h)
        merge_integration(h)
        refusals(h)

        section("the switch")
        data_before, link_before = data_snapshot(h), os.readlink(h.core / "my")
        old_head, started = h.head_of(), time.time()
        r = h.switch("--accept-stopped", "--yes", "--stage-dir", h.s / "stage-switch", label="switch")
        check(r.returncode == 0, "the switch finishes", "" if r.returncode == 0 else (r.stdout + r.stderr).strip()[-1500:])
        result_checks(h, "the switch", old_head, started, data_before, link_before)

        rollback_checks(h, time.time())

        section("switching forward again (git checkout main, then the script)")
        h.must(h.git("checkout", "-q", "main", cwd=h.core), "checkout main")
        data_before = data_snapshot(h)
        started = time.time()
        r = h.switch("--accept-stopped", "--yes", "--stage-dir", h.s / "stage-forward", label="forward-again")
        check(r.returncode == 0, "the switch forward again finishes",
              "" if r.returncode == 0 else (r.stdout + r.stderr).strip()[-1500:])
        result_checks(h, "switching forward again", old_head, started, data_before, link_before)
    finally:
        section("the live install was not touched")
        check_live_untouched(h, before_live)
        cleanup(h, args.keep)
    failed = [r for r in results if not r[0]]
    say(f"\n{len(results) - len(failed)} PASS, {len(failed)} FAIL")
    for _, name, detail in failed:
        say(f"  FAIL {name}: {detail}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
