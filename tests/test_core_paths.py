"""The code-copy helper (core_paths.copy_code): what a copy of a code root holds.

Run: python3 -m unittest discover -s tests
"""
import os
import tempfile
import unittest
from pathlib import Path

import core_paths


class CopyCodeTests(unittest.TestCase):
    def test_copy_code_copies_built_output_whole_and_links_node_modules(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, dest = Path(tmp) / "root", Path(tmp) / "copy"
            files = ("bin/sc", "lib/sc/x.py", "lib/sc/__pycache__/x.pyc", "kinds/general.md", "kinds/mine.md",
                     "templates/t.md", "install.sh", "src/a.ts", "dist/a.js", "dist/sub/b.js", "package.json",
                     "package-lock.json", "node_modules/pkg/index.js")
            for n, rel in enumerate(files):
                path = root / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(rel)
                os.utime(path, (1_700_000_000 + n, 1_700_000_000 + n))  # a time a fresh copy would not get
            core_paths.copy_code(dest, root=root)
            core_paths.copy_code(dest, root=root)  # copying again into the same folder works too
            for rel in ("bin/sc", "lib/sc/x.py", "kinds/general.md", "templates/t.md", "install.sh"):
                self.assertEqual((dest / rel).read_text(), rel)
            self.assertFalse((dest / "lib/sc/__pycache__").exists())
            self.assertFalse((dest / "kinds/mine.md").exists())
            for rel in ("src/a.ts", "dist/a.js", "dist/sub/b.js", "package.json", "package-lock.json"):
                self.assertEqual((dest / rel).read_text(), rel)
                self.assertEqual((dest / rel).stat().st_mtime, (root / rel).stat().st_mtime, rel)
            self.assertTrue((dest / "node_modules").is_symlink())
            self.assertEqual(os.readlink(dest / "node_modules"), str(root / "node_modules"))


if __name__ == "__main__":
    unittest.main()
