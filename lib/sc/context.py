"""How full sous chef's context is, and a warning before compaction.

Claude Code compacts a long conversation on its own, and nothing outside the
conversation can trigger or delay that. What sous chef can do is make sure its
working state is in memory/ first. So sous chef's Stop hook (`sc hook chef-stop`)
reads how full the context is at the end of every turn and, past a configured
level, leaves a warning in the context log for sous chef to act on.

Where the number comes from: Claude Code's session transcript
(~/.claude/projects/<project>/<session id>.jsonl). Every assistant line carries
the API `usage` of the call that produced it, and the prompt that call sent is
the context: input_tokens + cache_creation_input_tokens + cache_read_input_tokens.
The format is undocumented, so every way reading it can go wrong is reported as a
failure (ReadError) and never as a low reading.

Files:
  context.json                 configuration (tracked in git), written by `sc context set`
  state/context/state.json     the last reading, whether a warning is armed, a failure streak
  state/context/events.jsonl   the context log (events.CONTEXT_LOG), read with `sc events`
"""
import json
import os
from pathlib import Path

from . import chef, events, util

USAGE_FIELDS = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
CHUNK = 1 << 20            # read the transcript backwards a megabyte at a time
MAX_SCAN = 32 << 20        # and give up, loudly, after this much without a usable line
REARM_GAP = 10             # default: warn again only after usage fell this many points below warn_at


class ReadError(Exception):
    """The transcript could not tell us how full the context is. The message says why."""


# --- reading the transcript --------------------------------------------------

def _lines_from_end(path: Path, max_scan: int):
    """Yield (line, bytes_scanned) from the end of the file backwards, without reading all of it."""
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        pos = f.tell()
        tail = b""
        scanned = 0
        while pos > 0 and scanned < max_scan:
            step = min(CHUNK, pos)
            pos -= step
            f.seek(pos)
            buf = f.read(step) + tail
            scanned += step
            lines = buf.split(b"\n")
            tail = lines[0]  # may be the second half of a line that starts in the next chunk back
            for line in reversed(lines[1:]):
                if line.strip():
                    yield line, scanned
        if pos == 0 and tail.strip():
            yield tail, scanned


def read_usage(path, max_scan: int = MAX_SCAN) -> dict:
    """The context size at sous chef's most recent assistant turn, read from the end of its transcript.

    Returns {"tokens", "model", "parts": {field: n}, "timestamp"}, or {"compacted": True, ...}
    when the newest thing in the transcript is a compaction with no turn since. Raises
    ReadError, naming what was wrong, when it cannot give a number it trusts:
    - the file is missing or unreadable;
    - the newest real assistant line has no usage, or usage without the three fields
      (the format changed): an older line is not used instead, because its number is stale;
    - no assistant line at all in the part of the file it read.

    Skipped, because they are not the main conversation's context: lines that are not
    JSON (a line being written as we read), subagent lines (isSidechain), and messages
    Claude Code makes up itself (model "<synthetic>", with all-zero usage), such as API
    error notices.
    """
    path = Path(path)
    if not path.is_file():
        raise ReadError(f"transcript not found at {path}")
    scanned = 0
    try:
        for raw, scanned in _lines_from_end(path, max_scan):
            try:
                d = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(d, dict):
                continue
            if d.get("type") == "system" and d.get("subtype") == "compact_boundary":
                return {"compacted": True, "timestamp": d.get("timestamp"),
                        "pre_tokens": (d.get("compactMetadata") or {}).get("preTokens")}
            if d.get("type") != "assistant" or d.get("isSidechain"):
                continue
            msg = d.get("message")
            if not isinstance(msg, dict):
                raise ReadError("the newest assistant line has no `message` object; the transcript "
                                "format may have changed")
            if msg.get("model") == "<synthetic>":
                continue
            usage = msg.get("usage")
            if not isinstance(usage, dict):
                raise ReadError("the newest assistant message has no `usage` block; the transcript "
                                "format may have changed")
            missing = [f for f in USAGE_FIELDS if not isinstance(usage.get(f), int)]
            if missing:
                raise ReadError(f"the newest assistant usage block lacks {', '.join(missing)}; the "
                                f"transcript format may have changed (fields present: "
                                f"{', '.join(sorted(usage)) or 'none'})")
            parts = {f: usage[f] for f in USAGE_FIELDS}
            return {"tokens": sum(parts.values()), "model": msg.get("model"), "parts": parts,
                    "timestamp": d.get("timestamp")}
    except OSError as e:
        raise ReadError(f"could not read the transcript at {path}: {e}") from e
    raise ReadError(f"no assistant turn with usage in the last {scanned:,} bytes of {path}")


def find_transcript(session_id: str, hinted: str = None) -> Path:
    """The transcript for a Claude session: the path the hook payload gives, else found by session id.

    Claude Code documents `transcript_path` in hook payloads. Without it, the file is
    looked for as ~/.claude/projects/*/<session id>.jsonl, which avoids depending on
    how Claude Code turns a folder into a project name.
    """
    if hinted:
        return Path(hinted).expanduser()
    found = sorted((Path.home() / ".claude" / "projects").glob(f"*/{session_id}.jsonl"))
    if not found:
        raise ReadError(f"no transcript for session {session_id} under ~/.claude/projects, and the "
                        f"hook payload gave no transcript_path")
    return found[0]


# --- configuration -------------------------------------------------------------

def config_path() -> Path:
    return util.home() / "context.json"


def config() -> dict:
    try:
        data = util.read_json(config_path(), {}) or {}
    except ValueError as e:
        raise util.SCError(f"{config_path()} is not valid JSON: {e}") from e
    return data if isinstance(data, dict) else {}


def rearm_below(cfg: dict):
    if cfg.get("warn_at") is None:
        return None
    return cfg.get("rearm_below", max(0, cfg["warn_at"] - REARM_GAP))


def set_config(warn_at=None, rearm=None, windows=None, off=False) -> dict:
    """Change context.json. Percentages are of the window; windows map a model to its size in tokens."""
    cfg = config()
    if off:
        cfg.pop("warn_at", None)
        cfg.pop("rearm_below", None)
    if warn_at is not None:
        cfg["warn_at"] = warn_at
    if rearm is not None:
        cfg["rearm_below"] = rearm
    for model, size in (windows or {}).items():
        cfg.setdefault("windows", {})[model] = size
    w = cfg.get("warn_at")
    if w is not None and not 0 < w < 100:
        raise util.SCError("--warn-at is a percentage of the window, between 0 and 100")
    if w is not None and not 0 <= rearm_below(cfg) < w:
        raise util.SCError(f"--rearm-below must be below --warn-at ({w}%)")
    if w is None and "rearm_below" in cfg:
        raise util.SCError("--rearm-below needs --warn-at")
    util.write_json(config_path(), cfg)
    return cfg


def parse_window(text: str) -> tuple:
    model, _, size = text.rpartition("=")
    size = size.strip().lower().replace(",", "").replace("_", "")
    mult = {"k": 1_000, "m": 1_000_000}.get(size[-1:], 1)
    try:
        n = int(float(size[:-1] if mult > 1 else size) * mult)
    except ValueError:
        n = 0
    if not model or n <= 0:
        raise util.SCError(f"'{text}' is not MODEL=TOKENS, e.g. claude-opus-5=1000000 or claude-opus-5=1m")
    return model.strip(), n


# --- the hook ------------------------------------------------------------------

def _state_path() -> Path:
    return util.state_dir() / "context" / "state.json"


def state() -> dict:
    return util.read_json(_state_path(), {}) or {}


def _pct(n: float) -> str:
    return f"{n:.1f}%"


def check(session_id: str, transcript: Path) -> dict:
    """Read how full the context is and turn that into at most one event. Returns the reading.

    Raises ReadError when the number cannot be trusted; `on_stop` records that.
    """
    cfg = config()
    reading = read_usage(transcript)
    if reading.get("compacted"):
        return reading
    size = (cfg.get("windows") or {}).get(reading["model"])
    if not size:
        raise ReadError(f"no window size is set for model {reading['model']} "
                        f"(`sc context set --window {reading['model']}=TOKENS`)")
    if reading["tokens"] > size:
        raise ReadError(f"{reading['tokens']:,} tokens is more than the {size:,}-token window set for "
                        f"{reading['model']}, so that window is wrong")
    reading["window"] = size
    reading["percent"] = 100.0 * reading["tokens"] / size
    return reading


def on_stop(data: dict) -> None:
    """sous chef's Stop hook. Never raises for anything expected: failures are recorded, loudly.

    Hysteresis: one warning per crossing. After a warning nothing more is said until
    usage falls below `rearm_below` (by default 10 points under `warn_at`), which in
    practice is the compaction itself, or a new sous chef session starts.

    A failure to read is reported once per streak (a `context-unreadable` event), and
    its end once (`context-readable`), so a broken reader cannot pass for a quiet one.
    With no `warn_at` set the check is off: it still records its reading for
    `sc context`, but writes no events.
    """
    session_id = data.get("session_id")
    held = (chef.current() or {}).get("session_id")
    if not held:
        return
    if session_id and session_id != held:
        return  # not sous chef: a session the owner opened here by hand, say
    with util.locked(util.state_dir() / "context" / ".state.lock"):
        st = state()
        if st.get("session_id") != held:
            st = {"session_id": held, "armed": True}
        st["checked_at"] = util.now()
        try:
            cfg = config()
        except util.SCError as e:
            # Someone set it up, so it is meant to be on: say so rather than go quiet.
            _failed(st, str(e), {"warn_at": 0})
            util.write_json(_state_path(), st)
            return
        try:
            if not session_id:
                raise ReadError("the Stop hook payload has no session_id")
            reading = check(session_id, find_transcript(session_id, data.get("transcript_path")))
        except ReadError as e:
            _failed(st, str(e), cfg)
        except Exception as e:  # noqa: BLE001 - a bug here must still leave evidence, not silence
            _failed(st, f"the check itself failed ({type(e).__name__}: {e})", cfg)
        else:
            _read(st, reading, cfg)
        util.write_json(_state_path(), st)


def _failed(st: dict, reason: str, cfg: dict) -> None:
    fail = st.get("failing") or {"since": util.now(), "count": 0}
    fail["count"] += 1
    fail["reason"] = reason
    if cfg.get("warn_at") is not None and not fail.get("reported"):
        events.append(events.CONTEXT_LOG, "context", "context-unreadable",
                      f"The context check could not read how full your context is: {reason}. Until this is "
                      f"fixed nothing warns you before compaction, so keep memory/ current as you go. "
                      f"`sc context` shows the details. This is not repeated until a read works again.")
        fail["reported"] = True
    st["failing"] = fail


def _read(st: dict, reading: dict, cfg: dict) -> None:
    fail = st.pop("failing", None)
    if reading.get("compacted"):
        st["armed"] = True
        st["last"] = {**reading, "at": util.now()}
        return
    st["last"] = {**reading, "at": util.now()}
    warn_at = cfg.get("warn_at")
    if warn_at is None:
        return
    pct = reading["percent"]
    if fail and fail.get("reported"):
        events.append(events.CONTEXT_LOG, "context", "context-readable",
                      f"The context check can read usage again ({_pct(pct)} of the window); warnings "
                      f"are back on.")
    if pct >= warn_at and st.get("armed", True):
        events.append(events.CONTEXT_LOG, "context", "context-high",
                      f"Your context is at {_pct(pct)} ({reading['tokens']:,} of {reading['window']:,} tokens "
                      f"for {reading['model']}), past the warning level of {warn_at}%. Claude Code will "
                      f"compact this conversation before long. Before it does: write anything you are "
                      f"holding that is not in memory/ yet (decisions, findings, what sessions are doing "
                      f"and why) into the right memory file, and bring memory/focus.md up to date. Then "
                      f"acknowledge this event. No further warning until usage falls below "
                      f"{rearm_below(cfg)}%, which normally means after the compaction.")
        st["armed"] = False
    elif pct < rearm_below(cfg):
        st["armed"] = True


# --- what `sc context` and the summary show ------------------------------------

def status_lines() -> list:
    """What the check is set to and what it last saw, for `sc context` and the startup summary."""
    try:
        cfg = config()
    except util.SCError as e:
        return [f"BROKEN: {e}"]
    st = state()
    windows = ", ".join(f"{m} = {n:,} tokens" for m, n in sorted((cfg.get("windows") or {}).items())) or "none set"
    if cfg.get("warn_at") is None:
        lines = ["OFF: no warning level set (`sc context set --warn-at N`)."]
    else:
        lines = [f"ON: warns at {cfg['warn_at']}% of the window, again only after falling below "
                 f"{rearm_below(cfg)}%."]
    lines.append(f"Windows: {windows}.")
    fail = st.get("failing")
    if fail:
        lines.append(f"FAILING since {util.age(fail['since'])} ago ({fail['count']} check(s) in a row): "
                     f"{fail['reason']}")
    last = st.get("last")
    if last and last.get("compacted"):
        lines.append(f"Last reading: compacted, no turn since (checked {util.age(last['at'])} ago).")
    elif last:
        lines.append(f"Last reading: {_pct(last['percent'])} ({last['tokens']:,} of {last['window']:,} tokens, "
                     f"{last['model']}), {util.age(last['at'])} ago; "
                     f"{'armed' if st.get('armed', True) else 'already warned for this crossing'}.")
    if st.get("checked_at"):
        lines.append(f"Last check: {util.age(st['checked_at'])} ago.")
    else:
        lines.append("Last check: never. The Stop hook has not run for sous chef "
                     "(is `sc hook chef-stop` registered in .agents/settings.json?).")
    return lines
