"""`sc setup`: install sous chef for its owner. `install.sh` runs it.

It connects the core (this code folder) to the owner's data folder, through the
link `<core>/my`, which everything else finds the data by (util.home()). It never
calls util.home() itself: it runs before the link exists.

Steps, each with a flag so tests (and a careful owner) can answer up front:

  data folder   --data (default ~/.my-sous-chef). An existing sous chef data folder
                is used as it is; otherwise --clone <url> clones one, or a new one
                is made with starter files.
  owner         only when the folder has no owner.json: --name, --branch-prefix
  git           a new folder only: --git / --no-git (git init and a first commit)
  push          a git data folder with no `origin`: --push-url <url of an empty repo
                you made>; setup never creates repos
  then          the `my` link, `sc` and `souschef` in --bin-dir (default ~/.local/bin),
                and .agents/settings.local.json, so a plain `claude` in the core may
                edit the data folder as it edits the core (Claude Code only reads it
                once the folder is trusted)

Running it again is safe: what is already in place is left alone. It refuses a
`my` link that points somewhere else, and the old combined layout.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

from . import util

DEFAULT_DATA = "~/.my-sous-chef"
DEFAULT_BIN = "~/.local/bin"
MEMORY_FILES = ("focus.md", "threads/index.md", "ideas.md", "pocs.md", "repos.md")
DATA_GITIGNORE = "state/\n.env\n__pycache__/\n"
SETTINGS_LOCAL = util.CODE_ROOT / ".agents" / "settings.local.json"


class Asker:
    """Answers from flags first; otherwise from the terminal, unless --yes or there is none."""

    def __init__(self, yes: bool):
        self.interactive = not yes and sys.stdin.isatty()

    def text(self, question: str, given, default=None, required_flag=None):
        if given is not None:
            return given
        if self.interactive:
            shown = f" [{default}]" if default else ""
            answer = input(f"{question}{shown}: ").strip()
            return answer or default
        if default is None and required_flag:
            raise util.SCError(f"{question}: pass {required_flag}")
        return default

    def yes_no(self, question: str, given, default: bool) -> bool:
        if given is not None:
            return given
        if self.interactive:
            answer = input(f"{question} [{'Y/n' if default else 'y/N'}]: ").strip().lower()
            return default if not answer else answer.startswith("y")
        return default


def _git(folder: Path, *args, check=True) -> subprocess.CompletedProcess:
    out = subprocess.run(["git", "-C", str(folder), *args], capture_output=True, text=True, timeout=120)
    if check and out.returncode != 0:
        raise util.SCError(f"git {' '.join(args)} failed in {folder}: {(out.stderr or out.stdout).strip()}")
    return out


def is_data_folder(folder: Path) -> bool:
    return any((folder / name).exists() for name in ("owner.json", "memory", "state", "instructions.md"))


def _check_link(data: Path) -> bool:
    """True when `my` already points at `data`. Refuses a link that points elsewhere, and the old layout."""
    link = util.DATA_LINK
    if link.is_symlink():
        target = Path(os.readlink(link)).expanduser()
        if target.resolve() == data.resolve() and target.exists():
            return True
        raise util.SCError(f"{link} already points to {target}. To use {data} instead, remove the link "
                           f"(rm {link}) and run setup again; the data behind it is not touched.")
    if link.exists():
        raise util.SCError(f"{link} exists and is not a link; move it away and run setup again")
    if (util.CODE_ROOT / "memory").is_dir() and (util.CODE_ROOT / "state").is_dir():
        raise util.SCError(f"{util.CODE_ROOT} still holds memory/ and state/ (the old layout, with code and data "
                           f"in one folder); run the switch-over that moves the data into its own folder")
    return False


def _starter_files(data: Path, owner_lower: str) -> None:
    feedback = f"memory/working-with-{util.slug(owner_lower)}.md"
    (data / "memory" / "threads").mkdir(parents=True, exist_ok=True)
    for rel in MEMORY_FILES:
        path = data / "memory" / rel
        if not path.exists():
            path.write_text(f"# {Path(rel).stem.replace('-', ' ').capitalize()}\n")
    if not (data / feedback).exists():
        (data / feedback).write_text("# Working with me\n\nFeedback on how sous chef works: corrections and "
                                     "confirmed approaches, each with why and how to apply it.\n")
    (data / "cron").mkdir(exist_ok=True)
    (data / "kinds").mkdir(exist_ok=True)
    if not (data / "instructions.md").exists():
        (data / "instructions.md").write_text(
            "<!-- Your own instructions for sous chef, on top of the core's AGENTS.md. Sous chef's startup "
            "summary shows this file in full. Comments like this one are left out. -->\n\n"
            f"- My feedback on how you work is in `my/{feedback}`. Read it on every start.\n")
    if not (data / "worker-instructions.md").exists():
        (data / "worker-instructions.md").write_text(
            "<!-- Your own instructions for every session sous chef launches, added to each brief under "
            "\"Instructions from your owner\". With nothing but comments, the section is left out. -->\n")
    if not (data / ".gitignore").exists():
        (data / ".gitignore").write_text(DATA_GITIGNORE)


def _write_owner(data: Path, name: str, prefix: str) -> None:
    name = (name or "").strip()
    problem = util.owner_problem(name, prefix)
    if problem:
        raise util.SCError(problem)
    util.write_json(data / "owner.json", {"name": name, "branch_prefix": prefix})


def _link_bin(bin_dir: Path, say) -> None:
    bin_dir.mkdir(parents=True, exist_ok=True)
    for name in ("sc", "souschef"):
        target, link = util.CODE_ROOT / "bin" / name, bin_dir / name
        if link.is_symlink():
            if Path(os.readlink(link)) == target:
                continue
            link.unlink()
        elif link.exists():
            say(f"left {link} alone: it is a file, not a link; run {target} by its path, or replace it")
            continue
        link.symlink_to(target)
        say(f"linked {link} -> {target}")
    if str(bin_dir) not in os.environ.get("PATH", "").split(":"):
        say(f"note: {bin_dir} is not on your PATH; add it so `sc` and `souschef` work from any terminal")


def _allow_data_folder(data: Path) -> None:
    """Let a plain `claude` in the core edit the data folder without asking (Claude Code's additionalDirectories)."""
    try:
        settings = json.loads(SETTINGS_LOCAL.read_text()) if SETTINGS_LOCAL.exists() else {}
    except ValueError as e:
        raise util.SCError(f"{SETTINGS_LOCAL} is not valid JSON ({e}); fix or remove it and run setup again") from e
    dirs = settings.setdefault("permissions", {}).setdefault("additionalDirectories", [])
    wanted = str(data.resolve())
    if wanted not in dirs:
        dirs.append(wanted)
        SETTINGS_LOCAL.parent.mkdir(parents=True, exist_ok=True)
        SETTINGS_LOCAL.write_text(json.dumps(settings, indent=2) + "\n")


def run(args) -> int:
    ask = Asker(args.yes)
    say = print
    data = Path(ask.text("Data folder (your memory, jobs and settings)", args.data, DEFAULT_DATA)).expanduser()
    data = data if data.is_absolute() else Path.cwd() / data
    linked = _check_link(data)

    made = False
    if data.exists() and any(data.iterdir()):
        if not is_data_folder(data):
            raise util.SCError(f"{data} is not empty and is not a sous chef data folder; choose another folder")
        if args.clone:
            raise util.SCError(f"{data} already holds a data folder; leave out --clone to use it as it is")
        say(f"using the data folder at {data}")
    else:
        url = args.clone
        if url is None and ask.interactive:
            url = ask.text("Clone an existing data folder from a git URL (blank for a new one)", None, "") or None
        if url:
            if data.exists():
                data.rmdir()
            out = subprocess.run(["git", "clone", "-q", url, str(data)], capture_output=True, text=True, timeout=600)
            if out.returncode != 0:
                raise util.SCError(f"git clone {url} failed: {(out.stderr or out.stdout).strip()}")
            say(f"cloned {url} into {data}")
        else:
            data.mkdir(parents=True, exist_ok=True)
            made = True

    if not (data / "owner.json").exists():
        name = ask.text("Your name, as sessions and Slack show it", args.name, None, "--name")
        prefix = ask.text("Your branch prefix, e.g. sam/ (blank for none)", args.branch_prefix, "")
        _write_owner(data, name, prefix)
        say(f"wrote {data / 'owner.json'}")
    owner_lower = json.loads((data / "owner.json").read_text()).get("name", "me").strip().lower()

    if made:
        _starter_files(data, owner_lower)
        say(f"made a new data folder at {data}")
        if ask.yes_no("Track the data folder in git (a private repo of your own)?", args.git, True):
            _git(data, "init", "-q", "-b", "main")
            _git(data, "add", "-A")
            _git(data, "commit", "-qm", "starts the sous chef data folder")
            say("started a git repo in it, with a first commit")

    # Only a repo whose top is the data folder itself: one it merely sits inside is someone else's.
    top = _git(data, "rev-parse", "--show-toplevel", check=False).stdout.strip()
    is_repo = bool(top) and Path(top).resolve() == data.resolve()
    if is_repo and not _git(data, "remote", check=False).stdout.split():
        push_url = ask.text("Push it to a remote? The URL of an empty repo you made (blank for none)",
                            args.push_url, "")
        if push_url:
            _git(data, "remote", "add", "origin", push_url)
            _git(data, "push", "-q", "-u", "origin", "HEAD")
            say(f"pushed it to {push_url}; the watcher keeps it pushed from now on")
    elif args.push_url:
        say(f"not pushing to {args.push_url}: the data folder is " +
            ("already set up with a remote" if is_repo else "not a git repo"))

    if not linked:
        util.DATA_LINK.symlink_to(data)
        say(f"linked {util.DATA_LINK} -> {data}")
    _link_bin(Path(args.bin_dir or DEFAULT_BIN).expanduser(), say)
    _allow_data_folder(data)
    say("\nSous chef is installed. Next:\n"
        "  sc slack setup --help   to reach sous chef from Slack (optional; ask for a relay key)\n"
        "  souschef                to start sous chef and attach to it\n"
        f"If you ever run plain `claude` in {util.CODE_ROOT}, accept its trust prompt the first time: until then\n"
        f"Claude Code ignores {SETTINGS_LOCAL.relative_to(util.CODE_ROOT)}, which lets it edit your data folder.")
    return 0
