"""The core's path list: which files belong to the shared sous chef code repo.

Everything else in a sous chef folder is the owner's (their data folder, reached
through the `my` link). The list is used by:

  copy_code()       tests that run a copy of the code under test, holding only core
                    files, so they pass in the core as it is published (decision 0020),
                    plus a built core's output
  core_files()      the checks that no personal file and no owner's name is in the core

The path list is about this checkout's content (ROOT), whichever sc the suite tests;
copy_code copies the code under test (sc_under_test.CODE) unless told otherwise.

Run: python3 -m unittest discover -s tests
"""
import shutil
import subprocess
from pathlib import Path

from sc_under_test import CODE

ROOT = Path(__file__).resolve().parents[1]

# Folders (ending in /) and single files. A path is core when it is one of the files
# or sits under one of the folders.
CORE_PATHS = (
    "bin/", "lib/", "docs/", "tests/", "templates/", ".agents/",
    "kinds/general.md", "kinds/investigate.md",
    "AGENTS.md", "CLAUDE.md", ".claude", ".gitignore", "README.md", "install.sh",
    "src/", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json", "eslint.config.js",
    "vitest.config.ts",
)

# Inside a core folder but never core: written per install, gitignored.
NOT_CORE = (".agents/settings.local.json",)

# What a running copy of the code needs: copied file by file, core files only.
RUNTIME_PATHS = ("bin/", "lib/", "templates/", "kinds/", "install.sh")
# A built core's source and output: copied whole when present, not filtered by the path
# list (dist/ is gitignored, so it is never on it), with modification times kept so a
# launcher that compares dist/ with src/ sees the copy as built.
BUILD_PATHS = ("src/", "dist/", "package.json", "package-lock.json")
# Linked, not copied, when present: too big to copy for every test, and never changed by one.
LINKED_PATHS = ("node_modules",)


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


def copy_code(dest: Path, root: Path = CODE) -> Path:
    """Copy what a running sc needs from the code root `root` into dest, and return dest.

    RUNTIME_PATHS file by file, core files only (so the owner's kinds, if still in the
    tree, and Python's caches are left behind); then BUILD_PATHS whole; then LINKED_PATHS
    as links to root's. Paths root does not have are skipped. Every file keeps its
    modification time. Walks the folder rather than asking git, so it also works in a
    copy that is not a git repo.
    """
    dest.mkdir(parents=True, exist_ok=True)
    for part in RUNTIME_PATHS:
        src = root / part.rstrip("/")
        if src.is_file():
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
    for part in BUILD_PATHS:
        src = root / part.rstrip("/")
        if src.is_dir():
            shutil.copytree(src, dest / part.rstrip("/"), symlinks=True, dirs_exist_ok=True)
        elif src.is_file():
            shutil.copy2(src, dest / part)
    for part in LINKED_PATHS:
        if (root / part).exists() and not (dest / part).is_symlink():
            (dest / part).symlink_to(root / part)
    return dest


def core_kind_names() -> list:
    """The kinds the core ships, from the path list."""
    return sorted(Path(p).stem for p in CORE_PATHS if p.startswith("kinds/"))
