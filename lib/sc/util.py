"""Small shared helpers: paths, clock, atomic JSON files, locks."""
import contextlib
import fcntl
import json
import os
import re
import time
from pathlib import Path

# Code (kinds, templates, bin) comes from this checkout, the core. The owner's data
# (state, memory, cron jobs, their own kinds and settings) lives in their data folder,
# reached through one link in the core: <core>/my (gitignored; made by `sc setup`).
# SC_TEST_HOME points the data at a temporary directory for tests only. Neither is a
# variable any session is launched with: Claude Code can start a background session
# in a spare process created with an earlier launch's environment, so a per-session
# variable could point at the wrong home.
CODE_ROOT = Path(__file__).resolve().parents[2]
DATA_LINK = CODE_ROOT / "my"


class SCError(Exception):
    """A refusal or failure with a message meant for the caller."""


def data_problem():
    """Why there is no usable data folder behind <core>/my, as the fix to run, or None."""
    if DATA_LINK.exists():
        return None
    if DATA_LINK.is_symlink():
        return (f"{DATA_LINK} points to {os.readlink(DATA_LINK)}, which does not exist; "
                f"re-point it at your data folder: ln -sfn <data folder> {DATA_LINK}")
    if (CODE_ROOT / "memory").is_dir() and (CODE_ROOT / "state").is_dir():
        return (f"{CODE_ROOT} still holds memory/ and state/ (the old layout, with code and data in one folder); "
                f"run the switch-over that moves the data into its own folder")
    return f"no data folder: run {install_script()}"


def install_script() -> Path:
    return CODE_ROOT / "install.sh"


def home_problem():
    """Why home() would refuse, or None. Never raises."""
    return None if os.environ.get("SC_TEST_HOME") else data_problem()


def home() -> Path:
    """The owner's data folder: SC_TEST_HOME in tests, else <core>/my. Refuses (SCError) without one.

    The path goes through the link and is not resolved, so paths written into briefs
    stay valid when the data folder moves and the link is re-pointed.
    """
    test = os.environ.get("SC_TEST_HOME")
    if test:
        return Path(test)
    problem = data_problem()
    if problem:
        raise SCError(problem)
    return DATA_LINK


def state_dir() -> Path:
    return home() / "state"


def sessions_dir() -> Path:
    return state_dir() / "sessions"


def archive_dir() -> Path:
    return state_dir() / "archive"


def memory_dir() -> Path:
    return home() / "memory"


def kinds_dir() -> Path:
    """The core kinds, which ship with the code."""
    return CODE_ROOT / "kinds"


def user_kinds_dir() -> Path:
    """The user kinds: kinds that belong to the person running sous chef, in their data folder.

    Looked up before the core's. When a test points the data home at the code folder,
    this is the same folder as kinds_dir(), and kinds.py then treats it as the core only.
    """
    return home() / "kinds"


def templates_dir() -> Path:
    return CODE_ROOT / "templates"


def sc_bin() -> Path:
    return CODE_ROOT / "bin" / "sc"


# --- the owner ---------------------------------------------------------------
# The person this sous chef works for: their name and branch prefix, in owner.json at
# the root of the data folder, written by `sc setup` or `sc owner set`. Nothing else opens the file; everything reads it through owner().

NO_OWNER = "no owner set: run sc owner set --name <name> --branch-prefix <prefix>"

# Who a session can wait on (events.WAITING_ON). `owner` is the person sous chef works for.
# The owner's name in lower case stands for `owner`, so it may not be one of the others.
WAITING_VALUES = {"owner", "agent", "sc", "external", "nobody"}


def owner_problem(name, prefix):
    """Why this name and branch prefix cannot be the owner's, or None. Checked on write and on every read."""
    if not isinstance(name, str) or not name.strip() or not name.strip().isprintable():
        return "the name must be one line of printable text, e.g. Sam"
    if name.strip().lower() in WAITING_VALUES:
        return (f"'{name.strip()}' cannot be the owner's name: sessions waiting on the owner show their name in "
                f"lower case, and '{name.strip().lower()}' already means something else there")
    if not isinstance(prefix, str) or not prefix.isprintable() or any(c.isspace() for c in prefix):
        return "the branch prefix must be printable text without spaces, e.g. sam/ (or \"\" for none)"
    return None


def owner_path() -> Path:
    return home() / "owner.json"


def owner():
    """The owner as {"name", "lower", "branch_prefix"}, or None when owner.json does not exist.

    `lower` is the name in lower case: how the owner shows as a waiting-on value
    (events.py). Raises SCError when the file exists but cannot be used.
    """
    path = owner_path()
    try:
        data = read_json(path)
    except ValueError as e:
        raise SCError(f"{path} is not valid JSON ({e}); fix it or rewrite it with `sc owner set`") from e
    if data is None:
        return None
    name = data.get("name") if isinstance(data, dict) else None
    prefix = data.get("branch_prefix") if isinstance(data, dict) else None
    if name is None or prefix is None:
        raise SCError(f"{path} needs a name and a branch_prefix; rewrite it with `sc owner set`")
    problem = owner_problem(name, prefix)
    if problem:
        raise SCError(f"{path} cannot be used: {problem}; rewrite it with `sc owner set`")
    return {"name": name.strip(), "lower": name.strip().lower(), "branch_prefix": prefix}


def require_owner() -> dict:
    """The owner, or a refusal saying how to set one. For commands that cannot run without one."""
    o = owner()
    if not o:
        raise SCError(NO_OWNER)
    return o


def owner_name(fallback: str = "the owner") -> str:
    """The owner's name for text a person reads, or `fallback` when none is set or it is unreadable.

    Only for wording. Never use it to decide anything: Slack trust is the Slack user id
    alone (slack.py), and commands that need an owner call require_owner().
    """
    try:
        o = owner()
    except SCError:
        o = None
    return o["name"] if o else fallback


COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)


def owner_text(path: Path) -> str:
    """An owner's instructions file with its <!-- comments --> left out, stripped; "" when there is none."""
    return COMMENT.sub("", path.read_text()).strip() if path.is_file() else ""


PLACEHOLDER = re.compile(r"\{\{(\w+)\}\}")


def render(text: str, values: dict) -> str:
    """Fill {{key}} placeholders in one pass. A placeholder with no value is left as written.

    One pass, so text that arrives inside a value (a task, which anyone can write) is
    never filled in itself: a task saying {{owner}} keeps saying {{owner}}.
    """
    return PLACEHOLDER.sub(lambda m: values.get(m.group(1), m.group(0)), text)


def now() -> float:
    """Current epoch seconds. SC_FAKE_NOW lets tests control the clock."""
    fake = os.environ.get("SC_FAKE_NOW")
    return float(fake) if fake else time.time()


def iso(ts: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def age(ts: float) -> str:
    secs = max(0, int(now() - ts))
    if secs < 90:
        return f"{secs}s"
    if secs < 5400:
        return f"{secs // 60}m"
    if secs < 172800:
        return f"{secs // 3600}h"
    return f"{secs // 86400}d"


def slug(text: str, limit: int = 32) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return (s[:limit].rstrip("-")) or "task"


def read_json(path: Path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def write_json(path: Path, data) -> None:
    """Write via a temp file and rename, so readers never see half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2, sort_keys=True)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


@contextlib.contextmanager
def locked(path: Path):
    """Hold an exclusive lock on <path> for the duration of the block."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a") as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)
