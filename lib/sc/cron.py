"""Scheduled jobs (cron), fired by the watcher while sous chef is running.

A job's definition is configuration: cron/<name>.md in the owner's data folder
(my/cron/), kept and synced with it like memory. Front matter, then the task:

  ---
  at: 09:00, 16:00          (or: every: 6h)
  target: chef              (chef, or worker for a spawned session)
  kind: general             (worker only, and cwd, title, model, effort, thread)
  cwd: ~/some/folder
  memory: memory/email.md   (either target: the memory file holding the job's context;
                             `sc events` prints its `## Slack me` section under the job's events)
  ---
  <the task text>

What happened when it ran is runtime state: state/cron/runs.json, written only
here. The definition is kept apart from it so a synced definition never carries
one machine's run history to another, and so `state/` stays sc's alone.

Firing a job sends its task to the target as a message, the way messages already
travel: written to disk first, then the target is woken if it is idle, or left to
pick the message up when its current turn ends (see `fire`). A job has no setting
for this; it depends only on what the target is doing when the job fires.

Rules (docs/domains/cron.md explains why):
- Nothing fires while the registered sous chef session is not running.
- Every firing is delivered, even when an earlier one is still unread.
- Missed firings fire once, not once per miss.
- A new job, or one this machine has no run record for, waits for its next slot.
"""
import re
import time

from . import chef, events, kinds, ops, records, runtimes, util

TARGETS = ("chef", "worker")
WORKER_FIELDS = ("kind", "cwd", "title", "model", "effort", "thread")
NAME = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
TIME = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")
EVERY = re.compile(r"^(\d+)([mhd])$")
UNIT = {"m": 60, "h": 3600, "d": 86400}
MEMORY_FILE = re.compile(r"^memory/([A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+\.md$")


def jobs_dir():
    return util.home() / "cron"


def _runs_path():
    return util.state_dir() / "cron" / "runs.json"


def _runs_lock():
    return util.state_dir() / "cron" / ".runs.lock"


def runs() -> dict:
    return util.read_json(_runs_path(), {}) or {}


# --- definitions -------------------------------------------------------------

def parse_at(text: str) -> list:
    times = [t.strip() for t in text.split(",") if t.strip()]
    if not times:
        raise util.SCError("`at` needs one or more times, e.g. 09:00, 16:00")
    out = []
    for t in times:
        m = TIME.match(t)
        if not m:
            raise util.SCError(f"'{t}' is not a time of day; use 24-hour HH:MM, e.g. 09:00")
        out.append(f"{int(m.group(1)):02d}:{m.group(2)}")
    return sorted(set(out))


def parse_every(text: str) -> int:
    m = EVERY.match(text.strip())
    if not m or int(m.group(1)) == 0:
        raise util.SCError(f"'{text}' is not an interval; use a number with m, h or d, e.g. 30m, 6h, 1d")
    return int(m.group(1)) * UNIT[m.group(2)]


def validate(job: dict) -> dict:
    """Check a definition and fill in what firing needs. Raises SCError naming the problem."""
    name = job.get("name", "")
    if not NAME.match(name):
        raise util.SCError(f"job name '{name}' must be lowercase kebab-case, e.g. email-check")
    if bool(job.get("at")) == bool(job.get("every")):
        raise util.SCError(f"job {name}: give exactly one schedule, `at` (times of day) or `every` (an interval)")
    job["at_times"] = parse_at(job["at"]) if job.get("at") else None
    job["every_secs"] = parse_every(job["every"]) if job.get("every") else None
    if job.get("target") not in TARGETS:
        raise util.SCError(f"job {name}: target must be chef or worker")
    if not (job.get("task") or "").strip():
        raise util.SCError(f"job {name}: the task text is empty")
    if job.get("memory") and (not MEMORY_FILE.match(job["memory"])
                              or any(part in (".", "..") for part in job["memory"].split("/"))):
        raise util.SCError(f"job {name}: memory must name a file under memory/, e.g. memory/{name}.md")
    if job["target"] == "chef":
        extra = [f for f in WORKER_FIELDS + ("runtime",) if job.get(f)]
        if extra:
            raise util.SCError(f"job {name}: {', '.join(extra)} only apply to a worker job; "
                               f"a chef job is done by sous chef itself")
    else:
        if not job.get("kind") or not job.get("cwd"):
            raise util.SCError(f"job {name}: a worker job needs a kind and a cwd, as `sc spawn` does")
        kinds.load(job["kind"])
        ops.check_cwd(job["cwd"])
    return job


def schedule_text(job: dict) -> str:
    return f"at {', '.join(job['at_times'])}" if job.get("at_times") else f"every {job['every']}"


def _path(name: str):
    return jobs_dir() / f"{name}.md"


def load(name: str) -> dict:
    path = _path(name)
    if not path.is_file():
        raise util.SCError(f"no cron job '{name}' (see: sc cron list)")
    meta, body = kinds.parse(path.read_text())
    return validate({**meta, "name": name, "task": body})


def names() -> list:
    return sorted(p.stem for p in jobs_dir().glob("*.md")) if jobs_dir().is_dir() else []


def all_jobs() -> tuple:
    """(valid jobs, {name: problem}) for every definition file."""
    jobs, broken = [], {}
    for name in names():
        try:
            jobs.append(load(name))
        except util.SCError as e:
            broken[name] = str(e)
    return jobs, broken


def add(job: dict) -> dict:
    job = validate(dict(job))
    if job["target"] == "worker":
        # Checked here, not in validate, so listing and firing jobs never depend on skills.
        # At fire time a missing skill is refused by ops.spawn and shows as a `failed` cron event.
        ops.check_skill(kinds.load(job["kind"]), runtimes.get(job.get("runtime") or runtimes.DEFAULT),
                        ops.check_cwd(job["cwd"]))
    if _path(job["name"]).exists():
        raise util.SCError(f"a cron job named {job['name']} already exists; `sc cron remove` it first")
    fields = ["at", "every", "target", *WORKER_FIELDS, "memory", "runtime"]
    head = "".join(f"{f}: {job[f]}\n" for f in fields if job.get(f))
    _path(job["name"]).parent.mkdir(parents=True, exist_ok=True)
    _path(job["name"]).write_text(f"---\n{head}---\n{job['task'].strip()}\n")
    with util.locked(_runs_lock()):
        data = runs()
        data[job["name"]] = {"since": util.now()}
        util.write_json(_runs_path(), data)
    return job


def remove(name: str) -> None:
    path = _path(name)
    if not path.is_file():
        raise util.SCError(f"no cron job '{name}' (see: sc cron list)")
    path.unlink()
    with util.locked(_runs_lock()):
        data = runs()
        if data.pop(name, None) is not None:
            util.write_json(_runs_path(), data)


# --- schedule ----------------------------------------------------------------

def _slots_around(job: dict, now: float) -> list:
    """Times of day as epoch seconds, local time, from yesterday to tomorrow."""
    out = []
    for day in (-1, 0, 1):
        d = time.localtime(now + day * 86400)
        for t in job["at_times"]:
            hh, mm = map(int, t.split(":"))
            out.append(time.mktime((d.tm_year, d.tm_mon, d.tm_mday, hh, mm, 0, 0, 0, -1)))
    return sorted(out)


def latest_slot(job: dict, run: dict, now: float):
    """The most recent moment the job was due, at or before now; None if never."""
    if job.get("at_times"):
        past = [s for s in _slots_around(job, now) if s <= now]
        return past[-1] if past else None
    base = run.get("last_due") or run.get("since") or now
    return base + job["every_secs"] if now >= base + job["every_secs"] else None


def next_slot(job: dict, run: dict, now: float) -> float:
    if job.get("at_times"):
        return next(s for s in _slots_around(job, now) if s > now)
    base = run.get("last_due") or run.get("since") or now
    return max(base + job["every_secs"], now)


def is_due(job: dict, run: dict, now: float) -> bool:
    """Due when a slot has passed since the last one handled (or since this machine first saw the job).

    Only the latest slot is compared, so any number of missed slots makes the job
    due once, not once per miss.
    """
    slot = latest_slot(job, run, now)
    return slot is not None and slot > (run.get("last_due") or run.get("since") or now)


# --- firing ------------------------------------------------------------------

def _message(job: dict) -> str:
    return f"cron job {job['name']}: {job['task'].strip()}"


def _worker_task(job: dict) -> str:
    note = (util.templates_dir() / "cron-worker.md").read_text()
    note = util.render(note, {"job": job["name"], "owner": util.require_owner()["name"]})
    return f"{job['task'].strip()}\n\n{note.strip()}"


def _in_flight(run: dict):
    """The job's previous session, if it is still running and has not finished."""
    sid = run.get("session")
    if not sid or sid not in records.all_ids():
        return None
    rec = records.load(sid)
    if events.waiting_on(events.read_all(sid)) == "nobody":
        return None
    return rec if runtimes.get(rec["runtime"]).status(rec)["alive"] else None


def fire(job: dict, run: dict) -> str:
    """Deliver one firing of a job and say what happened. Updates `run` in place.

    The job's message goes to its target the way any message does: written to disk,
    and the target woken if it is idle or left to pick it up when its turn ends.
    - chef: a `due` event in the cron log; the watcher wakes sous chef once it is idle.
    - worker, previous run still in flight: the message goes to that session's inbox.
    - worker, otherwise: a new session is launched with the task as its brief.
    Every firing is delivered, even when an earlier one is still unread, so messages
    can stack up; each is visible and none is lost.
    """
    now = util.now()
    name = job["name"]
    if job["target"] == "chef":
        e = events.append(events.CRON_LOG, "cron", "due", _message(job), extra={"job": name})
        run.update(last_fired=now, session=None, last_result=f"wrote due as cron event #{e['seq']} for sous chef")
        return run["last_result"]
    rec = _in_flight(run)
    if rec:
        msg, problem = ops.send(rec, _message(job) + "\n\nThis is the next scheduled run of the job you were "
                                "launched for. Finish what you are doing first.",
                                sender=f"cron job {name}", only_if_idle=True)
        where = f"inbox message {msg['seq']} for {rec['id']}, which is still on an earlier run"
        run.update(last_fired=now, last_result=(f"wrote {where}; it was not woken: {problem}" if problem
                                                else f"wrote {where}, and woke it"))
        return run["last_result"]
    try:
        rec = ops.spawn(job["kind"], job.get("title") or name, job["cwd"], _worker_task(job),
                        thread=job.get("thread"), model=job.get("model"), effort=job.get("effort"),
                        runtime=job.get("runtime"), cron={"job": name})
    except util.SCError as e:
        f = events.append(events.CRON_LOG, "cron", "failed", f"cron job {name} could not launch its session: {e}",
                          extra={"job": name})
        run.update(last_fired=now, session=None,
                   last_result=f"could not launch a session ({e}); wrote failed as cron event #{f['seq']} for sous chef")
        return run["last_result"]
    run.update(last_fired=now, session=rec["id"],
               last_result=f"launched {rec['id']}, which starts on the task now "
                           f"(attach: {runtimes.get(rec['runtime']).attach_command(rec)})")
    return run["last_result"]


def run_now(name: str) -> str:
    """`sc cron run`: fire a job now, outside its schedule, and say what happened.

    Its next scheduled slot is unchanged. Unlike the watcher, it fires even when sous
    chef is not running, because someone asked for it by hand.
    """
    job = load(name)
    with util.locked(_runs_lock()):
        data = runs()
        run = data.setdefault(name, {"since": util.now()})
        out = fire(job, run)
        util.write_json(_runs_path(), data)
    if "cron event #" in out:
        out += ".\n" + _chef_wake_note()
    return out


def _chef_wake_note() -> str:
    """Whether and when sous chef is woken for a cron event: the watcher does it, not `sc cron run`."""
    from . import watch  # imported here because watch imports this module
    if not watch.is_running():
        return ("Nobody was woken, and nobody will be: the watcher is not running (`sc watch --ensure`). "
                "Sous chef sees the event in `sc events` or at its next start.")
    st = chef.status()
    if not st["alive"]:
        return "Nobody was woken: sous chef is not running. It sees the event in `sc events` or at its next start."
    if st["busy"] is False:
        return "Sous chef was not woken by this command; it is idle, so the watcher wakes it within one cycle (15s)."
    return "Sous chef was not woken: it is mid-turn (or its state is unknown), so the watcher wakes it once it is idle."


def _archive_empty_workers(data: dict, actions: list) -> None:
    """Archive a job's session once it reported nothing-new, so empty runs leave nothing behind."""
    for name, run in data.items():
        sid = run.get("session")
        if not sid or sid not in records.all_ids() or run.get("archive_refused") == sid:
            continue
        last = events.last_session_event(events.read_all(sid))
        if not last or last["state"] != "nothing-new":
            continue
        try:
            ops.cleanup(records.load(sid))
            run["last_result"] = f"nothing new ({sid} archived)"
            actions.append(f"cron {name}: archived {sid}, which found nothing new")
        except util.SCError as e:
            run["archive_refused"] = sid  # left for sous chef; `sc cron list` shows it
            run["last_result"] = f"nothing new, but {sid} was not archived: {e}"
            actions.append(f"cron {name}: could not archive {sid}: {e}")


def tick() -> dict:
    """One watcher cycle's worth of cron: tidy empty runs, then fire what is due.

    Returns {"actions": [...]}. Waking sous chef for the cron log is the watcher's job.
    """
    actions = []
    jobs, broken = all_jobs()
    if not jobs and not broken and not _runs_path().exists():
        return {"actions": actions}  # cron was never used here
    with util.locked(_runs_lock()):
        data = runs()
        now = util.now()
        for name in list(data):
            if name not in {j["name"] for j in jobs} and name not in broken:
                data.pop(name)  # the definition was removed or renamed by hand
        _archive_empty_workers(data, actions)
        for job in jobs:
            if job["name"] not in data:
                data[job["name"]] = {"since": now}  # first seen on this machine: wait for the next slot
        due = [j for j in jobs if is_due(j, data[j["name"]], now)]
        if due and not chef.live_incumbent():
            # The owner's rule: jobs run only while sous chef does. Nothing is marked handled,
            # so each of these fires once when sous chef is back. Said once, not every cycle.
            for job in due:
                if not data[job["name"]].get("held"):
                    data[job["name"]]["held"] = True
                    actions.append(f"cron {job['name']}: due, but sous chef is not running; it fires when it is")
            due = []
        for job in due:
            run = data[job["name"]]
            run["last_due"] = now
            run.pop("held", None)
            actions.append(f"cron {job['name']}: {fire(job, run)}")
        util.write_json(_runs_path(), data)
    return {"actions": actions}
