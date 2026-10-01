"""Which sc the suite tests. The only place this is decided.

  REPO       the checkout holding these tests. Checks of the repo's own content use it
             (.gitignore, the core path list, the owner-name search).
  CODE       the code root under test: SC_UNDER_TEST when set and not empty, else REPO,
             with links resolved.
             A code root is a folder with an executable bin/sc (and bin/souschef), as a
             core checkout or a staged copy has.
  SC         CODE/bin/sc, and SOUSCHEF, CODE/bin/souschef. Tests run them directly as
             programs, never as `python3 bin/sc`, so any language's launcher works.
  IS_PYTHON  whether CODE is the Python sc: the first line of its bin/sc names python.
  python_only  marks a test of the Python sc's internals. It runs only when IS_PYTHON,
             and only such tests import from CODE/lib, behind IS_PYTHON.

SC_UNDER_TEST is read once, when the tests load. ScTestCase removes every SC_* variable
before running sc, so it never reaches the sc under test.

Run: PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests
     SC_UNDER_TEST=/abs/path/to/code/root PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests
"""
import os
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def _code_root() -> Path:
    named = os.environ.get("SC_UNDER_TEST", "")
    if not named:
        return REPO
    root = Path(named)
    if not root.is_absolute():
        raise RuntimeError(f"SC_UNDER_TEST must be an absolute path to a code root, not {named!r}")
    sc = root / "bin" / "sc"
    if not sc.is_file() or not os.access(sc, os.X_OK):
        raise RuntimeError(f"SC_UNDER_TEST={named} is not a code root: {sc} is missing or not executable")
    return root.resolve()  # as sc sees its own root, so paths it prints compare equal


CODE = _code_root()
SC = CODE / "bin" / "sc"
SOUSCHEF = CODE / "bin" / "souschef"

with open(SC, "rb") as _f:
    IS_PYTHON = b"python" in _f.readline()

python_only = unittest.skipUnless(
    IS_PYTHON, "Python-only: tests the Python sc's internals, which retire with that code (TRV-1143 decision 5)")
