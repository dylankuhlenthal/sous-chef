"""The per-session event log, sous chef's read positions, and open questions.

Each session has state/sessions/<id>/events.jsonl. Every line is one event:
  {"seq": 3, "ts": 1789657159.1, "author": "session", "state": "needs-decision",
   "key": "db-choice", "text": "..."}

Authors:
  session  written by the session itself through `sc report`
  sc       written by sous chef's own commands (spawn, send --resolves, mark, stop)
  watcher  written by the watcher when something needs sous chef's attention
  cron     written when a scheduled job fires (cron.py), only in the cron log
  context  written by sous chef's Stop hook (context.py), only in the context log
  slack    written by the watcher for a message collected from the relay (slack.py),
           only in the slack log
  sync     written by the watcher when syncing the data folder stops or starts again
           (sync.py), only in the sync log

Besides one log per session there are four more, for sous chef itself, which has no
inbox of its own. Each is named wherever a session id would go, and is read and
acknowledged exactly like a session's log:
  the cron log, state/cron/events.jsonl (CRON_LOG): what scheduled jobs deliver to
    sous chef; the watcher wakes sous chef for these once it is idle;
  the context log, state/context/events.jsonl (CONTEXT_LOG): warnings that sous
    chef's context is filling (context.py); nothing wakes sous chef for these;
  the slack log, state/slack/events.jsonl (SLACK_LOG): messages from Slack (slack.py);
    the watcher wakes sous chef as soon as it writes one, idle or mid-turn;
  the sync log, state/sync/events.jsonl (SYNC_LOG): syncing the data folder stopped
    (`sync-stopped`, which wakes sous chef) or started again (`sync-resumed`, which does not).

The log is append-only. What a session is doing *now* is derived from it
(waiting_on, open_questions), never stored separately.
"""
import json
import re

from . import records, util

SESSION_STATES = {
    "working": "a material phase started; not a progress ping",
    "needs-decision": "sous chef must decide (or ask the owner) before work continues",
    "blocked": "cannot continue without something from sous chef or the owner",
    "waiting": "waiting for the owner to reply inside this session's own terminal",
    "paused": "waiting on something outside (CI, a deploy, another person)",
    "done": "the task is finished; text says what came out of it",
    "failed": "the task cannot be finished; text says why",
    "resolved": "closes an earlier needs-decision or blocked with the same key",
    "note": "information sous chef should read, needing no action",
    "nothing-new": "(sessions launched by a scheduled job only) the job ran and found nothing worth reporting",
}

# States that mean sous chef should look soon. Reporting one wakes sous chef;
# the watcher retries the wake-up for these if sous chef has not read them.
# `resolved` is here because a session reports it when the owner answered a question
# inside the session: sous chef would otherwise never learn the question closed.
# `due` is a scheduled job for sous chef itself (cron.py). The watcher wakes sous chef
# for it only once sous chef is idle, so a firing never interrupts a turn.
# `prompt-waiting` (watcher) is a session held at a prompt only a person can answer;
# its `prompt-answered` follow-up needs no action, so it does not wake. Nor does
# `auto-resumed` (watcher): the watcher resumed a session that stopped while idle,
# and only a failed resume, reported as `gone`, needs sous chef.
# The four Slack labels (slack.py) are messages from Slack, in the slack log only.
# `sync-stopped` (sync.py) means the data folder is no longer being pushed.
SLACK_STATES = {"message", "reply", "mention", "thread-reply"}
WAKE_STATES = {"needs-decision", "blocked", "waiting", "paused", "done", "failed", "resolved",
               "silent-stop", "gone", "inbox-unread", "prompt-waiting", "due", "sync-stopped"} | SLACK_STATES

# Who the session is waiting on after an event with this state. States not
# listed here leave the previous value unchanged. `owner` is the person sous chef
# works for (util.owner); it is shown as their name in lower case (show_waiting).
WAITING_ON = {
    "working": "agent",
    "needs-decision": "sc",
    "blocked": "sc",
    "waiting": "owner",
    "paused": "external",
    "done": "nobody",
    "nothing-new": "nobody",
    "failed": "nobody",
    "resolved": "agent",
    "resumed": "agent",
    "stopped": "nobody",
    "silent-stop": "sc",
    "gone": "sc",
    "inbox-unread": "sc",
    "prompt-waiting": "owner",
}

KEYED_STATES = {"needs-decision", "blocked"}

# A `note` never wakes sous chef and never becomes an open question, so a question
# reported as one is invisible: nothing records that the session is waiting. This
# matches the literal state names only. Keep it narrow -- a note legitimately
# mentioning a decision in passing should not be rejected, and the startup summary
# now counts unread notes, which catches whatever this misses.
READS_AS_QUESTION = re.compile(r"\bneeds[- ]decision\b", re.IGNORECASE)


CRON_LOG = "cron"  # never a session id: those always have a kind, a slug and a suffix
# Warnings from sous chef's own Stop hook about how full its context is (context.py).
# Unlike the cron log, nothing wakes sous chef for it: it is read at the next `sc events`.
CONTEXT_LOG = "context"
# Messages from Slack, collected from the relay by the watcher (slack.py).
SLACK_LOG = "slack"
# Syncing the data folder stopping and starting again, written by the watcher (sync.py).
SYNC_LOG = "sync"
CHEF_LOGS = (CRON_LOG, CONTEXT_LOG, SLACK_LOG, SYNC_LOG)


def log_dir(sid: str):
    if sid in CHEF_LOGS:
        return util.state_dir() / sid
    return records.session_dir(sid)


def log_path(sid: str):
    return log_dir(sid) / "events.jsonl"


def read_all(sid: str) -> list:
    path = log_path(sid)
    if not path.is_file():
        return []
    out = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def append(sid: str, author: str, state: str, text: str = "", key: str = None,
           waiting_on: str = None, extra: dict = None) -> dict:
    """Append one event. `extra` adds fields of the log's own (the slack log's `slack`, a cron event's `job`)."""
    with util.locked(log_dir(sid) / ".events.lock"):
        existing = read_all(sid)
        seq = (existing[-1]["seq"] + 1) if existing else 1
        if state in KEYED_STATES and not key:
            key = f"q{seq}"
        event = {"seq": seq, "ts": util.now(), "author": author, "state": state, "text": text}
        if key:
            event["key"] = key
        if waiting_on:
            event["waiting_on"] = waiting_on
        for k, v in (extra or {}).items():
            event.setdefault(k, v)
        with open(log_path(sid), "a") as f:
            f.write(json.dumps(event, sort_keys=True) + "\n")
            f.flush()
    return event


# The value logs written before the owner was a setting store `owner` as.
LEGACY_OWNER = "dylan"


def waiting_on(events: list) -> str:
    """Who the session waits on now: one of WAITING_ON's values, with LEGACY_OWNER read as `owner`."""
    current = "agent"
    for e in events:
        if e.get("waiting_on"):
            current = e["waiting_on"]
        elif e["state"] in WAITING_ON:
            current = WAITING_ON[e["state"]]
    return "owner" if current == LEGACY_OWNER else current


def show_waiting(value: str) -> str:
    """A waiting-on value as people read it: `owner` becomes the owner's name in lower case.

    Without a usable owner.json it stays `owner`, so read-only views never refuse.
    """
    if value != "owner":
        return value
    try:
        o = util.owner()
    except util.SCError:
        o = None
    return o["lower"] if o else value


def open_questions(events: list) -> list:
    """needs-decision and blocked events whose key has no later resolved event."""
    open_by_key = {}
    for e in events:
        if e["state"] in KEYED_STATES:
            open_by_key[e["key"]] = e
        elif e["state"] == "resolved" and e.get("key"):
            open_by_key.pop(e["key"], None)
    return sorted(open_by_key.values(), key=lambda e: e["seq"])


def last_session_event(events: list):
    for e in reversed(events):
        if e["author"] != "sc":
            return e
    return None


# --- sous chef's read positions -------------------------------------------

def _cursor_path():
    return util.state_dir() / "cursors.json"


def cursors() -> dict:
    return util.read_json(_cursor_path(), {}) or {}


def unread(sid: str, events: list = None) -> list:
    """Events sous chef has not acknowledged, excluding ones it wrote itself."""
    events = read_all(sid) if events is None else events
    pos = cursors().get(sid, 0)
    return [e for e in events if e["seq"] > pos and e["author"] != "sc"]


def ack(token: str) -> list:
    """Advance read positions to the ones named in a token from `sc events`.

    Token format: "<id>:<seq>,<id>:<seq>". Positions only ever move forward.
    """
    moved = []
    pairs = []
    for part in filter(None, token.split(",")):
        key, _, seq = part.rpartition(":")
        if not key or not seq.isdigit():
            raise util.SCError(f"bad ack token part '{part}'")
        # Resolve prefixes before writing, so an acknowledgement cannot land under
        # an id that does not exist and leave the events unread forever.
        pairs.append((key if key in CHEF_LOGS else records.resolve(key)["id"], int(seq)))
    with util.locked(util.state_dir() / ".cursors.lock"):
        data = cursors()
        for sid, seq in pairs:
            if int(seq) > data.get(sid, 0):
                data[sid] = int(seq)
                moved.append(sid)
        util.write_json(_cursor_path(), data)
    return moved


def forget(sid: str) -> None:
    with util.locked(util.state_dir() / ".cursors.lock"):
        data = cursors()
        if data.pop(sid, None) is not None:
            util.write_json(_cursor_path(), data)
