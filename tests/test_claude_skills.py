"""The Claude runtime's skill check (claude_bg.skill_available), against a temporary folder tree.

Each test builds the folders Claude Code reads skills from (a config folder standing in
for ~/.claude, a managed folder, a repo with a project folder inside) and asks whether
a skill is there. Nothing here runs Claude Code; docs/domains/sessions.md says what was
checked against Claude Code itself.

Run: python3 -m unittest discover -s tests
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "lib"))

from sc.runtimes import claude_bg  # noqa: E402


class ClaudeSkillLookupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name).resolve()
        self.config = base / "config"
        self.managed = base / "managed"
        self.repo = base / "repo"
        self.project = self.repo / "packages" / "app"
        self.outside = base / "outside"
        for d in (self.config, self.managed, self.project, self.outside):
            d.mkdir(parents=True)
        (self.repo / ".git").mkdir()
        patches = [mock.patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": str(self.config)}),
                   mock.patch.object(claude_bg, "MANAGED_DIR", self.managed)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def skill(self, skills_dir, folder, name=None):
        path = skills_dir / folder / "SKILL.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        head = f"name: {name}\n" if name else ""
        path.write_text(f"---\n{head}description: a test skill\n---\nDo it.\n")

    def available(self, name, cwd=None):
        return claude_bg.skill_available(name, str(cwd) if cwd else None)

    def test_a_user_skill_is_found_with_or_without_a_cwd(self):
        self.skill(self.config / "skills", "build")
        self.assertIs(self.available("build"), True)
        self.assertIs(self.available("build", self.outside), True)
        self.assertIs(self.available("shape"), False)

    def test_the_user_skills_folder_may_be_a_symlink(self):
        real = Path(self.tmp.name) / "agents-skills"
        self.skill(real, "build")
        (self.config / "skills").symlink_to(real)
        self.assertIs(self.available("build"), True)

    def test_a_skill_synced_from_claude_ai_is_found_by_its_plain_name(self):
        self.skill(self.config / "skills" / "synced" / "org-123", "docx")
        self.assertIs(self.available("docx"), True)

    def test_a_front_matter_name_counts_as_well_as_the_folder_name(self):
        self.skill(self.config / "skills", "deploy-staging", name="deploy")
        self.assertIs(self.available("deploy"), True)
        self.assertIs(self.available("deploy-staging"), True)

    def test_a_project_skill_is_found_only_with_a_cwd_in_that_project(self):
        self.skill(self.project / ".claude" / "skills", "local-only")
        self.assertIs(self.available("local-only", self.project), True)
        self.assertIs(self.available("local-only"), False)
        self.assertIs(self.available("local-only", self.outside), False)

    def test_a_skill_in_a_parent_up_to_the_repo_root_is_found(self):
        self.skill(self.repo / ".claude" / "skills", "root-skill")
        self.assertIs(self.available("root-skill", self.project), True)

    def test_a_skill_above_the_repo_root_is_not_found(self):
        self.skill(Path(self.tmp.name) / ".claude" / "skills", "above-repo")
        self.assertIs(self.available("above-repo", self.project), False)
        # Outside any repo, every parent counts.
        self.assertIs(self.available("above-repo", self.outside), True)

    def test_a_linked_worktree_without_skills_gets_the_main_checkouts(self):
        self.skill(self.repo / ".claude" / "skills", "main-skill")
        subprocess.run(["git", "init", "-q", "-b", "main", str(self.repo)], check=True)
        subprocess.run(["git", "-C", str(self.repo), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q",
                        "--allow-empty", "-m", "init"], check=True)
        wt = Path(self.tmp.name) / "wt"
        subprocess.run(["git", "-C", str(self.repo), "worktree", "add", "-q", str(wt), "-b", "x"], check=True)
        self.assertIs(self.available("main-skill", wt), True)
        # With its own .claude/skills, the worktree no longer gets the main checkout's.
        self.skill(wt / ".claude" / "skills", "wt-skill")
        self.assertIs(self.available("main-skill", wt), False)
        self.assertIs(self.available("wt-skill", wt), True)

    def test_a_managed_skill_is_found(self):
        self.skill(self.managed / ".claude" / "skills", "policy-skill")
        self.assertIs(self.available("policy-skill"), True)

    def test_installed_and_synced_plugin_skills_are_found(self):
        plugin = self.config / "plugins" / "cache" / "market" / "tools" / "1.0.0"
        self.skill(plugin / "skills", "from-cache")
        elsewhere = Path(self.tmp.name) / "installed-elsewhere"
        self.skill(elsewhere / "skills", "from-install-path")
        (self.config / "plugins" / "installed_plugins.json").write_text(json.dumps(
            {"version": 2, "plugins": {"x@y": [{"scope": "user", "installPath": str(elsewhere)}]}}))
        self.skill(self.config / "plugins" / "synced" / "org_1" / "helpers~g2" / "skills", "from-synced")
        for name in ("from-cache", "from-install-path", "from-synced"):
            self.assertIs(self.available(name), True, name)

    def test_a_plugin_that_is_only_in_a_marketplace_is_not_installed(self):
        self.skill(self.config / "plugins" / "marketplaces" / "official" / "plugins" / "p" / "skills", "not-installed")
        self.assertIs(self.available("not-installed"), False)

    def test_legacy_commands_are_found(self):
        (self.config / "commands").mkdir()
        (self.config / "commands" / "user-cmd.md").write_text("Do it.\n")
        (self.repo / ".claude" / "commands").mkdir(parents=True)
        (self.repo / ".claude" / "commands" / "project-cmd.md").write_text("Do it.\n")
        self.assertIs(self.available("user-cmd"), True)
        self.assertIs(self.available("project-cmd", self.project), True)
        self.assertIs(self.available("project-cmd"), False)

    def test_a_name_with_a_colon_or_slash_cannot_be_told(self):
        self.skill(self.config / "skills", "docx")
        for name in ("anthropic-skills:docx", "plugin:skill", "apps/web:deploy", "a/b", ""):
            self.assertIsNone(self.available(name), name)

    def test_the_places_named_in_a_refusal_include_the_project(self):
        places = claude_bg.skill_places(str(self.project))
        self.assertIn(str(self.config / "skills"), places)
        self.assertIn(str(self.project / ".claude" / "skills"), places)
        self.assertIn(str(self.repo / ".claude" / "skills"), places)
        self.assertNotIn(str(self.project / ".claude" / "skills"), claude_bg.skill_places())


if __name__ == "__main__":
    unittest.main()
