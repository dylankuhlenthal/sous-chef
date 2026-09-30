"""The watcher: a plain Python loop that uses no tokens and wakes sous chef only when needed.

Each cycle (every SC_WATCH_POLL seconds) it looks at every active session and:

1. Gone: the session has not been seen running for SC_GONE_GRACE seconds, sous
   chef did not stop it, and it was not finished. A single missed poll is normal
   (a session restarting drops out of the listing for a few seconds), so the first
   miss only starts the clock. A session waiting on the owner, sous chef or something
   external (AUTO_RESUME_WAITING) most likely stopped because Claude Code stops
   background sessions that sit idle, so the watcher resumes it itself, sends it a
   message saying why, and appends `auto-resumed`, which does not wake sous chef
   (`_auto_resume`, with limits against a session that keeps stopping). Otherwise,
   or when the resume fails or a limit is reached, it appends a `gone` event once
   until the session is seen running again.
2. Held at a prompt: the runtime has said for SC_PROMPT_GRACE seconds that the
   session is held mid-turn by something only a person can answer (for Claude, a
   permission prompt). Appends one `prompt-waiting` event per prompt, and a
   `prompt-answered` event when a prompt it reported goes away.
3. Silent stop: the session ended a turn more than SC_SILENT_GRACE seconds ago,
   is idle (see `_idle`), and its log still says it is waiting on the agent (it
   stopped without reporting why). Appends one `silent-stop` event per stopped turn.
   While the runtime says the session has subagents or background commands still
   running, it is waiting on them, not stopped: the event is held back, and the
   grace counts from the last time work was seen in flight (`_quiet_since`). After
   SC_INFLIGHT_MAX seconds since the turn ended, it is reported anyway.
4. Unread inbox: a message older than SC_INBOX_GRACE is still unhandled. Re-sends
   the wake-up to an idle session up to SC_INBOX_RINGS times, then appends one
   `inbox-unread` event.
5. Unread events: sous chef has not acknowledged an event that needs attention.
   Re-sends sous chef's wake-up, backing off (SC_WAKE_RETRY, doubling, max 1h).

Then, once per cycle, it runs the scheduled jobs (cron.tick), and wakes sous
chef for unread cron events, but only while sous chef is idle: a job's message
waits for the end of a busy turn rather than interrupting it.

Then, when Slack is set up (slack.py), it collects the owner's messages from the relay
(slack.poll) into the slack log and wakes sous chef in the same cycle, idle or
mid-turn, retrying with the usual back-off until they are acknowledged.

Last, when the data folder is a git repo with an upstream, it commits and pushes it
(sync.tick), and wakes sous chef if syncing stopped.

All wake-ups for sous chef in one cycle go out as a single message. Everything
the watcher finds is written to the session's event log first, so a failed
wake-up delays attention but never loses it.

The watcher runs whatever code it loaded when it started. So that a change to
sc reaches it, it restarts itself between cycles when its code on disk changes
(`_restart_if_code_changed`), and `ensure` restarts a running watcher whose code
it cannot vouch for, such as one started before this check existed.

Shortcut (PoC): the watcher is started by sous chef's SessionStart hook
(ensure) rather than by a system service, so it does not come back after
a reboot until sous chef starts again.
"""
import fcntl
import hashlib
import os
import signal
import subprocess
import sys
import time
import traceback

from . import chef, cron, events, inbox, ops, records, runtimes, slack, sync, util, wake


def _cfg(name, default):
    return float(os.environ.get(name, default))


def _state_path():
    return util.state_dir() / "watch.json"


def _lock_path():
    return util.state_dir() / "watch.lock"


def _code_path():
    """What the running watcher loaded: {"pid", "code", "poll", "started_at"}, written at its start."""
    return util.state_dir() / "watch.code"


def code_fingerprint() -> str:
    """A hash of the code a watcher runs: bin/sc and every module under lib/sc/.

    Kinds and templates are left out: they are read fresh each time they are used.
    """
    root = util.CODE_ROOT
    h = hashlib.sha1()
    for path in [root / "bin" / "sc", *sorted((root / "lib" / "sc").rglob("*.py"))]:
        h.update(str(path.relative_to(root)).encode() + b"\0")
        try:
            h.update(path.read_bytes())
        except OSError:
            h.update(b"(unreadable)")
    return h.hexdigest()[:12]


def cycle() -> dict:
    poll_now = util.now()
    silent_grace = _cfg("SC_SILENT_GRACE", 600)
    inbox_grace = _cfg("SC_INBOX_GRACE", 120)
    inbox_rings = int(_cfg("SC_INBOX_RINGS", 3))
    wake_retry = _cfg("SC_WAKE_RETRY", 120)
    gone_grace = _cfg("SC_GONE_GRACE", 60)
    stale_busy = _cfg("SC_STALE_BUSY", 300)
    prompt_grace = _cfg("SC_PROMPT_GRACE", 180)
    inflight_max = _cfg("SC_INFLIGHT_MAX", 7200)
    auto_resume_max = int(_cfg("SC_AUTO_RESUME_MAX", 24))
    auto_resume_min_up = _cfg("SC_AUTO_RESUME_MIN_UP", 600)

    wstate = util.read_json(_state_path(), {}) or {}
    listings = {}
    chef_needed = []
    actions = []

    for rec in records.all_records():
        sid = rec["id"]
        rt = runtimes.get(rec["runtime"])
        if rec["runtime"] not in listings:
            try:
                listings[rec["runtime"]] = rt.listing()
            except util.SCError as e:
                actions.append(f"listing failed for {rec['runtime']}: {e}")
                listings[rec["runtime"]] = None
        rows = listings[rec["runtime"]]
        if rows is None or not rec.get("handle"):
            continue
        st = rt.status(rec, rows)
        s = wstate.setdefault(sid, {})
        log = events.read_all(sid)
        waiting = events.waiting_on(log)

        # 1. gone, only once the session has stayed missing for the grace period; a session
        # waiting on someone else is resumed by the watcher itself, within limits
        if st["alive"]:
            s["gone_flagged"] = False
            s.pop("missing_since", None)
        else:
            missing_since = s.setdefault("missing_since", poll_now)
            if (poll_now - missing_since >= gone_grace and not rec.get("stopped_by_sc")
                    and waiting != "nobody" and not s.get("gone_flagged")):
                why_not = _auto_resume(rec, log, waiting, missing_since, poll_now, auto_resume_max, auto_resume_min_up)
                if why_not is None:
                    s.pop("missing_since", None)
                    st = rt.status(rec)
                    actions.append(f"{sid}: auto-resumed")
                else:
                    events.append(sid, "watcher", "gone",
                                  f"the session has not been running for {util.age(missing_since)}, and sous "
                                  f"chef did not stop it.{why_not} Check `sc status {sid}` first: if it is "
                                  f"back, nothing is needed. If not, resume it with `sc resume {sid}` (which "
                                  f"refuses a session that is running) or clean it up.")
                    s["gone_flagged"] = True
                    chef_needed.append(sid)
                    actions.append(f"{sid}: gone")

        # 2. held at a prompt, once the same prompt has stayed open for the grace period
        if _check_prompt(rec, st, s, log, waiting, poll_now, prompt_grace, rt):
            chef_needed.append(sid)
            actions.append(f"{sid}: prompt-waiting")

        # 3. silent stop, held back while the session's own subagents or commands run
        turns = records.turns(sid)
        idle = _idle(st, turns, poll_now, stale_busy)
        last_stop, last_prompt = turns.get("last_stop_at"), turns.get("last_prompt_at")
        in_flight = _in_flight(st)
        if in_flight:
            s["in_flight_seen_at"] = poll_now
        quiet_since = _quiet_since(last_stop, in_flight, s.get("in_flight_seen_at"), poll_now, inflight_max)
        if (idle and last_stop and quiet_since is not None
                and (not last_prompt or last_stop >= last_prompt)
                and poll_now - quiet_since >= silent_grace
                and waiting == "agent"
                and s.get("silent_flagged_stop") != last_stop):
            still = (f" It still has {in_flight} subagent(s) or background command(s) running, but they have "
                     f"held this report back as long as they may, so one of them may be stuck." if in_flight else "")
            events.append(sid, "watcher", "silent-stop",
                          f"the session ended a turn {util.age(last_stop)} ago without reporting why.{still} "
                          f"Check it with `sc status {sid}` or `claude logs`.")
            s["silent_flagged_stop"] = last_stop
            chef_needed.append(sid)
            actions.append(f"{sid}: silent-stop")

        # 4. unread inbox
        rings = s.setdefault("rings", {})
        escalated = set(s.get("inbox_escalated", []))
        for msg in inbox.unhandled(sid):
            key = str(msg["seq"])
            if poll_now - msg["ts"] < inbox_grace or key in escalated:
                continue
            if not st["alive"]:
                if rec.get("stopped_by_sc"):
                    continue
                reason = "the session is not running"
            elif not idle:
                continue  # busy, or nobody can tell: leave it alone
            else:
                r = rings.setdefault(key, {"count": 0, "last": 0})
                if r["count"] < inbox_rings:
                    if poll_now - r["last"] >= inbox_grace:
                        try:
                            rt.wake(rec, f"sous chef: message {msg['seq']} is still waiting in your inbox. "
                                         f"Run `sc inbox`, act on it, then `sc inbox ack {msg['seq']}`.", rows)
                            actions.append(f"{sid}: re-rang message {key}")
                        except wake.WakeError as e:
                            actions.append(f"{sid}: re-ring failed: {e}")
                        r["count"] += 1
                        r["last"] = poll_now
                    continue
                reason = f"it was not acknowledged after {inbox_rings} wake-ups"
            events.append(sid, "watcher", "inbox-unread", f"inbox message {msg['seq']} is unhandled: {reason}.")
            escalated.add(key)
            chef_needed.append(sid)
            actions.append(f"{sid}: inbox-unread {key}")
        s["inbox_escalated"] = sorted(escalated)

        # 5. unread events sous chef has not acknowledged
        if sid not in chef_needed and _rewake_due(sid, s, poll_now, wake_retry, woken_at_write=True):
            chef_needed.append(sid)
            actions.append(f"{sid}: re-woke sous chef for unread events")

    # 6. scheduled jobs, then the cron log's unread events, delivered only while sous chef is idle
    try:
        actions += cron.tick()["actions"]
    except Exception:  # noqa: BLE001 - a broken job must not stop the session checks
        actions.append("cron failed:\n" + traceback.format_exc())
    cs = wstate.setdefault(events.CRON_LOG, {})
    cron_wake = False
    if events.unread(events.CRON_LOG) and chef.status()["busy"] is False:
        cron_wake = _rewake_due(events.CRON_LOG, cs, poll_now, wake_retry, woken_at_write=False)
        if cron_wake:
            actions.append("cron: woke sous chef for unread cron events")

    # 8. Slack: collect from the relay, then wake sous chef at once, idle or mid-turn. Claude
    # Code holds a wake-up for a busy session until its next step, so nothing is interrupted.
    # The first wake goes out in the cycle that wrote the messages; retries back off as for
    # a session's report (woken_at_write), until the slack log is acknowledged.
    slack_new = 0
    try:
        polled = slack.poll()
        actions += polled["actions"]
        slack_new = polled["written"]
    except Exception:  # noqa: BLE001 - Slack must never stop the other checks
        actions.append("slack failed:\n" + traceback.format_exc())
    ss = wstate.setdefault(events.SLACK_LOG, {})
    slack_wake = _rewake_due(events.SLACK_LOG, ss, poll_now, wake_retry, woken_at_write=True) or slack_new > 0
    if slack_wake and not slack_new:
        actions.append("slack: re-woke sous chef for unread Slack messages")

    # 9. Keep the data folder committed and pushed, when it is a git repo with an upstream.
    # Stopping (a conflict, or pushes failing) wakes sous chef at once, then backs off.
    try:
        actions += sync.tick()["actions"]
    except Exception:  # noqa: BLE001 - syncing must never stop the other checks
        actions.append("sync failed:\n" + traceback.format_exc())
    sync_wake = _rewake_due(events.SYNC_LOG, wstate.setdefault(events.SYNC_LOG, {}), poll_now, wake_retry,
                            woken_at_write=False)

    # Forget watcher state for sessions that were cleaned up.
    active = set(records.all_ids()) | {events.CRON_LOG, events.SLACK_LOG, events.SYNC_LOG}
    wstate = {k: v for k, v in wstate.items() if k in active}

    if chef_needed or cron_wake or slack_wake or sync_wake:
        parts = []
        if chef_needed:
            parts.append(f"sessions need attention ({', '.join(dict.fromkeys(chef_needed))})")
        if cron_wake:
            parts.append("scheduled jobs are waiting for you")
        if slack_wake:
            parts.append(f"{slack_new} new Slack message(s)" if slack_new else "Slack messages are waiting for you")
        if sync_wake:
            parts.append("syncing your data folder stopped")
        ok = chef.wake_chef(f"sous chef watcher: {'; '.join(parts)}. Run `sc events`.")
        actions.append(f"woke sous chef: {ok}")
    util.write_json(_state_path(), wstate)
    return {"actions": actions}


# Who a session may be waiting on for the watcher to resume it after it stopped by
# itself: someone other than the session, so it was idle and its work is unfinished.
# `agent` is left out: that session was working (or stopped silently within the last
# SC_SILENT_GRACE), so its stopping is unexplained and sous chef should look.
AUTO_RESUME_WAITING = ("owner", "sc", "external")


def _auto_resume(rec: dict, log: list, waiting: str, missing_since: float, poll_now: float,
                 max_per_day: int, min_up: float):
    """Check 1: resume a session that stopped while waiting on someone else.

    Returns None when it was resumed. Otherwise returns the reason it was not, as a
    sentence (with a leading space) for the `gone` event, or "" when this session is
    not one the watcher resumes. The limits guard against a session that keeps
    stopping: at most `max_per_day` automatic resumes in any 24 hours, and none when
    the session stopped within `min_up` seconds of the last one. Both are counted from
    the session's own `auto-resumed` events, so nothing else has to agree with the log.
    """
    sid = rec["id"]
    if waiting not in AUTO_RESUME_WAITING or max_per_day <= 0:
        return ""
    shown = events.show_waiting(waiting)
    recent = [e for e in log if e["state"] == "auto-resumed" and poll_now - e["ts"] < 86400]
    if len(recent) >= max_per_day:
        return (f" The watcher did not resume it: it has already done so {len(recent)} times in the last 24 "
                f"hours, the most it may (SC_AUTO_RESUME_MAX).")
    if recent and missing_since - recent[-1]["ts"] < min_up:
        return (f" The watcher did not resume it: it stopped again within {int(min_up // 60)} minutes of the "
                f"watcher resuming it (event {recent[-1]['seq']}), so something may be stopping it on purpose "
                f"or it fails as it starts.")
    try:
        event = ops.resume(
            rec, author="watcher", state="auto-resumed",
            text=f"the session stopped by itself about {util.age(missing_since)} ago while waiting on {shown}, "
                 f"most likely because Claude Code stops a background session that has been idle for about an "
                 f"hour. The watcher resumed it with its conversation (automatic resume {len(recent) + 1} of at "
                 f"most {max_per_day} in 24 hours) and sent it a message to restart anything tied to its old "
                 f"process. Nothing to do.")
    except Exception as e:  # noqa: BLE001 - a failed resume is reported as `gone`, never stops the cycle
        return f" The watcher tried to resume it and failed: {e}."
    ops.send(rec, (
        f"You were resumed by sous chef's watcher (event {event['seq']}): this session stopped by itself while it "
        f"was idle, most likely because Claude Code stops background sessions that stay idle for about an hour. "
        f"Your conversation is intact, but anything tied to your old process has ended: a local server, a "
        f"background command, a monitor. Restart what you still need; for example a local page server "
        f"must be restarted, because it targets your old process. Then carry on as before. Sous chef still has "
        f"you as waiting on {shown}, so do not report again unless your situation changed."), sender="watcher")
    return None


def _check_prompt(rec: dict, st: dict, s: dict, log: list, waiting: str, poll_now: float,
                  grace: float, rt) -> bool:
    """Check 2: report a session held at a prompt. Returns True when it appended `prompt-waiting`.

    `s["prompt"]` tracks the prompt open now: {"text", "since", "flagged_seq", "before"}.
    A prompt with different text is a new prompt and starts the clock again. When a
    reported prompt goes away while the session runs, `prompt-answered` is appended.
    It gives back the "waiting on" from before the prompt, unless something was
    recorded since, so that a later silent stop is still noticed.
    """
    sid = rec["id"]
    prompt = st.get("prompt") if st["alive"] else None
    held = s.get("prompt")
    if held and held.get("text") != prompt:
        if held.get("flagged_seq") and st["alive"]:
            latest = log[-1]["seq"] if log else None
            restore = held["before"] if latest == held["flagged_seq"] else None
            events.append(sid, "watcher", "prompt-answered",
                          f"the prompt reported in event {held['flagged_seq']} is no longer open "
                          f"({held['text']}). Nothing to do.", waiting_on=restore)
        s.pop("prompt", None)
        held = None
    if not prompt:
        return False
    if not held:
        s["prompt"] = {"text": prompt, "since": poll_now, "flagged_seq": None, "before": None}
        held = s["prompt"]
    if held["flagged_seq"] or poll_now - held["since"] < grace:
        return False
    owner = util.owner_name()
    event = events.append(
        sid, "watcher", "prompt-waiting",
        f"the session has been held for {util.age(held['since'])} by a prompt only a person can answer: "
        f"{prompt}. It cannot continue until someone answers it in the session. Tell {owner} which session "
        f"it is and what it asks; {owner} answers it with `{rt.attach_command(rec)}`. A message sent with "
        f"`sc send` does not answer it: it waits behind the prompt.")
    held["flagged_seq"] = event["seq"]
    held["before"] = waiting
    return True


def _in_flight(st: dict) -> int:
    """How many subagents or background commands the runtime says a running session has going; 0 when it cannot tell."""
    activity = st.get("activity") if st["alive"] else None
    n = activity.get("in_flight") if isinstance(activity, dict) else None
    return n if isinstance(n, int) and not isinstance(n, bool) and n > 0 else 0


def _quiet_since(last_stop, in_flight: int, seen_at, poll_now: float, inflight_max: float):
    """When check 3's grace starts counting, or None while work in flight holds the silent stop back.

    A session that ended its turn to wait for its own subagents is not stopped. So
    while work is in flight nothing is reported, and once it ends the grace counts
    from the last poll that saw it, giving the session time to be woken by the
    result. Once SC_INFLIGHT_MAX has passed since the turn ended, work in flight is
    ignored and the grace counts from the stop, so a subagent that never finishes
    cannot hide the stop for ever. With no activity from the runtime (the job file
    missing or changed), `in_flight` is 0, `seen_at` is None, and this is the stop time.
    """
    if not last_stop:
        return last_stop
    if poll_now - last_stop >= inflight_max:
        return last_stop
    if in_flight:
        return None
    return max(last_stop, seen_at or 0)


def _idle(st: dict, turns: dict, poll_now: float, stale_busy: float) -> bool:
    """Whether a running session is between turns, from the runtime and from sc's own turn record.

    The runtime's word (`claude agents` status) is taken when it says idle. It has
    also been seen reporting `busy` for a session whose last turn had ended 15
    minutes before, with no prompt since. So when sc's turn record (the session's
    Stop and UserPromptSubmit hooks) shows the last turn ended at least
    `stale_busy` seconds ago and nothing started since, the session counts as idle
    whatever the runtime says. Every turn start seen so far fires the prompt hook,
    including a session woken by its own background command finishing.

    With neither (the runtime cannot tell and no turn has ended), it is not idle:
    an unknown state never counts as idle.
    """
    if not st["alive"]:
        return False
    if st["busy"] is False:
        return True
    last_stop, last_prompt = turns.get("last_stop_at"), turns.get("last_prompt_at")
    return bool(last_stop and (not last_prompt or last_stop >= last_prompt)
                and poll_now - last_stop >= stale_busy)


def _rewake_due(log_id: str, s: dict, poll_now: float, wake_retry: float, woken_at_write: bool) -> bool:
    """Whether to wake sous chef for this log's unread events now, backing off each time.

    `woken_at_write` says whether whoever wrote the events already woke sous chef
    (a session's report did; a cron firing did not), which decides whether the first
    wake waits for the retry delay. `s` is this log's watcher bookkeeping, updated in place.
    """
    pending = [e for e in events.unread(log_id, events.read_all(log_id)) if e["state"] in events.WAKE_STATES]
    if not pending:
        return False
    top = pending[-1]["seq"]
    cw = s.get("chef_wake") or {}
    if cw.get("seq") != top:
        cw = {"seq": top, "count": 0, "last": pending[0]["ts"] if woken_at_write else None}
    if cw["last"] is None:
        s["chef_wake"] = {**cw, "last": poll_now}  # retried after SC_WAKE_RETRY, as for a report
        return True
    s["chef_wake"] = cw
    backoff = min(3600, wake_retry * (2 ** cw["count"]))
    if poll_now - cw["last"] < backoff:
        return False
    cw["count"] += 1
    cw["last"] = poll_now
    return True


def _log(msg: str) -> None:
    with open(util.state_dir() / "watch.log", "a") as f:
        f.write(f"{util.iso(time.time())} {msg}\n")


def run_forever() -> int:
    util.state_dir().mkdir(parents=True, exist_ok=True)
    lock = open(_lock_path(), "a")
    # `is_running` checks by taking the lock for an instant, so a watcher starting at
    # that moment would think another one runs. Retrying briefly covers that; a real
    # watcher holds the lock for good.
    if not _wait(lambda: _try_lock(lock), 2):
        print("sc watch: another watcher is already running")
        return 0
    log_path = util.state_dir() / "watch.log"
    if log_path.exists() and log_path.stat().st_size > 1_000_000:
        log_path.unlink()
    (util.state_dir() / "watch.pid").write_text(str(os.getpid()))
    poll = _cfg("SC_WATCH_POLL", 15)
    loaded = code_fingerprint()
    util.write_json(_code_path(), {"pid": os.getpid(), "code": loaded, "poll": poll, "started_at": time.time()})
    _log(f"watcher started (pid {os.getpid()}, code {loaded})")
    signal.signal(signal.SIGTERM, _on_term)
    refused = None
    while True:
        _loop["in_cycle"] = True
        try:
            result = cycle()
            for a in result["actions"]:
                _log(a)
        except Exception:  # noqa: BLE001 - keep watching; the log shows what broke
            _log("cycle failed:\n" + traceback.format_exc())
        (util.state_dir() / "watch.beat").write_text(str(time.time()))
        _loop["in_cycle"] = False
        if _loop["stop"]:
            _log("watcher stopped between cycles (SIGTERM)")
            return 0
        refused = _restart_if_code_changed(loaded, refused)
        time.sleep(poll)


def _try_lock(f) -> bool:
    try:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except BlockingIOError:
        return False


# A SIGTERM (sent by `ensure` to replace this watcher) ends the loop between cycles,
# never inside one, so a cycle's events and its watch.json are always written together.
_loop = {"in_cycle": False, "stop": False}


def _on_term(_signum, _frame):
    _loop["stop"] = True
    if not _loop["in_cycle"]:
        _log("watcher stopped between cycles (SIGTERM)")
        raise SystemExit(0)


def _restart_if_code_changed(loaded: str, refused):
    """Between cycles: replace this process with the code now on disk, if it changed and loads.

    The state of the finished cycle is already written. The lock file is closed on
    exec, so the new code takes the lock as any starting watcher does; if another
    watcher got it first, the new code exits and that one carries on. Code that does
    not load (for example a file half written) is refused and logged once, and this
    watcher keeps running what it has. Returns the fingerprint refused, if any.
    """
    now_code = code_fingerprint()
    if now_code == loaded or now_code == refused:
        return refused
    check = subprocess.run([sys.executable, str(util.sc_bin()), "--help"], capture_output=True, text=True,
                           timeout=60, stdin=subprocess.DEVNULL)
    if check.returncode != 0:
        _log(f"the code changed ({loaded} -> {now_code}) but the new code does not load, so this watcher "
             f"keeps running {loaded}:\n{check.stderr.strip()[-1500:]}")
        return now_code
    _log(f"the code changed ({loaded} -> {now_code}); restarting on the new code")
    os.execv(sys.executable, [sys.executable, str(util.sc_bin()), "watch"])


def is_running() -> bool:
    util.state_dir().mkdir(parents=True, exist_ok=True)
    with open(_lock_path(), "a") as f:
        try:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        fcntl.flock(f.fileno(), fcntl.LOCK_UN)
        return False


def health() -> dict:
    """Whether a watcher is running, and whether it runs the code on disk.

    {"running": bool, "current": bool, "problem": text or None}. `current` is False
    for a watcher started before the code changed, and for one that predates
    watch.code (it records nothing about its code, so it cannot be vouched for).
    """
    if not is_running():
        return {"running": False, "current": False,
                "problem": "the watcher is not running, so nothing fires and nobody is re-woken "
                           "(`sc watch --ensure` starts it)"}
    info = util.read_json(_code_path(), {}) or {}
    pid = _pid()
    if not info.get("code") or info.get("pid") != pid:
        return {"running": True, "current": False,
                "problem": "the watcher running now was started by older code that does not record what it "
                           "runs, so it may be missing changes such as scheduled jobs "
                           "(`sc watch --ensure` restarts it)"}
    if info["code"] != code_fingerprint():
        return {"running": True, "current": False,
                "problem": f"the watcher is running code older than what is on disk (started "
                           f"{util.age(info.get('started_at') or 0)} ago); it restarts itself after its "
                           f"current cycle, or `sc watch --ensure` restarts it"}
    return {"running": True, "current": True, "problem": None}


def _pid():
    try:
        return int((util.state_dir() / "watch.pid").read_text().strip())
    except (OSError, ValueError):
        return None


def _beat():
    try:
        return (util.state_dir() / "watch.beat").read_text()
    except OSError:
        return None


def _wait(condition, seconds: float) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        if condition():
            return True
        time.sleep(0.1)
    return condition()


def ensure() -> dict:
    """Make sure a watcher runs the code on disk: start one, or replace one running older code.

    Returns {"running": bool, "note": text or None}; the note says what was done or
    what is wrong, for `sc watch --ensure` and the startup summary.

    Replacing is careful not to lose state or double up. A watcher that checks its
    own code gets one cycle to restart itself. Otherwise the old watcher is sent
    SIGTERM just after it finishes a cycle (its heartbeat changes), when it is
    asleep with everything written; a watcher from before this change has no
    handler for SIGTERM and dies there, one after it finishes its cycle first. Only
    once its lock is free is a new one started, and the lock guarantees one watcher
    even if two `ensure`s race. Nothing is ever killed outright: if the old watcher
    does not finish a cycle or let go of the lock in time, it is left running and
    the note says so.
    """
    if os.environ.get("SC_WATCH_DISABLE_ENSURE"):  # tests: never start a real watcher
        return {"running": True, "note": None}
    if not is_running():
        return {"running": _start(), "note": None}
    h = health()
    if h["current"]:
        return {"running": True, "note": None}
    info = util.read_json(_code_path(), {}) or {}
    poll = float(info.get("poll") or 15)
    window = poll + 10
    # All waiting before the SIGTERM fits in 30s, and after it in 10s, so that with
    # starting the new watcher this stays inside the SessionStart hook's 60s timeout.
    deadline = time.time() + 30
    if info.get("code") and info.get("pid") == _pid():
        if _wait(lambda: health()["current"], min(window, deadline - time.time())):
            return {"running": True, "note": "the watcher was running older code and restarted itself on the new code"}
    pid = _pid()
    if not pid:
        return {"running": True, "note": f"{h['problem']}; it could not be replaced because state/watch.pid is missing"}
    beat = _beat()
    if not _wait(lambda: _beat() != beat, max(0.0, min(window, deadline - time.time()))):
        return {"running": True, "note": f"{h['problem']}. It was not replaced: it did not finish a cycle in "
                                         f"time, and it is only stopped between cycles. Run "
                                         f"`sc watch --ensure` again, and check state/watch.log"}
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    if not _wait(lambda: not is_running(), 10):
        return {"running": True, "note": f"{h['problem']}. It was asked to stop (pid {pid}) but still holds the "
                                         f"lock after 10s, so no second watcher was started"}
    _log(f"replaced watcher pid {pid}, which was running older code")
    ok = _start()
    return {"running": ok, "note": ("the watcher was running older code, so it was restarted" if ok else
                                    "the watcher was running older code and was stopped, but the new one "
                                    "failed to start; see state/watch.log")}


def ensure_running() -> bool:
    return ensure()["running"]


def _start() -> bool:
    util.state_dir().mkdir(parents=True, exist_ok=True)
    with open(util.state_dir() / "watch.log", "a") as out:
        subprocess.Popen([sys.executable, str(util.sc_bin()), "watch"], stdout=out, stderr=out,
                         stdin=subprocess.DEVNULL, start_new_session=True, env={**os.environ})
    # Running once it has recorded its code (which it does after taking the lock), so
    # that `health` is right straight away.
    return _wait(lambda: (util.read_json(_code_path(), {}) or {}).get("pid") == _pid() and is_running(), 5)
