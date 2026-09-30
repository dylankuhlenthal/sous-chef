"""The operations behind the commands: spawn, send, report, stop, resume, mark, cleanup."""
import os
import shlex
import shutil
import subprocess
import time
from pathlib import Path

from . import chef, events, inbox, kinds, records, runtimes, util, wake, worktrees

WAITING_VALUES = util.WAITING_VALUES


def set_owner(name: str, branch_prefix: str) -> dict:
    """Write owner.json (util.owner). Refuses a name that would read as another waiting-on value."""
    name = (name or "").strip()
    problem = util.owner_problem(name, branch_prefix)
    if problem:
        raise util.SCError(problem)
    util.write_json(util.owner_path(), {"name": name, "branch_prefix": branch_prefix})
    return util.owner()


def _hook(name: str, sid: str) -> dict:
    cmd = f"{shlex.quote(str(util.sc_bin()))} hook {name} --session {shlex.quote(sid)}"
    return {"hooks": [{"type": "command", "command": cmd, "timeout": 30}]}


def worker_settings(rec: dict) -> dict:
    """Settings every spawned session runs with, passed at launch (never written into repos).

    A session in a worktree sous chef created for it (rec["own_worktree"]) may edit
    there directly, so Claude Code's background worktree isolation is turned off
    for that session only. Every other session keeps Claude Code's default.
    """
    sid = rec["id"]
    guard = _hook("guard-edit", sid)
    guard["matcher"] = "Edit|Write|MultiEdit|NotebookEdit"
    settings = {"hooks": {
        "SessionStart": [_hook("worker-start", sid)],
        "UserPromptSubmit": [_hook("worker-prompt", sid)],
        "Stop": [_hook("worker-stop", sid)],
        # The same guard sous chef runs, so a session cannot hand-edit any session's
        # records. Its own report file is the one allowed path (hooks.guard_edit).
        "PreToolUse": [guard],
    }}
    if rec.get("own_worktree"):
        settings["worktree"] = {"bgIsolation": "none"}
    return settings


def worker_env(sid: str) -> dict:
    """Best-effort environment for a session: only PATH, so a bare `sc` usually works.

    Nothing may depend on it. Claude Code can start a background session in a spare
    process created with an earlier launch's environment, so identity and paths
    reach the session through its brief, its hooks and CLAUDE_CODE_SESSION_ID instead.
    """
    bin_dir = str(util.sc_bin().parent)
    path = os.environ.get("PATH", "")
    return {"PATH": path if bin_dir in path.split(":") else f"{bin_dir}:{path}"}


WORKER_INSTRUCTIONS = "worker-instructions.md"


def _owner_instructions_section() -> str:
    """The owner's instructions for every session (worker-instructions.md in the data folder) as a
    brief section, or "" when there is no such file or nothing in it but comments. Never filled in."""
    text = util.owner_text(util.home() / WORKER_INSTRUCTIONS)
    return f"## Instructions from your owner\n\n{text}\n\n" if text else ""


def _render_brief(rec: dict, kind: dict, task: str) -> str:
    template = (util.templates_dir() / "worker-brief.md").read_text()
    owner = util.require_owner()["name"]
    values = {
        "owner": owner,
        "id": rec["id"],
        "sc": str(util.sc_bin()),
        "kind": rec["kind"],
        "title": rec["title"],
        "cwd": rec["cwd"],
        "report_path": str(records.session_dir(rec["id"]) / "report.md"),
        "worktree_note": ("This directory is a git worktree sous chef created for this task, on its own branch. "
                          "Work here directly; do not create or enter another worktree."
                          if rec.get("own_worktree") else
                          "This directory was not created for this task, so others may be using it. If the task "
                          "needs to change files, Claude Code may require you to enter a worktree first; follow it."),
        "kind_instructions": util.render(kind["body"], {"owner": owner}),
        "owner_instructions": _owner_instructions_section(),
        "task": task.strip(),
    }
    return util.render(template, values)


def check_cwd(cwd: str) -> Path:
    """The resolved working directory for a session, or a refusal saying why it cannot be one."""
    cwd_path = Path(cwd).expanduser().resolve()
    if not cwd_path.is_dir():
        raise util.SCError(f"working directory does not exist: {cwd_path}")
    for root, why in ((util.CODE_ROOT.resolve(), "code folder: it would load sous chef's own instructions and hooks"),
                      (util.home().resolve(), "data folder: its files are sous chef's own records and memory")):
        if cwd_path == root or root in cwd_path.parents:
            raise util.SCError(f"a session cannot run inside the sous chef {why}")
    return cwd_path


def check_skill(kind: dict, rt, cwd) -> None:
    """Refuse when the kind's skill is definitely not available to a session of this runtime in `cwd`.

    Only a definite "missing" (False) refuses; a runtime that cannot tell (None) lets it through.
    """
    skill = kind.get("skill")
    if not skill or rt.skill_available(skill, str(cwd)) is not False:
        return
    places = rt.skill_places(str(cwd))
    looked = ", ".join(places[:-1]) + f" and {places[-1]}" if len(places) > 1 else places[0]
    # While the user kinds folder is the core's (kinds._folders), there is nowhere separate to
    # put a replacement, so the way round it is to change the kind file itself.
    fix = (f"add your own version of the kind in {util.user_kinds_dir()}" if kinds.separate_user_kinds()
           else f"change the kind file {kind['path']}")
    raise util.SCError(f"kind '{kind['name']}' needs the skill '{skill}', which is not in your skills "
                       f"(looked in {looked}). Install it, or {fix}.")


def spawn(kind_name: str, title: str, cwd: str, task: str, thread: str = None, model: str = None,
          effort: str = None, runtime: str = None, cron: dict = None, permissions: str = None) -> dict:
    """Launch a session. `cron` ({"job": name}) marks one a scheduled job launched (cron.py).

    `permissions` is one of runtimes.PERMISSIONS, recorded so that it is visible later;
    None means the kind's own `permissions`, and if it sets none, runtimes.DEFAULT_PERMISSIONS.
    """
    util.require_owner()
    kind = kinds.load(kind_name)
    if not task or not task.strip():
        raise util.SCError("the task text is empty; pass it on stdin or with --task-file")
    permissions = permissions or kind["permissions"] or runtimes.DEFAULT_PERMISSIONS
    if permissions not in runtimes.PERMISSIONS:
        raise util.SCError(f"unknown permissions '{permissions}' (use one of: {', '.join(runtimes.PERMISSIONS)})")
    cwd_path = check_cwd(cwd)
    rt = runtimes.get(runtime or runtimes.DEFAULT)
    check_skill(kind, rt, cwd_path)
    sid = records.new_id(kind["name"], title)
    rec = {
        "id": sid, "kind": kind["name"], "title": title, "cwd": str(cwd_path), "runtime": rt.NAME,
        "created_at": util.now(), "thread": thread, "model": model, "effort": effort,
        "permissions": permissions, "handle_name": f"sc-{sid}", "handle": None, "stopped_by_sc": False,
    }
    if cron:
        rec["cron"] = cron
    rec["own_worktree"] = worktrees.claim_for(str(cwd_path), sid)
    records.save(rec)
    brief_path = records.session_dir(sid) / "brief.md"
    brief_path.write_text(_render_brief(rec, kind, task))
    events.append(sid, "sc", "launched", f"{kind['name']}: {title}", waiting_on=kind["starts_waiting_on"])
    prompt = (f"You were launched by sous chef as session {sid}. Read your full instructions at "
              f"{brief_path} now and follow them.")
    try:
        rec["handle"] = rt.launch(rec, prompt, worker_env(sid), worker_settings(rec))
    except util.SCError as e:
        events.append(sid, "sc", "failed", f"launch failed: {e}", waiting_on="nobody")
        worktrees.release(sid)
        raise
    records.save(rec)
    return rec


def send(rec: dict, text: str, resolves: str = None, sender: str = "sous chef", only_if_idle: bool = False) -> tuple:
    """Save a message in a session's inbox and wake it. Returns (message, why it was not woken or None).

    With `only_if_idle`, a session that is mid-turn (or whose state is unknown) is not
    woken: the message waits, and the watcher wakes the session once it is idle.
    """
    sid = rec["id"]
    if not text.strip():
        raise util.SCError("empty message")
    if resolves:
        open_keys = {q["key"] for q in events.open_questions(events.read_all(sid))}
        if resolves not in open_keys:
            raise util.SCError(f"{sid} has no open question with key '{resolves}' "
                               f"(open: {', '.join(sorted(open_keys)) or 'none'})")
    msg = inbox.write(sid, text, sender=sender, resolves=resolves)
    if resolves:
        events.append(sid, "sc", "resolved", f"answered in inbox message {msg['seq']}", key=resolves)
    rt = runtimes.get(rec["runtime"])
    if only_if_idle and rt.status(rec)["busy"] is not False:
        return msg, "the session is mid-turn, so the watcher wakes it once it is idle"
    try:
        rt.wake(rec, f"sous chef: new message {msg['seq']} in your inbox. Run `sc inbox`, act on it, "
                     f"then run `sc inbox ack {msg['seq']}`.")
        return msg, None
    except wake.WakeError as e:
        return msg, str(e)  # the message is saved; this says why nobody was woken


def current_session_record() -> dict:
    """The session calling `sc report` or `sc inbox`, from the Claude session id Claude Code sets.

    Never from a variable sous chef passes at launch (see worker_env). Right after
    launch the record may not have its Claude id yet, so this waits briefly for it.
    """
    claude_sid = os.environ.get("CLAUDE_CODE_SESSION_ID")
    if not claude_sid:
        raise util.SCError("this command only works inside a Claude Code session launched by sous chef "
                           "(CLAUDE_CODE_SESSION_ID is not set)")
    deadline = time.time() + float(os.environ.get("SC_IDENTITY_WAIT", "25"))
    while True:
        rec = records.find_by_claude_session(claude_sid)
        if rec or time.time() >= deadline:
            break
        time.sleep(1)
    if not rec:
        raise util.SCError(f"this Claude session ({claude_sid[:8]}) is not one sous chef launched, "
                           f"so there is no log to report to")
    return rec


def report(state: str, text: str, key: str = None) -> dict:
    rec = current_session_record()
    if state not in events.SESSION_STATES:
        raise util.SCError(f"unknown state '{state}' (use one of: {', '.join(events.SESSION_STATES)})")
    if state == "resolved" and not key:
        raise util.SCError("resolved needs --key naming the question it closes")
    if not text.strip() and state != "resolved":
        raise util.SCError("say what happened: the report text is empty")
    if state == "note" and events.READS_AS_QUESTION.search(text):
        raise util.SCError(
            "this reads like a question, and a question reported as a note does not exist: "
            "it never wakes sous chef and never shows as an open question, so nobody learns "
            "you are waiting. Report it with:\n"
            '  sc report needs-decision "<the question, the options, your recommendation>"\n'
            "which prints a key sous chef answers with `sc send --resolves <key>`. "
            "Put the whole question in that command, not a summary pointing somewhere else.")
    if state == "nothing-new" and not rec.get("cron"):
        raise util.SCError("nothing-new is only for sessions a scheduled job launched. "
                           "Report what came out of the task with `sc report done \"...\"`.")
    if state == "resolved":
        open_keys = {q["key"] for q in events.open_questions(events.read_all(rec["id"]))}
        if key not in open_keys:
            raise util.SCError(f"no open question with key '{key}' "
                               f"(open: {', '.join(sorted(open_keys)) or 'none'})")
    event = events.append(rec["id"], "session", state, text, key=key)
    if state in events.WAKE_STATES:
        event["woke_sous_chef"] = chef.wake_chef(
            f"sous chef: session {rec['id']} reported {state}. Run `sc events`.")
    return event


def stop(rec: dict) -> None:
    runtimes.get(rec["runtime"]).stop(rec)
    rec["stopped_by_sc"] = True
    records.save(rec)
    events.append(rec["id"], "sc", "stopped", "stopped by sous chef")


def resume(rec: dict, author: str = "sc", state: str = "resumed", text: str = "resumed by sous chef") -> dict:
    """Start a stopped session again. Refuses one that is running, which would risk two copies of it.

    A session that could not be checked is refused too: the runtime's error says why.
    `author`, `state` and `text` are the event it appends: the watcher resuming a
    session itself records `auto-resumed` (watch.py, check 1). Returns that event.
    """
    rt = runtimes.get(rec["runtime"])
    if rt.status(rec)["alive"]:
        raise util.SCError(f"{rec['id']} is already running, so it was not resumed: resuming it could start "
                           f"a second copy. Message it with `sc send {rec['id']} \"...\"`, check it with "
                           f"`sc status {rec['id']}`, or open it with `{rt.attach_command(rec)}`.")
    rt.resume(rec, worker_env(rec["id"]), worker_settings(rec))
    rec["stopped_by_sc"] = False
    records.save(rec)
    return events.append(rec["id"], author, state, text)


def waiting_value(value: str) -> str:
    """A waiting-on value as typed (`owner`, or the owner's name in any case) as stored, or a refusal."""
    o = util.owner()
    if o and value.lower() == o["lower"]:
        return "owner"
    if value in WAITING_VALUES:
        return value
    owner = f"owner (or {o['lower']})" if o else "owner"
    others = ", ".join(sorted(WAITING_VALUES - {"owner"}))
    raise util.SCError(f"waiting-on must be one of: {owner}, {others}")


def mark(rec: dict, waiting_on: str, text: str) -> dict:
    return events.append(rec["id"], "sc", "marked", text, waiting_on=waiting_value(waiting_on))


def _git(cwd: str, *args) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True)


def unlanded_work(cwd: str) -> list:
    """Reasons the session's working directory may hold work that is not safe to walk away from."""
    if _git(cwd, "rev-parse", "--is-inside-work-tree").returncode != 0:
        return []
    reasons = []
    st = _git(cwd, "status", "--porcelain")
    if st.stdout.strip():
        reasons.append(f"uncommitted changes in {cwd}")
    ahead = _git(cwd, "rev-list", "--count", "HEAD", "--not", "--remotes")
    if ahead.returncode == 0 and ahead.stdout.strip() not in ("", "0"):
        reasons.append(f"{ahead.stdout.strip()} commit(s) on the current branch that no remote has")
    return reasons


def cleanup(rec: dict, force: bool = False) -> None:
    if not force:
        owner = util.owner_name()
        reasons = unlanded_work(rec["cwd"])
        if reasons:
            raise util.SCError("refusing to clean up: " + "; ".join(reasons) +
                               f". These may be {owner}'s own changes. Check first, then use --force "
                               f"only if {owner} agreed.")
    rt = runtimes.get(rec["runtime"])
    if rt.status(rec)["alive"]:
        stop(rec)
    worktrees.release(rec["id"])
    dest = util.archive_dir() / rec["id"]
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(records.session_dir(rec["id"])), str(dest))
    events.forget(rec["id"])
