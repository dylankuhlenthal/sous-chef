"""Claude Code background sessions (`claude --bg`).

Behaviour relied on, verified with Claude Code 2.1.274 and not re-checked since
(docs/domains/sessions.md holds the full list and the evidence):
- `claude --bg -n <name> ... <prompt>` prints "backgrounded · <short-id> · <name>".
- `claude agents --json --all` lists sessions with id (short), sessionId, name,
  pid (only while running) and status (idle, busy, waiting). `waiting` means a
  dialog is holding the session mid-turn, and the row then also has waitingFor,
  which is "permission prompt" for a tool permission prompt (verified live with
  2.1.278; docs/domains/sessions.md). The row's `state` field is not used: it also
  reads `blocked` when Claude Code's own classifier judged the last message to be a
  question, which sous chef learns from the session's own report instead.
- ~/.claude/jobs/<short id>/state.json holds `needs`, the exact ask of an open
  prompt (for example "approve Bash: <command>"), and, read live from 2.1.278,
  `detail` (the session's own one-line summary of what it is doing), `inFlight`
  ({"tasks": n, ...}, the background work it started that is still running) and
  `fan` (one entry per subagent or background command, with `kind`, `label`,
  `startedAt` in ms, and `doneAt` once finished). It is internal to Claude Code and
  undocumented, so every field is optional: when one is missing or malformed, sous
  chef behaves as if the file did not exist (`_activity`).
- Environment variables on the launch command are NOT reliable: a session can start
  in a spare process carrying an earlier launch's environment, so nothing may depend
  on them (docs/decisions/0007). Identity comes from CLAUDE_CODE_SESSION_ID.
- `--settings '<json>'` hooks apply to the session, and a background session keeps
  its launch options (name, permission mode, settings, model) when resumed. For the
  permission mode this was verified live with 2.1.278: a session launched in manual
  mode, stopped and resumed with no flags, stopped at a permission prompt again.
- `--permission-mode bypassPermissions` starts a background session unattended, with
  no acceptance dialog (verified live with 2.1.283; docs/domains/sessions.md).
- `--session-id` is ignored with --bg, so the id is read back after launch.
- `claude --bg --resume <sessionId>` with no other flags restarts a stopped session
  under the same id. Passing any flags with it starts a copy under a new id instead.
- Skills are files, and Claude Code has no command that lists them. Where it reads
  them from is in `skill_available` below (docs/domains/sessions.md, "Where Claude
  Code reads skills from", says which parts were checked and how).
"""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

from .. import util, wake as wake_mod

NAME = "claude-bg"
_BACKGROUNDED = re.compile(r"backgrounded\s+·\s+([0-9a-f]+)\s+·")
_ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def parse_short_id(output: str):
    """The short id from `claude --bg` output. It may carry terminal colour codes."""
    m = _BACKGROUNDED.search(_ANSI.sub("", output))
    return m.group(1) if m else None


def _run(args, cwd=None, env=None, timeout=90):
    try:
        return subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        raise util.SCError("'claude' is not on PATH")
    except subprocess.TimeoutExpired:
        raise util.SCError(f"timed out running: {' '.join(args[:3])} ...")


def listing() -> dict:
    """All Claude sessions, keyed by short id and by full sessionId."""
    out = _run(["claude", "agents", "--json", "--all"], timeout=30)
    if out.returncode != 0:
        raise util.SCError(f"'claude agents --json' failed: {out.stderr.strip()}")
    rows = json.loads(out.stdout or "[]")
    by_key = {}
    for r in rows:
        if r.get("id"):
            by_key[r["id"]] = r
        if r.get("sessionId"):
            by_key[r["sessionId"]] = r
    return by_key


def _row(rec, rows):
    handle = rec.get("handle") or {}
    return rows.get(handle.get("session_id")) or rows.get(handle.get("short_id"))


def status(rec, rows=None) -> dict:
    rows = listing() if rows is None else rows
    return _status_of(_row(rec, rows))


def _status_of(row) -> dict:
    """The runtime status of one listing row. A session held at a prompt is busy: its turn has not ended."""
    if not row or not row.get("pid"):
        return {"alive": False, "busy": None, "pid": None, "prompt": None, "activity": None}
    st = row.get("status")
    job = _read_job(row)
    prompt = None
    if st == "waiting":
        prompt = row.get("waitingFor") or "a dialog"
        needs = _job_needs(job)
        if needs:
            prompt = f"{prompt} ({needs})"
    return {"alive": True, "busy": None if st is None else st != "idle", "pid": row["pid"], "prompt": prompt,
            "activity": _activity(job)}


def _read_job(row):
    """Claude Code's own job file for a listing row, as a dict, or None. Best effort: the file is internal.

    A file whose sessionId names another session than the row's is ignored, so a
    reused short id can never lend one session another's state.
    """
    short_id = row.get("id")
    if not short_id:
        return None
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    try:
        with open(os.path.join(base, "jobs", short_id, "state.json")) as f:
            job = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(job, dict):
        return None
    if job.get("sessionId") and row.get("sessionId") and job["sessionId"] != row["sessionId"]:
        return None
    return job


def _one_line(value, limit):
    """A string field squashed to one line and capped, or None when it is not a non-empty string."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = " ".join(value.split())
    return text if len(text) <= limit else text[:limit - 3] + "..."


def _job_needs(job):
    """What an open prompt asks, from the job file, or None."""
    return _one_line(job.get("needs"), 300) if job and job.get("tempo") == "blocked" else None


# Claude Code's `fan` kinds, in sc's words. Any other kind is passed on as it is.
_FAN_KINDS = {"agent": "subagent"}


def _activity(job):
    """What the session is doing, in the plain shape `status` promises, or None when the file says nothing usable.

    in_flight is `inFlight.tasks`: the number of subagents and background commands
    the session started that are still running, as Claude Code counts them. It is
    None unless the field is a whole number, so a renamed or reshaped field reads as
    "cannot tell", never as "nothing running" or "something running". `queued` and
    `drainableMonitors` are not counted: see "Work in flight" in docs/domains/watcher.md.
    running lists the `fan` entries with no `doneAt`, for display only.
    """
    if not job:
        return None
    in_flight = None
    tasks = job.get("inFlight").get("tasks") if isinstance(job.get("inFlight"), dict) else None
    if isinstance(tasks, int) and not isinstance(tasks, bool) and tasks >= 0:
        in_flight = tasks
    running = []
    for entry in job.get("fan") if isinstance(job.get("fan"), list) else []:
        if not isinstance(entry, dict) or entry.get("doneAt") is not None:
            continue
        label = _one_line(entry.get("label"), 120)
        if not label:
            continue
        kind = entry.get("kind") if isinstance(entry.get("kind"), str) else "task"
        started = entry.get("startedAt")
        since = started / 1000 if isinstance(started, (int, float)) and not isinstance(started, bool) else None
        running.append({"kind": _FAN_KINDS.get(kind, kind), "label": label, "since": since})
    detail = _one_line(job.get("detail"), 200)
    if detail is None and in_flight is None and not running:
        return None
    return {"detail": detail, "in_flight": in_flight, "running": running}


# sc's permission values (runtimes.PERMISSIONS) as Claude Code's --permission-mode.
# A record from before permissions were recorded has none, and ran in auto mode.
_PERMISSION_MODES = {"auto": "auto", "accept-edits": "acceptEdits", "bypass": "bypassPermissions", "ask": "manual"}


def _permission_mode(rec) -> str:
    value = rec.get("permissions") or "auto"
    if value not in _PERMISSION_MODES:
        raise util.SCError(f"the Claude runtime has no permission mode for '{value}' "
                           f"(known: {', '.join(_PERMISSION_MODES)})")
    return _PERMISSION_MODES[value]


def _launch_args(rec, settings):
    args = ["claude", "--bg", "-n", rec["handle_name"], "--permission-mode", _permission_mode(rec),
            "--settings", json.dumps(settings)]
    if rec.get("model"):
        args += ["--model", rec["model"]]
    if rec.get("effort"):
        args += ["--effort", rec["effort"]]
    return args


def launch(rec, prompt, env, settings) -> dict:
    out = _run(_launch_args(rec, settings) + [prompt], cwd=rec["cwd"], env={**os.environ, **env})
    short = parse_short_id(out.stdout + out.stderr)
    if not short:
        # The output was not understood, but the session may still have started:
        # look for it by its unique name before reporting a failure.
        named = [r for r in listing().values() if r.get("name") == rec["handle_name"] and r.get("id")]
        if not named:
            text = _ANSI.sub("", out.stdout + out.stderr).strip()[-400:]
            raise util.SCError(f"claude --bg did not start the session (exit {out.returncode}): {text}")
        short = named[0]["id"]
    # The full session id appears in the listing shortly after launch.
    for _ in range(20):
        row = listing().get(short)
        if row and row.get("sessionId"):
            return {"short_id": short, "session_id": row["sessionId"]}
        time.sleep(1)
    return {"short_id": short, "session_id": None}


def resume(rec, env, settings) -> None:
    """Continue the stopped session itself. `env` and `settings` are unused: the session kept its own.

    So did its permission mode: Claude Code saved the launch flags and reuses them.
    """
    handle = rec.get("handle") or {}
    if not handle.get("session_id"):
        raise util.SCError(f"{rec['id']} has no recorded Claude session id, so it cannot be resumed")
    # No flags besides --resume: with flags, Claude Code starts a copy under a new id.
    out = _run(["claude", "--bg", "--resume", handle["session_id"]], cwd=rec["cwd"], env={**os.environ, **env})
    short = parse_short_id(out.stdout + out.stderr)
    if not short:
        raise util.SCError(f"resume failed: {_ANSI.sub('', out.stdout + out.stderr).strip()[-400:]}")
    for _ in range(15):
        if status(rec)["alive"]:
            return
        time.sleep(1)
    if short != handle.get("short_id"):
        _run(["claude", "stop", short], timeout=60)
    raise util.SCError(f"resume did not bring back {rec['id']} (Claude Code started {short} instead, now stopped)")


def stop(rec) -> None:
    short = (rec.get("handle") or {}).get("short_id")
    if not short:
        raise util.SCError(f"{rec['id']} has no runtime handle")
    for _ in range(2):
        _run(["claude", "stop", short], timeout=60)
        for _ in range(10):
            if not status(rec)["alive"]:
                return
            time.sleep(1)
    raise util.SCError(f"{rec['id']} is still running after two stop attempts")


def wake(rec, text, rows=None) -> None:
    st = status(rec, rows)
    if not st["alive"]:
        raise wake_mod.WakeError(f"{rec['id']} is not running (no pid in `claude agents --json`)")
    wake_mod.post(st["pid"], text)


def status_session_id(session_id: str, rows=None) -> dict:
    """`status` for any Claude session by sessionId, such as sous chef's own."""
    rows = listing() if rows is None else rows
    return _status_of(rows.get(session_id))


def wake_session_id(session_id: str, text: str, rows=None) -> None:
    """Wake any running Claude session (interactive or background) by sessionId."""
    rows = listing() if rows is None else rows
    row = rows.get(session_id)
    if not row or not row.get("pid"):
        raise wake_mod.WakeError(f"Claude session {session_id[:8]} is not running")
    wake_mod.post(row["pid"], text)


# --- sous chef's own session (used by `souschef`; see lib/sc/souschef.py) ----

def _named_args(name: str, prompt: str, permissions: str) -> list:
    return (["claude", "--bg", "-n", name, "--permission-mode", _permission_mode({"permissions": permissions})]
            + ([prompt] if prompt else []))


def start_named(name: str, prompt: str, cwd: str, env: dict, permissions: str) -> str:
    """Start a background session with this name and sc permission value, returning its short id.

    The mode is fixed at launch: resuming keeps it (see the top of this file).
    """
    out = _run(_named_args(name, prompt, permissions), cwd=cwd, env=env)
    short = parse_short_id(out.stdout + out.stderr)
    if not short:
        raise util.SCError(f"could not start {name}: {_ANSI.sub('', out.stdout + out.stderr).strip()[-400:]}")
    return short


def resume_session_id(session_id: str, cwd: str, env: dict):
    """Continue a stopped session by its own id. Returns its short id, or None if it did not come back.

    No flags besides --resume: with flags, Claude Code keeps the session's saved
    options and starts a copy under a new id instead.
    """
    out = _run(["claude", "--bg", "--resume", session_id], cwd=cwd, env=env)
    short = parse_short_id(out.stdout + out.stderr)
    if not short:
        return None
    for _ in range(15):
        row = listing().get(session_id)
        if row and row.get("pid"):
            return row.get("id") or short
        time.sleep(1)
    stop_short(short)  # a copy, not the session asked for
    return None


def stop_short(short_id: str) -> None:
    _run(["claude", "stop", short_id], timeout=60)


def attach_exec(short_id: str, cwd: str, env: dict):
    """Replace this process with an attached session. Does not return."""
    os.chdir(cwd)
    os.execvpe("claude", ["claude", "attach", short_id], env)


def attach_command(rec) -> str:
    short = (rec.get("handle") or {}).get("short_id") or "<unknown>"
    return f"claude attach {short}"


# --- skills ------------------------------------------------------------------
# Claude Code's managed settings folder, per platform (read from Claude Code 2.1.285's
# code). Its .claude/skills holds the organisation's managed skills. Tests replace it.
MANAGED_DIR = Path("/Library/Application Support/ClaudeCode" if sys.platform == "darwin" else "/etc/claude-code")


def _config_dir() -> Path:
    """Claude Code's user folder: CLAUDE_CONFIG_DIR when set, else ~/.claude."""
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"))


def _repo_root(start: Path):
    """The nearest folder at or above `start` holding .git (a folder, or a file in a linked worktree), or None."""
    for folder in (start, *start.parents):
        if (folder / ".git").exists():
            return folder
    return None


def _main_checkout(worktree: Path):
    """The main checkout of a linked git worktree, or None (a bare repo has none)."""
    try:
        gitdir = (worktree / ".git").read_text().strip()
        if not gitdir.startswith("gitdir:"):
            return None
        gitdir = (worktree / gitdir[len("gitdir:"):].strip()).resolve()
        common = (gitdir / (gitdir / "commondir").read_text().strip()).resolve()
    except OSError:
        return None
    return common.parent if common.name == ".git" else None


def _project_dirs(cwd) -> list:
    """The folders whose .claude/ a session in `cwd` loads skills from.

    `cwd` and each parent up to the repo root (the worktree root in a linked worktree),
    or up to / outside a repo. A linked worktree with no .claude/skills at its root
    also gets the main checkout's (Claude Code 2.1.277 and later).
    """
    start = Path(cwd).expanduser().resolve()
    root = _repo_root(start)
    dirs = []
    for folder in (start, *start.parents):
        dirs.append(folder)
        if folder == root:
            break
    if root is not None and (root / ".git").is_file() and not (root / ".claude" / "skills").is_dir():
        main = _main_checkout(root)
        if main is not None:
            dirs.append(main)
    return dirs


def _plugin_dirs(config: Path) -> list:
    """Root folders of the installed and synced plugins, each of which may have skills/ and commands/."""
    plugins = config / "plugins"
    dirs = set(plugins.glob("cache/*/*/*")) | set(plugins.glob("synced/*/*"))
    try:
        installed = json.loads((plugins / "installed_plugins.json").read_text()).get("plugins", {})
        for entries in installed.values():
            for entry in entries if isinstance(entries, list) else []:
                if isinstance(entry, dict) and isinstance(entry.get("installPath"), str):
                    dirs.add(Path(entry["installPath"]))
    except (OSError, ValueError, AttributeError):
        pass
    return sorted(d for d in dirs if d.is_dir())


def _front_matter_name(skill_md: Path):
    try:
        text = skill_md.read_text(errors="replace")
    except OSError:
        return None
    if not text.startswith("---\n"):
        return None
    for line in text[4:].split("\n---", 1)[0].splitlines():
        key, _, value = line.partition(":")
        if key.strip() == "name":
            return value.strip().strip("'\"") or None
    return None


def _has_skill(skills_dir: Path, name: str) -> bool:
    """A skill called `name` in this skills folder: <name>/SKILL.md, or any SKILL.md whose front matter names it."""
    if (skills_dir / name / "SKILL.md").is_file():
        return True
    return any(_front_matter_name(md) == name for md in skills_dir.glob("*/SKILL.md"))


def skill_available(name: str, cwd=None):
    """Whether a session in `cwd` can run the skill `name`: True, False, or None (cannot tell).

    Looks for <name>/SKILL.md (or a SKILL.md whose front matter `name` is `name`) in every
    folder Claude Code reads skills from on disk, and for a legacy command <name>.md:
      user       <config>/skills, and <config>/skills/synced/<org>/ (skills synced from claude.ai)
      project    .claude/skills in cwd and each parent up to the repo root (see _project_dirs)
      managed    MANAGED_DIR/.claude/skills
      plugins    skills/ in each installed or synced plugin under <config>/plugins
      commands   <config>/commands, .claude/commands in the project folders, plugins' commands/
    <config> is CLAUDE_CONFIG_DIR, else ~/.claude. Without a cwd (`sc kinds`), project
    folders are not checked. A name with a colon (plugin:skill, anthropic-skills:docx)
    is not checked and gives None, as do names with a slash.
    """
    if not name or ":" in name or "/" in name or name in (".", ".."):
        return None
    config = _config_dir()
    projects = _project_dirs(cwd) if cwd else []
    plugins = _plugin_dirs(config)
    skill_dirs = [config / "skills", *(config / "skills" / "synced").glob("*"),
                  *(p / ".claude" / "skills" for p in projects), MANAGED_DIR / ".claude" / "skills",
                  *(p / "skills" for p in plugins)]
    command_dirs = [config / "commands", *(p / ".claude" / "commands" for p in projects),
                    *(p / "commands" for p in plugins)]
    if any(d.is_dir() and _has_skill(d, name) for d in skill_dirs):
        return True
    return any((d / f"{name}.md").is_file() for d in command_dirs)


def skill_places(cwd=None) -> list:
    """Where skill_available looks, in words, for a refusal message."""
    config = _config_dir()
    places = [str(config / "skills")]
    if cwd:
        places += [str(p / ".claude" / "skills") for p in _project_dirs(cwd)]
    places += [str(MANAGED_DIR / ".claude" / "skills"), f"plugins under {config / 'plugins'}"]
    return places
