"""The core names nobody: no core file names the first owner.

Sous chef's code, kinds, templates, docs and tests take the owner's name from
owner.json (decision 0018). This searches every file on the core's path list
(core_paths), ignoring case, for the first owner's name, branch prefix and Slack id,
so a new mention fails the suite. The tests run as a neutral owner, Alex.

Not searched, on purpose:
  docs/decisions/   records of who decided what, left as written (decision 0020)
  this file         it has to name what it searches for (the Slack id only as a hash)

Run: python3 -m unittest discover -s tests
"""
import hashlib
import re
import subprocess
import unittest
from pathlib import Path

import core_paths

ROOT = Path(__file__).resolve().parents[1]

SEARCH = re.compile(r"dylan|dyl/", re.IGNORECASE)
# The first owner's Slack user id is an identifier, not a name, so it is not written
# here: anything shaped like a Slack user id is compared by its SHA-256.
SLACK_ID = re.compile(r"\bU[A-Z0-9]{8,}\b")
SLACK_ID_SHA256 = "b57ff6249e9bddf5ad6321be7f364e8b994faabfe55abdd09b88ed6b35f789b3"
EXCLUDED_DIRS = ("docs/decisions/",)
# This file, which has to name what it searches for.
EXCLUDED_FILES = ("tests/test_owner_neutral.py",)
# Stored values from before the owner was a setting, which the code must still read.
# Each is one named constant, so the old value appears exactly once.
ALLOWED = {
    ("lib/sc/events.py", 'LEGACY_OWNER = "dylan"'),
    ("lib/sc/slack.py", 'LEGACY_FROM_OWNER = "from_dylan"'),
    ("tests/stored_values.py", 'LEGACY_OWNER = "dylan"'),
    ("tests/stored_values.py", 'LEGACY_FROM_OWNER = "from_dylan"'),
}


def core_files() -> list:
    """Every file on the core's path list (core_paths), minus the exclusions."""
    try:
        files = core_paths.core_files(ROOT)
    except RuntimeError as e:
        raise unittest.SkipTest(str(e))
    return [f for f in files if not f.startswith(EXCLUDED_DIRS) and f not in EXCLUDED_FILES and (ROOT / f).is_file()]


class OwnerNeutralTests(unittest.TestCase):
    def test_no_core_file_names_the_first_owner(self):
        found = []
        files = core_files()
        self.assertIn("AGENTS.md", files)
        self.assertIn("bin/sc", files)
        for rel in files:
            try:
                text = (ROOT / rel).read_text()
            except UnicodeDecodeError:
                continue
            for n, line in enumerate(text.splitlines(), 1):
                if SEARCH.search(line) and (rel, line.strip()) not in ALLOWED:
                    found.append(f"{rel}:{n}: {line.strip()[:120]}")
                if any(hashlib.sha256(m.group().encode()).hexdigest() == SLACK_ID_SHA256
                       for m in SLACK_ID.finditer(line)):
                    found.append(f"{rel}:{n}: the first owner's Slack user id")
            if SEARCH.search(rel):
                found.append(f"{rel}: the file name")
        self.assertEqual(found, [], "core files name the first owner; use the owner (owner.json) instead")

    def test_each_legacy_value_is_still_there_once(self):
        for rel, line in ALLOWED:
            self.assertEqual([l.strip() for l in (ROOT / rel).read_text().splitlines()].count(line), 1, rel)


# The owner's files. None may be tracked in the core, and the core's .gitignore lists each.
PERSONAL = ("my", "state/", ".env", "memory/", "cron/", "context.json", "owner.json", "instructions.md",
            "worker-instructions.md", ".agents/settings.local.json")


class CoreContentsTests(unittest.TestCase):
    def test_no_personal_file_is_on_the_core_path_list_and_each_is_ignored(self):
        files = core_paths.core_files(ROOT)
        for name in PERSONAL:
            self.assertEqual([f for f in files if f == name.rstrip("/") or f.startswith(name)], [], name)
            probe = name + "x" if name.endswith("/") else name
            out = subprocess.run(["git", "-C", str(ROOT), "check-ignore", "-q", "--no-index", probe])
            self.assertEqual(out.returncode, 0, f"the core's .gitignore does not ignore {name}")

    def test_every_tracked_file_is_core(self):
        outside = [f for f in core_paths.listed_files(ROOT) if not core_paths.is_core(f)]
        self.assertEqual(outside, [], "add these to the core path list (tests/core_paths.py) or the owner's data")


if __name__ == "__main__":
    unittest.main()
