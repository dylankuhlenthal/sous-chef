#!/usr/bin/env python3
"""A stand-in for Claude Code's `claude` command, for the switch-over rehearsal only.

rehearse.sh copies this file to <scratch>/stub/claude, puts that folder first on PATH
and points PORCH_CLAUDE_BIN at it, so the Python sc, the TypeScript sc, Porch and the
switch-over script all reach this instead of real Claude Code. Its state is
state.json next to it, and every call is appended to calls.jsonl next to it.

It answers what those programs call:
  --version
  --bg [-n <name>] [--permission-mode m] [--settings json] [--model m] [--effort e] [prompt]
      adds a session and prints `backgrounded · <short> · <name>`
  --bg --resume <session id>          (no other flags) brings that session back
  agents --json [--all]               the listing; without --all only running sessions
  stop <short>                        stops a session; its row stays, without a pid
  attach <short>, logs <short>, rm <short>   print only / forget the row
A "running" session is a real `sleep` process whose pid the row carries, so anything
that checks the pid (kill -0) sees a live process, and Porch's guessed socket path
(/tmp/cc-socks/<pid>.sock) names a process that is not Claude Code.

When a session starts or resumes in a sous chef core (the folder has bin/sc and
.agents/settings.json), the stub runs that folder's SessionStart hook commands with
{"session_id", "source"} on stdin and CLAUDE_PROJECT_DIR set, as Claude Code would.
Worker hooks are never run by the stub: the rehearsal runs a worker's saved hook
commands itself.

Rehearsal-only commands, never called by sous chef:
  _stub set <short|session id> <key>=<value> ...   e.g. status=busy, kind=interactive
  _stub kill <short|session id>      the session stops without `claude stop` (as when
                                     Claude Code itself stops it)
  _stub start <short|session id>     give a stopped session a process again, no hooks
  _stub killall                      stop every sleep process the stub started
  _stub show                         print the state
"""
import fcntl
import json
import os
import shlex
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

HERE = Path(os.path.realpath(__file__)).parent
STATE = HERE / "state.json"
LOG = HERE / "calls.jsonl"
LOCK = HERE / ".lock"
SLEEP_SECONDS = "21600"  # a sleeper outlives no rehearsal by more than six hours


def log(entry):
    entry = {"t": round(time.time(), 3), **entry}
    with open(LOG, "a") as f:
        f.write(json.dumps(entry) + "\n")


class Locked:
    def __enter__(self):
        self.f = open(LOCK, "a")
        fcntl.flock(self.f.fileno(), fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        fcntl.flock(self.f.fileno(), fcntl.LOCK_UN)
        self.f.close()


def load():
    try:
        return json.loads(STATE.read_text())
    except (OSError, ValueError):
        return {"sessions": []}


def save(state):
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2))
    os.replace(tmp, STATE)


def find(state, key):
    for s in state["sessions"]:
        if key in (s["id"], s["sessionId"]):
            return s
    return None


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


def start_process():
    p = subprocess.Popen(["/bin/sleep", SLEEP_SECONDS], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    return p.pid


def stop_process(pid):
    if not alive(pid):
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    for _ in range(50):
        try:
            # Reap it if it is our child (it is not, after start_new_session from another call).
            os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            pass
        if not alive(pid):
            return
        time.sleep(0.1)


def is_core(cwd):
    return (Path(cwd) / "bin" / "sc").is_file() and (Path(cwd) / ".agents" / "settings.json").is_file()


def run_session_start(cwd, session_id, source):
    """Run the folder's SessionStart hooks as Claude Code would. Returns what they printed."""
    try:
        settings = json.loads((Path(cwd) / ".agents" / "settings.json").read_text())
    except (OSError, ValueError) as e:
        return [{"error": f"no readable .agents/settings.json: {e}"}]
    out = []
    for group in settings.get("hooks", {}).get("SessionStart", []):
        for hook in group.get("hooks", []):
            command = hook.get("command")
            if not command:
                continue
            env = {**os.environ, "CLAUDE_PROJECT_DIR": str(cwd)}
            try:
                r = subprocess.run(["/bin/sh", "-c", command], cwd=cwd, env=env, capture_output=True, text=True,
                                   input=json.dumps({"session_id": session_id, "source": source,
                                                     "hook_event_name": "SessionStart", "cwd": str(cwd)}),
                                   timeout=int(hook.get("timeout", 60)) + 5)
                out.append({"command": command, "exit": r.returncode, "stdout": r.stdout[-4000:],
                            "stderr": r.stderr[-2000:]})
            except subprocess.TimeoutExpired:
                out.append({"command": command, "exit": None, "error": "timed out"})
    return out


def row(s, include_stopped):
    running = alive(s.get("pid"))
    if not running and not include_stopped:
        return None
    r = {"id": s["id"], "sessionId": s["sessionId"], "name": s.get("name"), "kind": s.get("kind", "background"),
         "cwd": s.get("cwd")}
    if running:
        r["pid"] = s["pid"]
        r["status"] = s.get("status", "idle")
        if r["status"] == "waiting":
            r["waitingFor"] = s.get("waitingFor", "permission prompt")
    return r


VALUE_FLAGS = {"-n", "--name", "--permission-mode", "--settings", "--model", "--effort", "--resume"}


def parse_bg(args):
    opts, positional, i = {}, [], 0
    while i < len(args):
        a = args[i]
        if a == "--bg":
            opts["bg"] = True
        elif a in VALUE_FLAGS and i + 1 < len(args):
            opts[a] = args[i + 1]
            i += 1
        elif a.startswith("-"):
            opts[a] = True
        else:
            positional.append(a)
        i += 1
    return opts, positional


def new_session(state, name, cwd, opts, prompt):
    sid = str(uuid.uuid4())
    s = {"id": sid.replace("-", "")[:8], "sessionId": sid, "name": name, "kind": "background", "cwd": cwd,
         "pid": start_process(), "status": "idle", "permissionMode": opts.get("--permission-mode"),
         "settings": opts.get("--settings"), "model": opts.get("--model"), "effort": opts.get("--effort"),
         "prompt": prompt, "started": time.time()}
    state["sessions"].append(s)
    return s


def cmd_bg(args):
    opts, positional = parse_bg(args)
    cwd = os.getcwd()
    with Locked():
        state = load()
        if "--resume" in opts:
            others = [k for k in opts if k not in ("bg", "--resume")]
            s = find(state, opts["--resume"])
            if s is None:
                print(f"No conversation found with session ID: {opts['--resume']}", file=sys.stderr)
                return 1
            if others or positional:
                # Claude Code starts a copy under a new id when --resume comes with other flags.
                s = new_session(state, s.get("name"), cwd, opts, " ".join(positional))
                source = "startup"
            else:
                if not alive(s.get("pid")):
                    s["pid"] = start_process()
                s["status"] = "idle"
                s["cwd"] = cwd
                source = "resume"
        else:
            name = opts.get("-n") or opts.get("--name") or f"session-{len(state['sessions']) + 1}"
            s = new_session(state, name, cwd, opts, " ".join(positional))
            source = "startup"
        save(state)
    hooks = run_session_start(cwd, s["sessionId"], source) if is_core(cwd) else []
    log({"call": "hooks", "session": s["id"], "source": source, "cwd": cwd, "hooks": hooks})
    print(f"backgrounded · {s['id']} · {s.get('name')}")
    return 0


def cmd_agents(args):
    with Locked():
        state = load()
    rows = [r for r in (row(s, "--all" in args) for s in state["sessions"]) if r]
    print(json.dumps(rows))
    return 0


def cmd_stop(args):
    if not args:
        print("usage: claude stop <id>", file=sys.stderr)
        return 1
    with Locked():
        state = load()
        s = find(state, args[0])
        if s is None:
            print(f"no session {args[0]}", file=sys.stderr)
            return 1
        pid = s.get("pid")
        s["pid"] = None
        s["status"] = None
        save(state)
    stop_process(pid)
    print(f"stopped {s['id']}")
    return 0


def cmd_stub(args):
    if not args:
        return 2
    verb, rest = args[0], args[1:]
    with Locked():
        state = load()
        if verb == "killall":
            for s in state["sessions"]:
                stop_process(s.get("pid"))
                s["pid"] = None
            save(state)
            return 0
        if verb == "show":
            print(json.dumps(state, indent=2))
            return 0
        s = find(state, rest[0]) if rest else None
        if s is None:
            print(f"_stub {verb}: no session {rest[:1]}", file=sys.stderr)
            return 1
        if verb == "set":
            for pair in rest[1:]:
                key, _, value = pair.partition("=")
                s[key] = None if value == "" else value
        elif verb == "kill":
            stop_process(s.get("pid"))
            s["pid"] = None
        elif verb == "start":
            if not alive(s.get("pid")):
                s["pid"] = start_process()
            s["status"] = s.get("status") or "idle"
        else:
            return 2
        save(state)
    return 0


def main(argv):
    log({"call": "claude", "argv": argv, "cwd": os.getcwd(), "path0": os.environ.get("PATH", "").split(":")[0]})
    if not argv:
        print("the rehearsal's claude stub has no interactive mode", file=sys.stderr)
        return 1
    if argv[0] == "--version":
        print("2.1.286 (Claude Code; switch-over rehearsal stub)")
        return 0
    if argv[0] == "_stub":
        return cmd_stub(argv[1:])
    if argv[0] == "agents":
        return cmd_agents(argv[1:])
    if argv[0] == "stop":
        return cmd_stop(argv[1:])
    if argv[0] in ("attach", "logs"):
        print(f"(stub) claude {' '.join(shlex.quote(a) for a in argv)}")
        return 0
    if argv[0] == "rm":
        if len(argv) < 2:
            print("usage: claude rm <id>", file=sys.stderr)
            return 1
        with Locked():
            state = load()
            state["sessions"] = [s for s in state["sessions"] if argv[1] not in (s["id"], s["sessionId"])]
            save(state)
        return 0
    if "--bg" in argv:
        return cmd_bg(argv)
    print(f"the rehearsal's claude stub does not support: {argv}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
