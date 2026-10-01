"""A runtime that runs nothing, for tests.

Session state lives in state/fake-runtime.json:
  {"sessions": {"<id>": {"alive": true, "busy": false, "prompt": null, "activity": null,
                         "permissions": "auto"}},
   "wakes": [[id, text], ...]}
Tests flip "alive", "busy", "prompt" and "activity" directly, and read "wakes" to see
what was sent. "activity" is returned as it is, in the shape runtimes/__init__.py
describes, so a test can model a session with subagents in flight. Setting "prompt" models a session held at a permission prompt: as with Claude
Code, such a session is busy, whatever "busy" says. "permissions" is what the session
was launched with; a resume keeps it, as Claude Code keeps a session's launch flags.
Skills: every skill is available except names listed in "missing_skills" (False) or
"unknown_skills" (None, cannot tell). Each check is appended to "skill_checks" as
[name, cwd], so a test can see which working directory was checked.

Sous chef's own session (souschef runs on this runtime when SC_CHEF_RUNTIME is fake):
  "chef_alive": false makes wake_session_id fail, as when sous chef is not running.
  start_named adds sessions["fake-chef-<n>"] = {"alive": true, "busy": false, "pid": 1,
    "kind": "background", "id": "chef-<n>", "name", "launch_prompt", "cwd", "permissions"}
    (n counts from 1) and returns "chef-<n>".
  resume_session_id sets the row's "alive" true and "pid" 1, creating it if missing
    ("kind" background, "id" the first 8 characters of the session id), and returns its
    "id"; with SC_FAKE_RESUME_FAILS set it returns None and changes nothing.
  stop_short sets "alive" false and removes "pid" on the row whose "id" matches.
  attach_exec prints "fake attach <short id>" and returns: nothing is attached.
Tests model a sous chef open in a terminal with "pid" and "kind": "interactive", and a
stopped one with no "pid", as `claude agents` lists them.
"""
import os

from .. import util, wake as wake_mod

NAME = "fake"


def _path():
    return util.state_dir() / "fake-runtime.json"


def _load():
    return util.read_json(_path(), {"sessions": {}, "wakes": []})


def _save(data):
    util.write_json(_path(), data)


def listing():
    return _load()["sessions"]


def _status_of(s):
    if not s or not s.get("alive"):
        return {"alive": False, "busy": None, "pid": None, "prompt": None, "activity": None}
    prompt = s.get("prompt")
    return {"alive": True, "busy": True if prompt else s.get("busy", False), "pid": 1, "prompt": prompt,
            "activity": s.get("activity")}


def status(rec, rows=None):
    rows = listing() if rows is None else rows
    return _status_of(rows.get(rec["id"]))


def launch(rec, prompt, env, settings):
    if os.environ.get("SC_FAKE_LAUNCH_FAILS"):
        raise util.SCError("fake runtime was told to fail")
    data = _load()
    data["sessions"][rec["id"]] = {"alive": True, "busy": False, "prompt": None, "launch_prompt": prompt,
                                   "env": env, "settings": settings,
                                   "permissions": rec.get("permissions") or "auto"}
    _save(data)
    return {"short_id": rec["id"][-4:], "session_id": f"fake-{rec['id']}"}


def resume(rec, env, settings):
    if os.environ.get("SC_FAKE_RESUME_FAILS"):
        raise util.SCError("fake runtime was told to fail the resume")
    data = _load()
    data["sessions"].setdefault(rec["id"], {})["alive"] = True
    _save(data)


def stop(rec):
    data = _load()
    data["sessions"].setdefault(rec["id"], {})["alive"] = False
    _save(data)


def wake(rec, text, rows=None):
    if not status(rec)["alive"]:
        raise wake_mod.WakeError(f"{rec['id']} is not running")
    data = _load()
    data["wakes"].append([rec["id"], text])
    _save(data)


def status_session_id(session_id, rows=None):
    rows = listing() if rows is None else rows
    return _status_of(rows.get(session_id))


def wake_session_id(session_id, text, rows=None):
    data = _load()
    chef = data.get("chef_alive", True)
    if not chef:
        raise wake_mod.WakeError("chef not running")
    data["wakes"].append(["chef", text])
    _save(data)


def attach_command(rec):
    return f"fake attach {rec.get('id') or (rec.get('handle') or {}).get('short_id')}"


def start_named(name, prompt, cwd, env, permissions):
    from . import PERMISSIONS  # here, since runtimes/__init__.py imports this module
    if permissions not in PERMISSIONS:
        raise util.SCError(f"unknown permission value '{permissions}' (known: {', '.join(PERMISSIONS)})")
    data = _load()
    n = 1
    while f"fake-chef-{n}" in data["sessions"]:
        n += 1
    data["sessions"][f"fake-chef-{n}"] = {"alive": True, "busy": False, "pid": 1, "kind": "background",
                                          "id": f"chef-{n}", "name": name, "launch_prompt": prompt,
                                          "cwd": cwd, "permissions": permissions}
    _save(data)
    return f"chef-{n}"


def resume_session_id(session_id, cwd, env):
    if os.environ.get("SC_FAKE_RESUME_FAILS"):
        return None
    data = _load()
    row = data["sessions"].setdefault(session_id, {"kind": "background"})
    row.update({"alive": True, "pid": 1})
    row.setdefault("id", session_id[:8])
    _save(data)
    return row["id"]


def stop_short(short_id):
    data = _load()
    for row in data["sessions"].values():
        if row.get("id") == short_id:
            row["alive"] = False
            row.pop("pid", None)
    _save(data)


def attach_exec(short_id, cwd, env):
    print(f"fake attach {short_id}")


def skill_available(name, cwd=None):
    data = _load()
    data.setdefault("skill_checks", []).append([name, str(cwd) if cwd else None])
    _save(data)
    if name in data.get("unknown_skills", []):
        return None
    return name not in data.get("missing_skills", [])


def skill_places(cwd=None):
    return ["the fake runtime's missing_skills"]
