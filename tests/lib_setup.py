"""The code's own values that tests check against, imported from lib/ without running `sc`."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))

from sc.events import LEGACY_OWNER  # noqa: E402,F401
from sc.setup import DATA_GITIGNORE  # noqa: E402,F401
from sc.slack import LEGACY_FROM_OWNER  # noqa: E402,F401
