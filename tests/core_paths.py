"""The core's path list: which files belong to the shared sous chef code repo.

Everything else in a sous chef folder is the owner's (their data folder, reached
through the `my` link). The list is used by:

  copy_code()       tests that run a copy of the code, holding only core files, so
                    they pass in the core as it is published (decision 0020)
  core_files()      the checks that no personal file and no owner's name is in the core

Run: python3 -m unittest discover -s tests
"""
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Folders (ending in /) and single files. A path is core when it is one of the files
# or sits under one of the folders.
CORE_PATHS = (
    "bin/", "lib/", "docs/", "tests/", "templates/", ".agents/",
    "kinds/general.md", "kinds/investigate.md",
    "AGENTS.md", "CLAUDE.md", ".claude", ".gitignore", "README.md", "install.sh",
)

# Inside a core folder but never core: written per install, gitignored.
NOT_CORE = (".agents/settings.local.json",)

# What a running copy of the code needs.
RUNTIME_PATHS = ("bin/", "lib/", "templates/", "kinds/", "install.sh")


def is_core(rel: str) -> bool:
    if rel in NOT_CORE or "__pycache__" in rel.split("/") or rel.endswith(".pyc"):
        return False
    return any(rel.startswith(p) if p.endswith("/") else rel == p for p in CORE_PATHS)


def listed_files(root: Path = ROOT) -> list:
    """Every file git tracks or would track (untracked but not ignored) under root."""
    out = subprocess.run(["git", "-C", str(root), "ls-files", "--cached", "--others", "--exclude-standard"],
                         capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"git could not list the files in {root}: {out.stderr.strip()}")
    return [f for f in out.stdout.splitlines() if (root / f).is_file() or (root / f).is_symlink()]


def core_files(root: Path = ROOT) -> list:
    return [f for f in listed_files(root) if is_core(f)]


def copy_code(dest: Path, root: Path = ROOT) -> Path:
    """Copy the core's runtime files (bin, lib, templates, the core kinds, install.sh) into dest.

    Walks the folder rather than asking git, so it also works in a copy that is not
    a git repo. The owner's kinds, if still in the tree, are left behind.
    """
    for part in RUNTIME_PATHS:
        src = root / part.rstrip("/")
        if src.is_file():
            dest.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest / src.name)
            continue
        if not src.is_dir():
            continue
        for path in sorted(src.rglob("*")):
            rel = path.relative_to(root).as_posix()
            if path.is_file() and is_core(rel):
                target = dest / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, target)
    return dest


def core_kind_names() -> list:
    """The kinds the core ships, from the path list."""
    return sorted(Path(p).stem for p in CORE_PATHS if p.startswith("kinds/"))
