"""Session records: one directory per session under state/sessions/<id>/.

Directory contents:
  record.json    who the session is: kind, title, cwd, runtime, runtime handle
  brief.md       the instructions the session was launched with
  events.jsonl   append-only event log (events.py)
  inbox/         messages from sous chef (inbox.py)
  turns.json     last prompt and last stop times, written by hooks (hooks.py)
  report.md      optional deliverable a session writes (investigations)
"""
import secrets

from . import util


def session_dir(sid: str):
    return util.sessions_dir() / sid


def new_id(kind: str, title: str) -> str:
    return f"{kind}-{util.slug(title, 24)}-{secrets.token_hex(2)}"


def load(sid: str) -> dict:
    rec = util.read_json(session_dir(sid) / "record.json")
    if rec is None:
        raise util.SCError(f"no session '{sid}' (see: sc sessions)")
    return rec


def save(rec: dict) -> None:
    util.write_json(session_dir(rec["id"]) / "record.json", rec)


def all_ids() -> list:
    root = util.sessions_dir()
    if not root.is_dir():
        return []
    return sorted(p.name for p in root.iterdir() if (p / "record.json").is_file())


def all_records() -> list:
    return [load(sid) for sid in all_ids()]


def resolve(key: str) -> dict:
    """Find a session by exact id, or by a unique prefix of its id."""
    ids = all_ids()
    if key in ids:
        return load(key)
    matches = [i for i in ids if i.startswith(key)]
    if len(matches) == 1:
        return load(matches[0])
    if not matches:
        raise util.SCError(f"no session matches '{key}' (see: sc sessions)")
    raise util.SCError(f"'{key}' matches several sessions: {', '.join(matches)}")


def find_by_claude_session(claude_session_id: str):
    for rec in all_records():
        if (rec.get("handle") or {}).get("session_id") == claude_session_id:
            return rec
    return None


def turns(sid: str) -> dict:
    return util.read_json(session_dir(sid) / "turns.json", {}) or {}


def record_turn(sid: str, field: str) -> None:
    load(sid)  # refuse unknown sessions rather than creating a directory for them
    path = session_dir(sid) / "turns.json"
    with util.locked(session_dir(sid) / ".turns.lock"):
        data = util.read_json(path, {}) or {}
        data[field] = util.now()
        util.write_json(path, data)
