"""Claude Code hook handlers, run as `sc hook <name>`.

Chef hooks are configured in .agents/settings.json (sous chef's own folder).
Worker hooks are passed to each spawned session at launch (ops.worker_settings).

A hook must never break the session it runs in: every handler catches its own
errors, writes them to state/hook-errors.log (in the data folder, or the code
folder's state/ when there is none), and exits 0. The chef hooks work without a
data folder: chef-start says how to make one, guard-edit still protects state/.
"""
import json
import os
import sys
import traceback
from pathlib import Path

from . import chef, context, inbox, records, summary, util, watch


def _stdin_json() -> dict:
    try:
        raw = sys.stdin.read()
        return json.loads(raw) if raw.strip() else {}
    except ValueError:
        return {}


def _context(event: str, text: str) -> None:
    print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}}))


def chef_start(_args) -> None:
    data = _stdin_json()
    source = data.get("source", "startup")
    session_id = data.get("session_id")

    # Every session started in this folder runs this hook, including one spawned
    # into a worktree of this repo and one the owner opens by hand. Only one of them
    # is sous chef: a live registration is never taken from underneath its owner,
    # because wake-ups follow the registration and the loser would go unheard.
    real_home = chef.worktree_of_home()
    if real_home:
        _context("SessionStart",
                 f"You are NOT sous chef. This is a git worktree of sous chef's repo; sous chef itself "
                 f"runs from {real_home}. Do the task you were given (your brief says what it is) and "
                 f"leave sessions and memory to sous chef. Report with the absolute `sc` path in your "
                 f"brief, which is sous chef's own, so your events reach it. This worktree's own `bin/sc` "
                 f"does not reach sous chef's data.")
        return

    problem = util.home_problem()
    if problem:
        _context("SessionStart",
                 f"Sous chef cannot start: it has no data folder (memory, sessions, settings). {problem}. "
                 f"Tell the person you are working with, and do nothing as sous chef until it is fixed.")
        return

    held = chef.live_incumbent()
    if held and session_id and held["session_id"] != session_id:
        owner = util.owner_name()
        _context("SessionStart",
                 f"You are NOT sous chef. Session {held['session_id'][:8]} holds that role and is still "
                 f"running, so it keeps it and receives the wake-ups. Do the task you were given and do "
                 f"not manage sessions or memory as sous chef does. If {held['session_id'][:8]} is wedged "
                 f"and {owner} wants this session to take over, {owner} runs `sc chef --take` here.")
        return

    prev = None
    if session_id:
        prev = chef.register(session_id, os.environ.get("SC_CHEF_RUNTIME", "claude-bg"))
    notes = []
    started = watch.ensure()
    if not started["running"]:
        notes.append("The watcher could not be started; run `sc watch --ensure` and check state/watch.log.")
    if started["note"]:
        notes.append(f"Watcher: {started['note']}.")
    if prev and prev.get("session_id") != session_id and source == "startup":
        notes.append(f"A different sous chef session ({prev['session_id'][:8]}) was registered before this "
                     f"one; it is not running, so this session took over.")
    header = (f"SOUS CHEF STARTUP SUMMARY (SessionStart source={source}). Your conversation may have "
              f"been compacted or restarted: trust this summary and the files it names over memory.")
    _context("SessionStart", "\n\n".join([header] + notes + [summary.build()]))


def chef_stop(_args) -> None:
    """At the end of each of sous chef's turns, check how full its context is (context.py).

    Prints nothing: a Stop hook's output can keep the turn going, and this must never
    interrupt. What it finds goes into the context log and state/context/state.json.
    """
    if util.home_problem():
        return  # nothing to record into; chef-start already said what to fix
    context.on_stop(_stdin_json())


def worker_start(args) -> None:
    data = _stdin_json()
    rec = records.load(args.session)
    waiting = len(inbox.unhandled(rec["id"]))
    brief = records.session_dir(rec["id"]) / "brief.md"
    text = (f"You are sous chef session {rec['id']} ({rec['kind']}: {rec['title']}). "
            f"Your instructions are in {brief}; if they are not in your context "
            f"(source={data.get('source')}), read them again before continuing.")
    if waiting:
        text += f" There are {waiting} unhandled message(s) from sous chef: run `sc inbox` first."
    _context("SessionStart", text)


def worker_prompt(args) -> None:
    records.record_turn(args.session, "last_prompt_at")


def worker_stop(args) -> None:
    records.record_turn(args.session, "last_stop_at")


def guard_edit(args) -> None:
    """Deny file-tool writes under state/: those files belong to `sc` commands.

    With --session, this is a spawned session, and its own report file is allowed,
    because that is the deliverable the brief asks it to write.
    """
    data = _stdin_json()
    tool_input = data.get("tool_input") or {}
    target = tool_input.get("file_path") or tool_input.get("notebook_path")
    if not target:
        return
    path = Path(target).expanduser().resolve()
    if getattr(args, "session", None):
        try:
            own_report = (records.session_dir(args.session) / "report.md").resolve()
        except util.SCError:
            own_report = None
        if path == own_report:
            return
    # Protect the state folder of the data folder and of the code folder. The code
    # folder's state/ is where hook errors are logged when there is no data folder (`run`).
    protected = {(util.CODE_ROOT / "state").resolve()}
    try:
        protected.add(util.state_dir().resolve())
    except util.SCError:
        pass
    if any(path == d or d in path.parents for d in protected):
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": "Files under state/ are written only by sc commands. "
                                        "Use sc (see `sc --help`) instead of editing them.",
        }}))


HANDLERS = {
    "chef-start": chef_start,
    "chef-stop": chef_stop,
    "worker-start": worker_start,
    "worker-prompt": worker_prompt,
    "worker-stop": worker_stop,
    "guard-edit": guard_edit,
}


def run(args) -> int:
    try:
        HANDLERS[args.hook_name](args)
    except Exception:  # noqa: BLE001 - a hook must never fail the session
        try:
            try:
                log = util.state_dir() / "hook-errors.log"
            except util.SCError:
                log = util.CODE_ROOT / "state" / "hook-errors.log"
            log.parent.mkdir(parents=True, exist_ok=True)
            with open(log, "a") as f:
                f.write(f"{util.iso(util.now())} {args.hook_name}\n{traceback.format_exc()}\n")
        except OSError:
            pass
    return 0
