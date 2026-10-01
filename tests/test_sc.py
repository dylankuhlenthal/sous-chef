"""Behaviour tests for sc, run against the real command line with the fake runtime.

Run: python3 -m unittest discover -s tests
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import core_paths
from sc_under_test import CODE, IS_PYTHON, REPO, SC, SOUSCHEF, python_only  # noqa: F401
from stored_values import LEGACY_OWNER


class ScTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        self.work = Path(self.tmp.name) / "work"
        self.home.mkdir()
        self.work.mkdir()
        # The owner every test runs as, unless it says otherwise (owner.json, `sc owner set`).
        (self.home / "owner.json").write_text(json.dumps({"name": "Alex", "branch_prefix": "alx/"}))
        self.clock = 1_800_000_000.0
        self.base_env = {k: v for k, v in os.environ.items()
                         if not k.startswith(("SC_", "CLAUDE_CODE_SESSION_ID"))}
        self.base_env.update({"SC_TEST_HOME": str(self.home), "SC_CHEF_RUNTIME": "fake", "SC_IDENTITY_WAIT": "0"})

    def tearDown(self):
        self.tmp.cleanup()

    def sc(self, *args, stdin=None, env=None, ok=True):
        e = {**self.base_env, "SC_FAKE_NOW": str(self.clock), **(env or {})}
        out = subprocess.run([str(SC), *args], input=stdin, capture_output=True, text=True, env=e)
        if ok and out.returncode != 0:
            self.fail(f"sc {' '.join(args)} failed ({out.returncode}): {out.stdout}{out.stderr}")
        return out

    def spawn(self, kind="general", title="Test task", task="do the thing"):
        out = self.sc("spawn", "--kind", kind, "--title", title, "--cwd", str(self.work),
                      "--runtime", "fake", stdin=task)
        return out.stdout.split()[1]

    def user_kind(self, name, waiting="agent", extra="", body="Do the task.", description=None):
        """Write a kind into the test home's kinds/ (the user kinds folder) and return its name."""
        (self.home / "kinds").mkdir(exist_ok=True)
        (self.home / "kinds" / f"{name}.md").write_text(
            f"---\ndescription: {description or name + ' kind'}\nstarts_waiting_on: {waiting}\n{extra}---\n{body}\n")
        return name

    def owner_kind(self):
        """A test kind whose sessions start waiting on the owner in bypass mode, like a shaping kind."""
        return self.user_kind("pairing", waiting="owner", extra="permissions: bypass\n",
                              description="pair on an idea with {{owner}}")

    def fake_skills(self, missing=(), unknown=()):
        """Tell the fake runtime which skills are missing (False) or cannot be told (None)."""
        path = self.home / "state" / "fake-runtime.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        data = json.loads(path.read_text()) if path.exists() else {"sessions": {}, "wakes": []}
        data.update({"missing_skills": list(missing), "unknown_skills": list(unknown)})
        path.write_text(json.dumps(data))

    def as_session(self, sid, *args, ok=True, claude_sid=None):
        env = {"CLAUDE_CODE_SESSION_ID": claude_sid or f"fake-{sid}"}
        return self.sc(*args, env=env, ok=ok)

    def fake_state(self):
        return json.loads((self.home / "state" / "fake-runtime.json").read_text())

    def set_fake(self, sid, **fields):
        data = self.fake_state()
        data["sessions"][sid].update(fields)
        (self.home / "state" / "fake-runtime.json").write_text(json.dumps(data))

    def events(self, sid):
        path = self.home / "state" / "sessions" / sid / "events.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()]

    def register_chef(self):
        self.sc("hook", "chef-start", stdin=json.dumps({"session_id": "chef-1", "source": "startup"}),
                env={"SC_WATCH_DISABLE_ENSURE": "1"})

    def hook(self, name, sid):
        self.sc("hook", name, "--session", sid, stdin="{}")


class SpawnTests(ScTestCase):
    def test_spawn_writes_record_brief_and_launched_event(self):
        sid = self.spawn(kind=self.owner_kind(), title="Companybrain idea", task="shape the companybrain idea")
        sdir = self.home / "state" / "sessions" / sid
        rec = json.loads((sdir / "record.json").read_text())
        self.assertEqual(rec["kind"], "pairing")
        self.assertEqual(rec["handle"]["session_id"], f"fake-{sid}")
        brief = (sdir / "brief.md").read_text()
        self.assertIn("shape the companybrain idea", brief)
        self.assertIn("Never merge into `main` or `staging`", brief)
        self.assertNotIn("{{", brief)
        self.assertEqual(self.events(sid)[0]["state"], "launched")
        self.assertIn("waiting on: alex", self.sc("sessions").stdout)

    def test_spawn_passes_identity_env_and_hooks_to_the_runtime(self):
        sid = self.spawn()
        launched = self.fake_state()["sessions"][sid]
        self.assertNotIn("SC_SESSION_ID", launched["env"])
        self.assertIn(str(CODE / "bin"), launched["env"]["PATH"].split(":"))
        self.assertEqual(sorted(launched["settings"]["hooks"]),
                         ["PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"])

    def test_spawn_refuses_sous_chef_folder_empty_task_and_unknown_kind(self):
        out = self.sc("spawn", "--kind", "general", "--title", "x", "--cwd", str(self.home),
                      "--runtime", "fake", stdin="task", ok=False)
        self.assertIn("inside the sous chef data folder", out.stderr)
        out = self.sc("spawn", "--kind", "general", "--title", "x", "--cwd", str(CODE / "kinds"),
                      "--runtime", "fake", stdin="task", ok=False)
        self.assertIn("inside the sous chef code folder", out.stderr)
        out = self.sc("spawn", "--kind", "general", "--title", "x", "--cwd", str(self.work),
                      "--runtime", "fake", stdin="", ok=False)
        self.assertIn("task text is empty", out.stderr)
        out = self.sc("spawn", "--kind", "nope", "--title", "x", "--cwd", str(self.work),
                      "--runtime", "fake", stdin="task", ok=False)
        self.assertIn("unknown kind", out.stderr)


class PermissionsTests(ScTestCase):
    def record(self, sid):
        return json.loads((self.home / "state" / "sessions" / sid / "record.json").read_text())

    def test_spawn_defaults_to_auto_and_records_it(self):
        sid = self.spawn()
        self.assertEqual(self.record(sid)["permissions"], "auto")
        self.assertEqual(self.fake_state()["sessions"][sid]["permissions"], "auto")
        self.assertIn("permissions: auto", self.sc("status", sid).stdout)

    def test_a_chosen_permission_reaches_the_runtime_and_survives_stop_and_resume(self):
        out = self.sc("spawn", "--kind", "general", "--title", "fresh dir", "--cwd", str(self.work),
                      "--runtime", "fake", "--permissions", "bypass", stdin="build it")
        self.assertIn("permissions: bypass", out.stdout)
        sid = out.stdout.split()[1]
        self.assertEqual(self.record(sid)["permissions"], "bypass")
        self.assertEqual(self.fake_state()["sessions"][sid]["permissions"], "bypass")
        self.sc("stop", sid)
        self.sc("resume", sid)
        self.assertEqual(self.record(sid)["permissions"], "bypass")
        self.assertEqual(self.fake_state()["sessions"][sid]["permissions"], "bypass")
        self.assertIn("permissions: bypass", self.sc("status", sid).stdout)

    def test_an_unknown_permission_is_refused_and_nothing_is_launched(self):
        out = self.sc("spawn", "--kind", "general", "--title", "x", "--cwd", str(self.work),
                      "--runtime", "fake", "--permissions", "bypassPermissions", stdin="t", ok=False)
        self.assertIn("invalid choice", out.stderr)
        self.assertFalse((self.home / "state" / "fake-runtime.json").exists())


class CodeCopyTestCase(ScTestCase):
    """Runs a copy of the core's code (core_paths.copy_code) in a temporary code root, so a test
    can give it its own core kinds without depending on the shipped ones."""

    def setUp(self):
        super().setUp()
        self.code = core_paths.copy_code(Path(self.tmp.name) / "code", root=CODE)

    def copy_sc(self, *args, stdin=None, ok=True, env=None):
        env = {**self.base_env, "SC_FAKE_NOW": str(self.clock), **(env or {})}
        out = subprocess.run([str(self.code / "bin" / "sc"), *args], input=stdin, capture_output=True,
                             text=True, env=env)
        if ok and out.returncode != 0:
            self.fail(f"sc {' '.join(args)} failed ({out.returncode}): {out.stdout}{out.stderr}")
        return out


class KindPermissionsTests(CodeCopyTestCase):
    """A kind's `permissions` front matter sets the default for its sessions; `--permissions` overrides it.
    These run a copy of the code with their own kind files, so they do not depend on the shipped kinds."""

    def setUp(self):
        super().setUp()
        self.write_kind("loose", "permissions: bypass\n")
        self.write_kind("careful", "permissions: auto\n")
        self.write_kind("plain", "")

    def write_kind(self, name, extra):
        (self.code / "kinds" / f"{name}.md").write_text(
            f"---\ndescription: {name} kind\nstarts_waiting_on: agent\n{extra}---\nDo the task.\n")

    def spawn_kind(self, kind, *flags):
        out = self.copy_sc("spawn", "--kind", kind, "--title", "t", "--cwd", str(self.work),
                           "--runtime", "fake", *flags, stdin="do it")
        sid = out.stdout.split()[1]
        return json.loads((self.home / "state" / "sessions" / sid / "record.json").read_text())["permissions"], sid

    def test_a_kinds_permissions_is_the_default_for_its_sessions(self):
        perms, sid = self.spawn_kind("loose")
        self.assertEqual(perms, "bypass")
        self.assertEqual(self.fake_state()["sessions"][sid]["permissions"], "bypass")

    def test_an_explicit_flag_overrides_the_kind_both_ways(self):
        self.assertEqual(self.spawn_kind("loose", "--permissions", "auto")[0], "auto")
        self.assertEqual(self.spawn_kind("careful", "--permissions", "bypass")[0], "bypass")

    def test_a_kind_without_the_field_keeps_the_global_default(self):
        self.assertEqual(self.spawn_kind("plain")[0], "auto")
        self.assertEqual(self.spawn_kind("plain", "--permissions", "ask")[0], "ask")
        self.assertNotIn("permissions", [l for l in self.copy_sc("kinds", "--runtime", "fake").stdout.splitlines()
                                         if l.startswith("plain")][0])

    def test_sc_kinds_shows_a_kinds_permissions(self):
        line = [l for l in self.copy_sc("kinds", "--runtime", "fake").stdout.splitlines() if l.startswith("loose")][0]
        self.assertIn("(permissions: bypass)", line)

    def test_an_unknown_value_in_a_kind_is_refused_when_loaded_or_listed(self):
        self.write_kind("broken", "permissions: bypassPermissions\n")
        out = self.copy_sc("spawn", "--kind", "broken", "--title", "t", "--cwd", str(self.work),
                           "--runtime", "fake", stdin="do it", ok=False)
        self.assertIn("kinds/broken.md: permissions must be one of", out.stderr)
        self.assertFalse((self.home / "state" / "fake-runtime.json").exists())
        out = self.copy_sc("kinds", "--runtime", "fake", ok=False)
        self.assertIn("kinds/broken.md: permissions must be one of", out.stderr)

    def test_the_core_ships_only_general_and_investigate_neither_in_bypass(self):
        """Run against the core as published: the owner's kinds are theirs, in my/kinds (decision 0020)."""
        self.assertEqual(core_paths.core_kind_names(), ["general", "investigate"])
        code = core_paths.copy_code(Path(self.tmp.name) / "core", root=CODE)
        out = subprocess.run([str(code / "bin" / "sc"), "kinds", "--runtime", "fake"], capture_output=True,
                             text=True, env={**self.base_env, "SC_FAKE_NOW": str(self.clock)}).stdout.splitlines()
        self.assertEqual([l.split()[0] for l in out if l and l[0] != " "], ["general", "investigate"])
        for line in out:
            self.assertNotIn("bypass", line)


class UserKindsTests(ScTestCase):
    """Kinds come from the user kinds folder (kinds/ under the data home) first, then the core's kinds/."""

    def brief(self, sid):
        return (self.home / "state" / "sessions" / sid / "brief.md").read_text()

    def listed(self):
        return [l.split()[0] for l in self.sc("kinds", "--runtime", "fake").stdout.splitlines() if l and l[0] != " "]

    def test_a_user_kind_replaces_the_core_kind_of_the_same_name(self):
        self.user_kind("general", body="The user's own general instructions.")
        sid = self.spawn(kind="general")
        self.assertIn("The user's own general instructions.", self.brief(sid))
        self.assertNotIn("Do the task as described.", self.brief(sid))
        self.assertEqual(self.listed().count("general"), 1)

    def test_a_user_only_kind_is_listed_and_spawns(self):
        self.user_kind("triage", body="Triage the thing.")
        self.assertIn("triage", self.listed())
        self.assertIn("general", self.listed())
        self.assertIn("Triage the thing.", self.brief(self.spawn(kind="triage")))

    def test_a_kind_name_that_is_not_kebab_case_is_an_unknown_kind(self):
        (self.home / "kinds").mkdir()
        (self.home / "kinds" / "Bad_Name.md").write_text("---\ndescription: x\n---\nx\n")
        (self.work / "outside.md").write_text("---\ndescription: outside\n---\nx\n")
        self.assertNotIn("Bad_Name", self.listed())
        for name in ("Bad_Name", "../work/outside", "../kinds/general", "general/", "x.y", ""):
            out = self.sc("spawn", "--kind", name, "--title", "x", "--cwd", str(self.work),
                          "--runtime", "fake", stdin="task", ok=False)
            self.assertIn("unknown kind", out.stderr, name)
        self.assertFalse((self.home / "state" / "sessions").exists())


class KindSkillTests(ScTestCase):
    """A kind may declare the skill it runs; `sc spawn` refuses when the runtime says it is missing."""

    def spawn_out(self, kind, runtime="fake", env=None, ok=True):
        return self.sc("spawn", "--kind", kind, "--title", "t", "--cwd", str(self.work), "--runtime", runtime,
                       stdin="do it", env=env, ok=ok)

    def test_a_missing_skill_is_refused_before_anything_is_written(self):
        self.user_kind("drafting", extra="skill: draft-it\n", body="Run the `/draft-it` skill.")
        self.fake_skills(missing=["draft-it"])
        out = self.spawn_out("drafting", ok=False)
        self.assertIn("kind 'drafting' needs the skill 'draft-it', which is not in your skills", out.stderr)
        self.assertIn(f"add your own version of the kind in {self.home / 'kinds'}", out.stderr)
        self.assertFalse((self.home / "state" / "sessions").exists())
        self.assertEqual(self.fake_state()["sessions"], {})
        self.assertIn("Nothing waiting.", self.sc("summary").stdout)

    def test_a_skill_that_is_found_or_cannot_be_told_launches(self):
        self.user_kind("drafting", extra="skill: draft-it\n", body="Run the `/draft-it` skill.")
        self.user_kind("namespaced", extra="skill: team:draft\n", body="Run the `/team:draft` skill.")
        self.fake_skills(unknown=["team:draft"])
        self.spawn(kind="drafting")
        self.spawn(kind="namespaced")
        self.assertEqual(len(self.fake_state()["sessions"]), 2)
        # The check is made with the session's own working directory.
        self.assertIn(["draft-it", str(self.work.resolve())], self.fake_state()["skill_checks"])

    def test_a_kind_without_a_skill_is_not_checked(self):
        self.spawn()
        self.assertEqual(self.fake_state().get("skill_checks", []), [])

    def test_a_skill_value_with_a_slash_or_space_is_refused(self):
        for value in ("/draft-it", "draft it"):
            self.user_kind("drafting", extra=f"skill: {value}\n")
            out = self.spawn_out("drafting", ok=False)
            self.assertIn(f"{self.home / 'kinds' / 'drafting.md'}: skill must be a bare skill name", out.stderr)

    def test_the_claude_runtime_refuses_a_skill_that_is_not_on_disk_without_running_claude(self):
        config = Path(self.tmp.name) / "claude-config"
        (config / "skills" / "present-skill").mkdir(parents=True)
        (config / "skills" / "present-skill" / "SKILL.md").write_text("---\nname: present-skill\n---\nx\n")
        self.user_kind("drafting", extra="skill: zz-no-such-skill-for-tests\n")
        out = self.spawn_out("drafting", runtime="claude-bg", env={"CLAUDE_CONFIG_DIR": str(config)}, ok=False)
        self.assertIn("needs the skill 'zz-no-such-skill-for-tests'", out.stderr)
        self.assertIn(str(config / "skills"), out.stderr)
        self.assertFalse((self.home / "state" / "sessions").exists())


class KindListingTests(ScTestCase):
    """What `sc kinds` shows about a kind's skill and where the kind comes from."""

    def line(self, name, out=None):
        out = out if out is not None else self.sc("kinds", "--runtime", "fake").stdout
        return [l for l in out.splitlines() if l.startswith(name + " ")][0]

    def test_a_declared_skill_is_shown_and_marked_when_missing(self):
        self.user_kind("drafting", extra="skill: draft-it\n", body="Run the `/draft-it` skill.")
        self.assertTrue(self.line("drafting").endswith("  skill: draft-it  [user]"))
        self.fake_skills(missing=["draft-it"])
        self.assertIn("skill: draft-it (not found in your skills)  [user]", self.line("drafting"))
        self.assertNotIn("skill", self.line("general"))
        # No working directory: only what every session gets is checked.
        self.assertIn(["draft-it", None], self.fake_state()["skill_checks"])

    def test_user_kinds_are_marked_and_an_override_says_so(self):
        self.user_kind("triage")
        self.user_kind("general", body="Mine.")
        self.assertTrue(self.line("triage").endswith("[user]"))
        self.assertTrue(self.line("general").endswith("[user, replaces core]"))
        self.assertFalse(self.line("investigate").endswith("]"))

    def test_a_kind_whose_instructions_never_name_its_skill_gets_a_warning(self):
        self.user_kind("drafting", extra="skill: draft-it\n", body="Run the `/draft-it` skill.")
        self.user_kind("drifted", extra="skill: draft-it\n", body="Run the `/old-name` skill.")
        out = self.sc("kinds", "--runtime", "fake").stdout
        warnings = [l for l in out.splitlines() if l.startswith("  warning:")]
        self.assertEqual(warnings, [f"  warning: {self.home / 'kinds' / 'drifted.md'} declares the skill 'draft-it' "
                                    f"but its instructions never name /draft-it; make them match"])

    def test_a_longer_skill_name_in_the_instructions_does_not_count(self):
        self.user_kind("shaping", extra="skill: shape\n", body="Run the `/shape-gui` skill.")
        self.user_kind("namespaced", extra="skill: shape\n", body="Run `/shape:deep`.")
        self.user_kind("ends", extra="skill: shape\n", body="Run /shape.")
        out = self.sc("kinds", "--runtime", "fake").stdout
        self.assertIn("shaping.md declares the skill 'shape'", out)
        self.assertIn("namespaced.md declares the skill 'shape'", out)
        self.assertNotIn("ends.md", out)

    def test_the_shipped_kinds_that_declare_a_skill_name_it_in_their_instructions(self):
        self.assertNotIn("warning", self.sc("kinds", "--runtime", "fake").stdout)

    def test_the_claude_runtime_checks_the_user_skills_folder(self):
        config = Path(self.tmp.name) / "claude-config"
        (config / "skills" / "draft-it").mkdir(parents=True)
        (config / "skills" / "draft-it" / "SKILL.md").write_text("---\nname: draft-it\n---\nx\n")
        self.user_kind("drafting", extra="skill: draft-it\n", body="Run `/draft-it`.")
        self.user_kind("missing", extra="skill: zz-no-such-skill-for-tests\n", body="Run `/zz-no-such-skill-for-tests`.")
        out = self.sc("kinds", "--runtime", "claude-bg", env={"CLAUDE_CONFIG_DIR": str(config)}).stdout
        self.assertIn("skill: draft-it  [user]", self.line("drafting", out))
        self.assertIn("skill: zz-no-such-skill-for-tests (not found in your skills)", self.line("missing", out))


class SameFolderKindsTests(CodeCopyTestCase):
    """When sous chef's data home is its code root (how the owner runs it: no SC_TEST_HOME),
    `sc kinds` lists each kind in kinds/ once and every one of them can be spawned."""

    def test_each_kind_is_listed_once_and_spawns(self):
        import shutil
        shutil.copy(self.home / "owner.json", self.code / "owner.json")
        env = {"SC_TEST_HOME": str(self.code)}
        shipped = sorted(p.stem for p in (self.code / "kinds").glob("*.md"))
        listed = [l.split()[0] for l in self.copy_sc("kinds", "--runtime", "fake", env=env).stdout.splitlines() if l and l[0] != " "]
        self.assertEqual(listed, shipped)
        self.assertNotIn("[user", self.copy_sc("kinds", "--runtime", "fake", env=env).stdout)
        for name in shipped:
            out = self.copy_sc("spawn", "--kind", name, "--title", "t", "--cwd", str(self.work),
                               "--runtime", "fake", stdin="do it", env=env)
            sid = out.stdout.split()[1]
            record = json.loads((self.code / "state" / "sessions" / sid / "record.json").read_text())
            self.assertEqual(record["kind"], name)

    def test_a_refusal_says_to_change_the_kind_file_when_there_is_no_separate_user_kinds_folder(self):
        import shutil
        shutil.copy(self.home / "owner.json", self.code / "owner.json")
        (self.code / "kinds" / "drafting.md").write_text(
            "---\ndescription: d\nstarts_waiting_on: agent\nskill: draft-it\n---\nRun `/draft-it`.\n")
        (self.code / "state").mkdir()
        (self.code / "state" / "fake-runtime.json").write_text(
            json.dumps({"sessions": {}, "wakes": [], "missing_skills": ["draft-it"]}))
        out = self.copy_sc("spawn", "--kind", "drafting", "--title", "t", "--cwd", str(self.work), "--runtime", "fake",
                           stdin="do it", env={"SC_TEST_HOME": str(self.code)}, ok=False)
        self.assertRegex(out.stderr, r"Install it, or change the kind file \S*/code/kinds/drafting\.md\.")
        self.assertNotIn("add your own version", out.stderr)


class SetupTests(CodeCopyTestCase):
    """`install.sh` and `sc setup`, run from a copy of the core with every question answered by a flag."""

    GIT_ENV = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
               "GIT_COMMITTER_EMAIL": "t@t", "GIT_CONFIG_GLOBAL": "/dev/null"}

    def setUp(self):
        super().setUp()
        self.data = Path(self.tmp.name) / "data"
        self.bin = Path(self.tmp.name) / "localbin"
        self.stubs = Path(self.tmp.name) / "stubs"
        self.stubs.mkdir()
        (self.stubs / "claude").write_text("#!/bin/sh\nexit 0\n")
        (self.stubs / "claude").chmod(0o755)
        self.env = {"SC_TEST_HOME": "", **self.GIT_ENV, "PATH": f"{self.stubs}:{os.environ['PATH']}"}

    def install(self, *flags, ok=True, env=None):
        args = ["--data", str(self.data), "--bin-dir", str(self.bin), "--yes", *flags]
        out = subprocess.run([str(self.code / "install.sh"), *args], capture_output=True, text=True,
                             env={**self.base_env, **self.env, **(env or {})}, stdin=subprocess.DEVNULL)
        if ok and out.returncode != 0:
            self.fail(f"install.sh failed ({out.returncode}): {out.stdout}{out.stderr}")
        return out

    def git(self, folder, *args):
        return subprocess.run(["git", "-C", str(folder), *args], capture_output=True, text=True,
                              env={**os.environ, **self.GIT_ENV}, check=True).stdout

    def test_a_new_data_folder_in_git_gets_starter_files_links_and_one_commit(self):
        out = self.install("--name", "Sam", "--branch-prefix", "sam/", "--git").stdout
        self.assertIn("made a new data folder", out)
        self.assertEqual(os.readlink(self.code / "my"), str(self.data))
        self.assertEqual(json.loads((self.data / "owner.json").read_text()), {"name": "Sam", "branch_prefix": "sam/"})
        for rel in ("memory/focus.md", "memory/threads/index.md", "memory/working-with-sam.md",
                    "instructions.md", "worker-instructions.md", ".gitignore"):
            self.assertTrue((self.data / rel).is_file(), rel)
        self.assertTrue((self.data / "cron").is_dir() and (self.data / "kinds").is_dir())
        self.assertEqual(len(self.git(self.data, "log", "--oneline").splitlines()), 1)
        self.assertEqual(os.readlink(self.bin / "sc"), str(self.code.resolve() / "bin" / "sc"))
        self.assertEqual(os.readlink(self.bin / "souschef"), str(self.code.resolve() / "bin" / "souschef"))
        settings = json.loads((self.code / ".agents" / "settings.local.json").read_text())
        self.assertEqual(settings["permissions"]["additionalDirectories"], [str(self.data.resolve())])
        # The installed sous chef runs on it: the summary opens with the owner and their instructions.
        summary = self.copy_sc("summary", env=self.env).stdout
        self.assertTrue(summary.startswith("Owner: Sam. Branch prefix: sam/."))
        self.assertIn("- My feedback on how you work is in `my/memory/working-with-sam.md`.", summary)
        self.assertNotIn("<!--", summary)
        (self.data / "state").mkdir(exist_ok=True)
        (self.data / "state" / "x.json").write_text("{}")
        (self.data / ".env").write_text("SC_RELAY_KEY=secret\n")
        self.assertEqual(self.git(self.data, "status", "--porcelain"), "")
        # A starter worker-instructions.md holds only a comment, so briefs leave the section out.
        sid = self.copy_sc("spawn", "--kind", "general", "--title", "t", "--cwd", str(self.work), "--runtime",
                           "fake", stdin="do it", env=self.env).stdout.split()[1]
        self.assertNotIn("Instructions from your owner", (self.data / "state" / "sessions" / sid / "brief.md").read_text())

    def test_a_new_data_folder_without_git(self):
        self.install("--name", "Sam", "--branch-prefix", "", "--no-git")
        self.assertFalse((self.data / ".git").exists())
        self.assertTrue((self.data / "memory" / "focus.md").is_file())

    def test_a_new_folder_needs_an_owner_name_when_nothing_can_be_asked(self):
        out = self.install("--no-git", ok=False)
        self.assertIn("pass --name", out.stderr)
        self.assertFalse((self.code / "my").is_symlink())

    def test_an_existing_data_folder_is_used_as_it_is(self):
        (self.data / "memory").mkdir(parents=True)
        (self.data / "memory" / "focus.md").write_text("mine\n")
        (self.data / "owner.json").write_text(json.dumps({"name": "Kim", "branch_prefix": "kim/"}))
        out = self.install("--name", "Other").stdout
        self.assertIn("using the data folder", out)
        self.assertEqual(json.loads((self.data / "owner.json").read_text())["name"], "Kim")
        self.assertFalse((self.data / "instructions.md").exists())
        self.assertEqual((self.data / "memory" / "focus.md").read_text(), "mine\n")
        self.assertEqual(os.readlink(self.code / "my"), str(self.data))

    def test_a_data_folder_cloned_from_a_repo_keeps_its_owner(self):
        src, bare = Path(self.tmp.name) / "src", Path(self.tmp.name) / "data.git"
        (src / "memory").mkdir(parents=True)
        (src / "owner.json").write_text(json.dumps({"name": "Kim", "branch_prefix": "kim/"}))
        (src / "memory" / "focus.md").write_text("cloned\n")
        self.git(src, "init", "-q", "-b", "main")
        self.git(src, "add", "-A")
        self.git(src, "commit", "-qm", "data")
        self.git(Path(self.tmp.name), "clone", "-q", "--bare", str(src), str(bare))
        out = self.install("--clone", str(bare)).stdout
        self.assertIn(f"cloned {bare}", out)
        self.assertEqual((self.data / "memory" / "focus.md").read_text(), "cloned\n")
        self.assertIn("Owner: Kim.", self.copy_sc("summary", env=self.env).stdout)

    def test_a_new_git_data_folder_can_be_pushed_to_an_empty_repo(self):
        bare = Path(self.tmp.name) / "empty.git"
        self.git(Path(self.tmp.name), "init", "-q", "--bare", str(bare))
        self.install("--name", "Sam", "--git", "--push-url", str(bare))
        self.assertEqual(self.git(bare, "log", "--oneline", "main").count("\n"), 1)
        self.assertEqual(self.git(self.data, "rev-parse", "--abbrev-ref", "@{upstream}").strip(), "origin/main")

    def test_a_folder_inside_another_repo_is_never_pushed_as_that_repo(self):
        outer, bare = Path(self.tmp.name) / "notes", Path(self.tmp.name) / "empty.git"
        self.git(Path(self.tmp.name), "init", "-q", "--bare", str(bare))
        (outer / "private.txt").parent.mkdir()
        (outer / "private.txt").write_text("not for the data repo\n")
        self.git(outer, "init", "-q", "-b", "main")
        self.git(outer, "add", "-A")
        self.git(outer, "commit", "-qm", "outer")
        self.data = outer / "sous-chef-data"
        (self.data / "memory").mkdir(parents=True)
        (self.data / "owner.json").write_text(json.dumps({"name": "Kim", "branch_prefix": "kim/"}))
        self.install("--push-url", str(bare))
        self.assertEqual(self.git(outer, "remote"), "")
        self.assertEqual(self.git(bare, "for-each-ref"), "")

    def test_running_it_again_changes_nothing(self):
        self.install("--name", "Sam", "--git")
        before = {p: p.read_bytes() for p in self.data.rglob("*") if p.is_file() and ".git" not in p.parts}
        out = self.install().stdout
        self.assertIn("using the data folder", out)
        self.assertNotIn("linked", out)
        self.assertEqual({p: p.read_bytes() for p in self.data.rglob("*") if p.is_file() and ".git" not in p.parts},
                         before)
        self.assertEqual(len(self.git(self.data, "log", "--oneline").splitlines()), 1)

    def test_a_link_that_points_somewhere_else_is_refused_and_left_alone(self):
        other = Path(self.tmp.name) / "other"
        other.mkdir()
        (self.code / "my").symlink_to(other)
        out = self.install("--name", "Sam", ok=False)
        self.assertIn(f"already points to {other}", out.stderr)
        self.assertEqual(os.readlink(self.code / "my"), str(other))
        self.assertFalse(self.data.exists())

    def test_install_names_the_tools_it_cannot_find(self):
        tools = Path(self.tmp.name) / "tools"
        tools.mkdir()
        for name in ("python3", "dirname", "git"):
            (tools / name).symlink_to(subprocess.run(["which", name], capture_output=True, text=True).stdout.strip())
        out = self.install("--name", "Sam", ok=False, env={"PATH": str(tools)})
        self.assertEqual(out.returncode, 1)
        self.assertIn("not found on your PATH: claude", out.stderr)
        self.assertFalse((self.code / "my").is_symlink())


class OwnerInstructionsTests(ScTestCase):
    """worker-instructions.md in the data folder reaches every session's brief, between the kind's
    instructions and the task; with no file, or an empty one, the section is left out."""

    def brief(self, sid):
        return (self.home / "state" / "sessions" / sid / "brief.md").read_text()

    def test_the_file_is_added_before_the_task_as_written(self):
        (self.home / "worker-instructions.md").write_text("Ask before writing to the tracker. {{owner}} {{task}}\n")
        brief = self.brief(self.spawn(task="the task"))
        section = "## Instructions from your owner\n\nAsk before writing to the tracker. {{owner}} {{task}}\n\n## Task"
        self.assertIn(section, brief)
        self.assertLess(brief.index("## Instructions for this kind of session"), brief.index(section))
        self.assertTrue(brief.endswith("## Task\n\nthe task\n"))

    def test_no_file_or_an_empty_one_leaves_the_section_out(self):
        without = self.brief(self.spawn())
        (self.home / "worker-instructions.md").write_text("\n  \n")
        empty = self.brief(self.spawn())
        for brief in (without, empty):
            self.assertNotIn("Instructions from your owner", brief)
            self.assertNotIn("{{", brief)
            self.assertNotIn("\n\n\n", brief)

    def test_a_cron_launched_session_gets_it_too(self):
        (self.home / "worker-instructions.md").write_text("Owner rule for every session.\n")
        self.register_chef()
        self.sc("cron", "add", "scan", "--every", "6h", "--target", "worker", "--kind", "general",
                "--cwd", str(self.work), "--runtime", "fake", stdin="scan it")
        self.sc("cron", "run", "scan")
        [sid] = [line.split()[1] for line in self.sc("sessions").stdout.splitlines() if line.startswith("- ")]
        self.assertIn("## Instructions from your owner\n\nOwner rule for every session.", self.brief(sid))


class DataLinkTests(CodeCopyTestCase):
    """Without SC_TEST_HOME, sous chef finds the owner's data through the `my` link in the code folder,
    and refuses, saying what to run, when the link is missing or broken."""

    def setUp(self):
        super().setUp()
        self.data = self.home  # the test home is set up like a data folder (owner.json)
        self.env = {"SC_TEST_HOME": ""}

    def link(self, target=None):
        (self.code / "my").symlink_to(target or self.data)

    def test_the_link_is_used_and_paths_go_through_it(self):
        self.link()
        self.assertIn("Alex", self.copy_sc("owner", env=self.env).stdout)
        out = self.copy_sc("spawn", "--kind", "general", "--title", "t", "--cwd", str(self.work),
                           "--runtime", "fake", stdin="do it", env=self.env)
        sid = out.stdout.split()[1]
        self.assertTrue((self.data / "state" / "sessions" / sid / "brief.md").is_file())
        brief = (self.data / "state" / "sessions" / sid / "brief.md").read_text()
        self.assertIn(f"{self.code}/my/state/sessions/{sid}/report.md", brief)
        self.assertFalse((self.code / "state").exists())

    def test_a_broken_link_is_refused_naming_its_target(self):
        self.link(Path(self.tmp.name) / "gone")
        out = self.copy_sc("sessions", env=self.env, ok=False)
        self.assertIn(f"points to {Path(self.tmp.name) / 'gone'}, which does not exist", out.stderr)
        self.assertFalse((Path(self.tmp.name) / "gone").exists())

    def test_no_link_says_to_run_the_install(self):
        out = self.copy_sc("sessions", env=self.env, ok=False)
        self.assertIn(f"no data folder: run {self.code.resolve()}/install.sh", out.stderr)
        self.assertFalse((self.code / "state").exists())

    def test_help_and_the_hooks_work_without_a_data_folder(self):
        self.assertIn("usage", self.copy_sc("--help", env=self.env).stdout)
        out = self.copy_sc("hook", "chef-start", stdin=json.dumps({"session_id": "c", "source": "startup"}),
                           env={**self.env, "SC_WATCH_DISABLE_ENSURE": "1"})
        ctx = json.loads(out.stdout)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("no data folder", ctx)
        self.assertNotIn("SOUS CHEF STARTUP SUMMARY", ctx)
        guarded = json.dumps({"tool_input": {"file_path": str(self.code / "state" / "chef.json")}})
        out = self.copy_sc("hook", "guard-edit", stdin=guarded, env=self.env).stdout
        self.assertEqual(json.loads(out)["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertEqual(self.copy_sc("hook", "chef-stop", stdin="{}", env=self.env).stdout, "")

    def test_the_guard_protects_state_through_the_link(self):
        self.link()
        for target in (self.code / "my" / "state" / "chef.json", self.data / "state" / "chef.json"):
            out = self.copy_sc("hook", "guard-edit", stdin=json.dumps({"tool_input": {"file_path": str(target)}}),
                               env=self.env).stdout
            self.assertEqual(json.loads(out)["hookSpecificOutput"]["permissionDecision"], "deny", target)

    def test_souschef_says_to_run_the_install(self):
        out = subprocess.run([str(self.code / "bin" / "souschef"), "--print"], capture_output=True, text=True,
                             env={**self.base_env, **self.env})
        self.assertEqual(out.returncode, 1)
        self.assertIn(f"no data folder: run {self.code.resolve()}/install.sh", out.stderr)

    def test_a_session_may_not_run_in_the_data_folder(self):
        self.link()
        out = self.copy_sc("spawn", "--kind", "general", "--title", "t", "--cwd", str(self.data),
                           "--runtime", "fake", stdin="do it", env=self.env, ok=False)
        self.assertIn("cannot run inside the sous chef data folder", out.stderr)


class ReportTests(ScTestCase):
    def test_report_requires_a_claude_session(self):
        out = self.sc("report", "done", "finished", ok=False)
        self.assertIn("CLAUDE_CODE_SESSION_ID is not set", out.stderr)

    def test_report_refuses_a_claude_session_sous_chef_did_not_launch(self):
        self.spawn()
        out = self.sc("report", "done", "x", env={"CLAUDE_CODE_SESSION_ID": "someone-else"}, ok=False)
        self.assertIn("is not one sous chef launched", out.stderr)

    def test_stale_session_variable_from_a_spare_process_is_ignored(self):
        first = self.spawn(title="first")
        second = self.spawn(title="second")
        self.sc("report", "done", "second finished",
                env={"SC_SESSION_ID": first, "CLAUDE_CODE_SESSION_ID": f"fake-{second}"})
        self.assertEqual(self.events(second)[-1]["text"], "second finished")
        self.assertEqual(self.events(first)[-1]["state"], "launched")

    def test_needs_decision_gets_a_key_and_wakes_chef(self):
        self.register_chef()
        sid = self.spawn()
        out = self.as_session(sid, "report", "needs-decision", "red or blue?")
        self.assertIn("key q2", out.stdout)
        self.assertIn(["chef", f"sous chef: session {sid} reported needs-decision. Run `sc events`."],
                      self.fake_state()["wakes"])

    def test_working_and_note_do_not_wake_chef(self):
        self.register_chef()
        sid = self.spawn()
        self.as_session(sid, "report", "working", "building now")
        self.as_session(sid, "report", "note", "fyi")
        self.assertEqual([w for w in self.fake_state()["wakes"] if w[0] == "chef"], [])

    def test_unknown_state_and_resolved_without_key_are_refused(self):
        sid = self.spawn()
        self.assertIn("unknown state", self.as_session(sid, "report", "finished", "x", ok=False).stderr)
        self.assertIn("needs --key", self.as_session(sid, "report", "resolved", ok=False).stderr)

    def test_a_question_reported_as_a_note_is_refused_and_writes_nothing(self):
        sid = self.spawn()
        out = self.as_session(sid, "report", "note",
                              "needs-decision raised: red or blue? sent sous chef my recommendation",
                              ok=False)
        self.assertIn("reads like a question", out.stderr)
        self.assertIn("sc report needs-decision", out.stderr)
        self.assertEqual([e["state"] for e in self.events(sid)], ["launched"])

    def test_the_note_refusal_matches_the_spaced_spelling_and_ignores_case(self):
        sid = self.spawn()
        for text in ("Needs Decision: which database?", "NEEDS-DECISION on the schema"):
            self.assertIn("reads like a question",
                          self.as_session(sid, "report", "note", text, ok=False).stderr)

    def test_an_ordinary_note_is_still_accepted(self):
        sid = self.spawn()
        self.as_session(sid, "report", "note", "the staging deploy finished while I was reading")
        self.assertEqual(self.events(sid)[-1]["state"], "note")

    def test_only_notes_are_checked_for_questions(self):
        """A done report may legitimately recount the questions it raised."""
        sid = self.spawn()
        self.as_session(sid, "report", "done", "finished; raised one needs-decision on the way")
        self.assertEqual(self.events(sid)[-1]["state"], "done")


class EventsAndQuestionsTests(ScTestCase):
    def test_unread_events_repeat_until_acked(self):
        sid = self.spawn()
        self.as_session(sid, "report", "done", "PR https://example/pr/1")
        first = self.sc("events").stdout
        self.assertIn("done", first)
        self.assertIn("PR https://example/pr/1", self.sc("events").stdout)
        token = first.strip().splitlines()[-1].split("ack ")[1]
        self.sc("events", "ack", token)
        self.assertIn("No unread events.", self.sc("events").stdout)

    def test_events_written_by_sous_chef_are_not_shown_as_unread(self):
        self.spawn()
        self.assertIn("No unread events.", self.sc("events").stdout)

    def test_open_question_stays_listed_after_ack_until_resolved(self):
        sid = self.spawn()
        self.as_session(sid, "report", "needs-decision", "red or blue?")
        out = self.sc("events").stdout
        self.sc("events", "ack", out.strip().splitlines()[-1].split("ack ")[1])
        out = self.sc("events").stdout
        self.assertIn("OPEN QUESTIONS", out)
        self.assertIn("red or blue?", out)
        self.sc("send", sid, "--resolves", "q2", "blue")
        self.assertNotIn("OPEN QUESTIONS", self.sc("events").stdout)
        self.assertIn("waiting on: agent", self.sc("sessions").stdout)

    def test_resolving_an_unknown_key_is_refused_and_writes_nothing(self):
        sid = self.spawn()
        out = self.sc("send", sid, "--resolves", "nope", "answer", ok=False)
        self.assertIn("no open question with key 'nope'", out.stderr)
        self.assertFalse((self.home / "state" / "sessions" / sid / "inbox").exists())

    def test_session_can_resolve_its_own_question(self):
        sid = self.spawn()
        self.as_session(sid, "report", "blocked", "need a token", "--key", "token")
        self.as_session(sid, "report", "resolved", "--key", "token")
        self.assertNotIn("OPEN QUESTIONS", self.sc("events").stdout)

    def test_resolved_accepts_its_text_after_the_key(self):
        # The brief tells sessions to run exactly this form.
        sid = self.spawn()
        self.as_session(sid, "report", "blocked", "need a token", "--key", "token")
        self.as_session(sid, "report", "resolved", "--key", "token", "Alex", "answered", "here")
        self.assertEqual(self.events(sid)[-1]["text"], "Alex answered here")
        self.assertNotIn("OPEN QUESTIONS", self.sc("events").stdout)

    def test_positionals_may_come_after_options_in_every_subcommand(self):
        sid = self.spawn()
        self.as_session(sid, "report", "--key", "k", "blocked", "need a token")
        self.sc("send", "--resolves", "k", sid, "here it is")
        self.sc("mark", sid, "alex", "told Alex")
        self.sc("cron", "add", "--at", "09:00", "--target", "chef", "email-check", stdin="read the email")
        self.assertTrue((self.home / "cron" / "email-check.md").is_file())

    def test_waiting_on_follows_the_latest_state(self):
        sid = self.spawn()
        for state, expected in (("working", "agent"), ("needs-decision", "sc"), ("waiting", "alex"),
                                ("paused", "external"), ("done", "nobody")):
            self.as_session(sid, "report", state, "x")
            self.assertIn(f"waiting on: {expected}", self.sc("sessions").stdout, state)
        self.sc("mark", sid, "alex", "told Alex")
        self.assertIn("waiting on: alex", self.sc("sessions").stdout)


class InboxTests(ScTestCase):
    def test_send_writes_inbox_and_wakes_running_session(self):
        sid = self.spawn()
        out = self.sc("send", sid, "please also update the docs")
        self.assertIn("session was woken", out.stdout)
        self.assertIn("please also update the docs", self.as_session(sid, "inbox").stdout)
        self.assertTrue(any(w[0] == sid for w in self.fake_state()["wakes"]))

    def test_send_to_stopped_session_is_kept_for_later(self):
        sid = self.spawn()
        self.sc("stop", sid)
        out = self.sc("send", sid, "later")
        self.assertIn("not running", out.stdout)
        self.assertIn("later", self.as_session(sid, "inbox").stdout)

    def test_ack_moves_message_and_sequence_numbers_are_not_reused(self):
        sid = self.spawn()
        self.sc("send", sid, "one")
        self.as_session(sid, "inbox", "ack", "1")
        self.assertIn("Inbox is empty.", self.as_session(sid, "inbox").stdout)
        self.sc("send", sid, "two")
        self.assertIn("message 2", self.as_session(sid, "inbox").stdout)


class WatcherTests(ScTestCase):
    def watch(self, **env):
        return self.sc("watch", "--once", env={"SC_SILENT_GRACE": "600", "SC_INBOX_GRACE": "120",
                                                "SC_WAKE_RETRY": "120", **env}).stdout

    def chef_wakes(self):
        return [w for w in self.fake_state()["wakes"] if w[0] == "chef"]

    def test_silent_stop_flagged_once_after_grace(self):
        self.register_chef()
        sid = self.spawn()
        self.hook("worker-prompt", sid)
        self.hook("worker-stop", sid)
        self.clock += 300
        self.assertNotIn("silent-stop", self.watch())
        self.clock += 400
        self.assertIn("silent-stop", self.watch())
        self.assertEqual(self.events(sid)[-1]["state"], "silent-stop")
        self.assertEqual(len(self.chef_wakes()), 1)
        self.clock += 1000
        self.assertNotIn("silent-stop", self.watch())

    def test_no_silent_stop_when_session_reported_why(self):
        sid = self.spawn()
        self.hook("worker-prompt", sid)
        self.as_session(sid, "report", "needs-decision", "which?")
        self.hook("worker-stop", sid)
        self.clock += 1000
        self.assertNotIn("silent-stop", self.watch())

    def test_no_silent_stop_for_session_waiting_on_alex(self):
        sid = self.spawn(kind=self.owner_kind())
        self.hook("worker-prompt", sid)
        self.hook("worker-stop", sid)
        self.clock += 1000
        self.assertNotIn("silent-stop", self.watch())

    def test_unknown_busy_state_is_never_treated_as_idle(self):
        # No turn has ended, so sc's own record cannot say idle either.
        self.register_chef()
        sid = self.spawn()
        self.hook("worker-prompt", sid)
        self.set_fake(sid, busy=None)
        self.sc("send", sid, "please ack")
        self.clock += 1000
        out = self.watch()
        self.assertNotIn("re-rang", out)
        self.assertNotIn("silent-stop", out)
        self.set_fake(sid, busy=False)
        self.clock += 200
        self.assertIn("re-rang", self.watch())

    def test_a_turn_that_ended_long_ago_counts_as_idle_whatever_the_runtime_says(self):
        # Seen live: `claude agents` said busy 15 minutes after the session's last Stop hook.
        self.register_chef()
        sid = self.spawn()
        self.hook("worker-prompt", sid)
        self.hook("worker-stop", sid)
        self.set_fake(sid, busy=True)
        self.sc("send", sid, "please ack")
        self.clock += 200
        self.assertNotIn("re-rang", self.watch())  # the turn ended only 200s ago: trust busy for now
        self.clock += 200
        self.assertIn("re-rang", self.watch())
        self.clock += 500
        self.assertIn("silent-stop", self.watch())
        self.assertEqual(self.events(sid)[-1]["state"], "silent-stop")

    def test_a_prompt_after_the_last_stop_keeps_a_busy_session_busy(self):
        sid = self.spawn()
        self.hook("worker-stop", sid)
        self.clock += 10
        self.hook("worker-prompt", sid)
        self.set_fake(sid, busy=True)
        self.sc("send", sid, "please ack")
        self.clock += 2000
        out = self.watch()
        self.assertNotIn("re-rang", out)
        self.assertNotIn("silent-stop", out)

    SUBAGENTS = {"detail": "TRV-1116 building, awaiting builder report", "in_flight": 4,
                 "running": [{"kind": "subagent", "label": "Build TRV-1116 web types", "since": 1_800_000_000.0},
                             {"kind": "subagent", "label": "rr2 finder: bugs", "since": 1_800_000_000.0},
                             {"kind": "subagent", "label": "rr2 finder: hostile", "since": 1_800_000_000.0},
                             {"kind": "shell", "label": "npm run typecheck", "since": 1_800_000_000.0}]}

    def _stopped_waiting_on_subagents(self):
        self.register_chef()
        sid = self.spawn()
        self.hook("worker-prompt", sid)
        self.hook("worker-stop", sid)
        self.set_fake(sid, activity=self.SUBAGENTS)
        return sid

    def test_no_silent_stop_while_subagents_are_in_flight(self):
        sid = self._stopped_waiting_on_subagents()
        for _ in range(4):
            self.clock += 1000
            self.assertNotIn("silent-stop", self.watch())
        self.assertNotIn("silent-stop", [e["state"] for e in self.events(sid)])

    def test_silent_stop_reported_once_the_subagents_finish_and_the_grace_passes(self):
        sid = self._stopped_waiting_on_subagents()
        self.clock += 2000
        self.assertNotIn("silent-stop", self.watch())
        self.set_fake(sid, activity={**self.SUBAGENTS, "in_flight": 0, "running": []})
        # The grace counts from the last poll that saw work in flight, so a session about to be
        # woken by its subagent's result is not reported in the seconds before it wakes.
        self.clock += 300
        self.assertNotIn("silent-stop", self.watch())
        self.clock += 301
        self.assertIn("silent-stop", self.watch())
        self.assertEqual(self.events(sid)[-1]["state"], "silent-stop")
        self.assertNotIn("still has", self.events(sid)[-1]["text"])
        self.clock += 1000
        self.assertNotIn("silent-stop", self.watch())

    def test_work_in_flight_holds_a_silent_stop_back_only_up_to_the_limit(self):
        sid = self._stopped_waiting_on_subagents()
        self.clock += 3000
        self.assertNotIn("silent-stop", self.watch(SC_INFLIGHT_MAX="3600"))
        self.clock += 700
        self.assertIn("silent-stop", self.watch(SC_INFLIGHT_MAX="3600"))
        self.assertIn("still has 4 subagent(s)", self.events(sid)[-1]["text"])

    def test_activity_the_runtime_cannot_read_leaves_silent_stop_as_before(self):
        # A job file that is missing, malformed or reshaped reaches the watcher as no activity,
        # or as an in-flight count of None; either way the stop is reported after the grace.
        for activity in (None, {"detail": "something", "in_flight": None, "running": []}, "junk", {"in_flight": "4"}):
            sid = self.spawn()
            self.hook("worker-prompt", sid)
            self.hook("worker-stop", sid)
            self.set_fake(sid, activity=activity)
            self.clock += 700
            self.assertIn("silent-stop", self.watch(), activity)
            self.assertEqual(self.events(sid)[-1]["state"], "silent-stop")

    def test_a_new_turn_after_work_in_flight_is_judged_on_its_own_stop(self):
        sid = self._stopped_waiting_on_subagents()
        self.clock += 1000
        self.watch()
        self.set_fake(sid, activity=None)
        self.hook("worker-prompt", sid)  # woken by the subagent's result
        self.clock += 60
        self.hook("worker-stop", sid)
        self.clock += 599
        self.assertNotIn("silent-stop", self.watch())
        self.clock += 2
        self.assertIn("silent-stop", self.watch())

    def test_no_silent_stop_while_a_new_turn_is_running(self):
        sid = self.spawn()
        self.hook("worker-stop", sid)
        self.clock += 10
        self.hook("worker-prompt", sid)
        self.clock += 1000
        self.assertNotIn("silent-stop", self.watch())

    def test_gone_session_flagged_once_but_not_when_stopped_by_sous_chef(self):
        self.register_chef()
        a = self.spawn(title="a")
        b = self.spawn(title="b")
        self.set_fake(a, alive=False)
        self.sc("stop", b)
        self.assertNotIn("gone", self.watch(SC_GONE_GRACE="60"))  # one missed poll only starts the clock
        self.clock += 30
        self.assertNotIn("gone", self.watch(SC_GONE_GRACE="60"))
        self.clock += 30
        out = self.watch(SC_GONE_GRACE="60")
        self.assertIn(f"{a}: gone", out)
        self.assertNotIn(f"{b}: gone", out)
        self.assertIn(f"sc status {a}", self.events(a)[-1]["text"])
        self.clock += 60
        self.assertNotIn("gone", self.watch(SC_GONE_GRACE="60"))

    def test_a_session_that_drops_out_briefly_and_comes_back_is_never_gone(self):
        # Seen live: a session restarting left the listing for a few seconds with a new pid.
        self.register_chef()
        sid = self.spawn()
        self.set_fake(sid, alive=False)
        self.assertNotIn("gone", self.watch(SC_GONE_GRACE="60"))
        self.clock += 15
        self.set_fake(sid, alive=True)
        self.assertNotIn("gone", self.watch(SC_GONE_GRACE="60"))
        self.clock += 15
        self.set_fake(sid, alive=False)  # missing again: the clock starts over
        self.assertNotIn("gone", self.watch(SC_GONE_GRACE="60"))
        self.clock += 45
        self.assertNotIn("gone", self.watch(SC_GONE_GRACE="60"))
        self.clock += 15
        self.assertIn(f"{sid}: gone", self.watch(SC_GONE_GRACE="60"))

    def _stops_for_a_minute(self, sid, **env):
        """The session drops out of the listing and stays out past the gone grace; returns the second poll's output."""
        self.set_fake(sid, alive=False)
        self.watch(SC_GONE_GRACE="60", **env)
        self.clock += 60
        return self.watch(SC_GONE_GRACE="60", **env)

    def test_a_session_waiting_on_alex_that_stops_is_resumed_not_gone(self):
        # Seen live: shape sessions waiting on Alex stopped about an hour after their last turn.
        self.register_chef()
        sid = self.spawn(kind=self.owner_kind())
        self.hook("worker-prompt", sid)
        self.hook("worker-stop", sid)
        self.clock += 3600
        out = self._stops_for_a_minute(sid)
        self.assertIn(f"{sid}: auto-resumed", out)
        self.assertNotIn("gone", out)
        self.assertTrue(self.fake_state()["sessions"][sid]["alive"])
        self.assertEqual(self.events(sid)[-1]["state"], "auto-resumed")
        self.assertEqual(self.events(sid)[-1]["author"], "watcher")
        self.assertEqual(self.chef_wakes(), [])  # a resume that worked needs nobody
        inbox = self.as_session(sid, "inbox").stdout
        self.assertIn("restart", inbox)
        self.assertIn("local page server", inbox)
        self.assertTrue(any(w[0] == sid and "inbox" in w[1] for w in self.fake_state()["wakes"]))
        # It is still waiting on Alex, so its old stopped turn is not called a silent stop,
        # which is what followed a plain `sc resume` (it records waiting on the agent).
        self.assertIn("waiting on: alex", self.sc("status", sid).stdout)
        self.clock += 1000
        self.assertNotIn("silent-stop", self.watch())
        self.assertIn("auto-resumed", self.sc("events").stdout)

    def test_a_session_with_an_open_question_or_paused_is_resumed(self):
        self.register_chef()
        asking = self.spawn(title="asking")
        self.as_session(asking, "report", "needs-decision", "which database?")
        paused = self.spawn(title="paused")
        self.as_session(paused, "report", "paused", "waiting for CI, about 20 minutes")
        self.set_fake(paused, alive=False)
        out = self._stops_for_a_minute(asking)
        self.assertIn(f"{asking}: auto-resumed", out)
        self.assertIn(f"{paused}: auto-resumed", out)
        self.assertIn("waiting on: sc", self.sc("status", asking).stdout)
        self.assertIn("waiting on: external", self.sc("status", paused).stdout)

    def test_a_working_finished_or_stopped_session_is_not_resumed(self):
        self.register_chef()
        working = self.spawn(title="working")  # general starts waiting on the agent
        finished = self.spawn(title="finished")
        self.as_session(finished, "report", "done", "all done")
        stopped = self.spawn(title="stopped", kind=self.owner_kind())
        self.sc("stop", stopped)
        self.set_fake(finished, alive=False)
        out = self._stops_for_a_minute(working)
        self.assertNotIn("auto-resumed", out)
        self.assertIn(f"{working}: gone", out)
        self.assertNotIn(f"{finished}: gone", out)
        self.assertNotIn(f"{stopped}: gone", out)
        state = self.fake_state()["sessions"]
        self.assertFalse(any(state[x]["alive"] for x in (working, finished, stopped)))
        self.assertNotIn("The watcher", self.events(working)[-1]["text"])

    def test_a_failed_resume_is_reported_as_gone(self):
        self.register_chef()
        sid = self.spawn(kind=self.owner_kind())
        out = self._stops_for_a_minute(sid, SC_FAKE_RESUME_FAILS="1")
        self.assertIn(f"{sid}: gone", out)
        self.assertIn("tried to resume it and failed: fake runtime was told to fail the resume",
                      self.events(sid)[-1]["text"])
        self.assertEqual(len(self.chef_wakes()), 1)
        self.clock += 60
        self.assertNotIn(f"{sid}:", self.watch(SC_GONE_GRACE="60"))  # reported once, not retried every poll

    def test_a_session_that_stops_again_soon_after_a_resume_is_gone(self):
        self.register_chef()
        sid = self.spawn(kind=self.owner_kind())
        self.assertIn("auto-resumed", self._stops_for_a_minute(sid))
        self.clock += 300  # up for 5 minutes, under SC_AUTO_RESUME_MIN_UP
        out = self._stops_for_a_minute(sid)
        self.assertIn(f"{sid}: gone", out)
        self.assertIn("stopped again within 10 minutes", self.events(sid)[-1]["text"])

    def test_automatic_resumes_are_capped_per_24_hours(self):
        self.register_chef()
        sid = self.spawn(kind=self.owner_kind())
        for _ in range(2):
            self.clock += 3600
            self.assertIn("auto-resumed", self._stops_for_a_minute(sid, SC_AUTO_RESUME_MAX="2"))
        self.clock += 3600
        out = self._stops_for_a_minute(sid, SC_AUTO_RESUME_MAX="2")
        self.assertIn(f"{sid}: gone", out)
        self.assertIn("2 times in the last 24 hours", self.events(sid)[-1]["text"])
        # Sous chef resumes it by hand; once the earlier resumes are more than 24 hours old,
        # the watcher resumes it again.
        self.sc("resume", sid)
        self.sc("mark", sid, "alex", "back to waiting on Alex")
        self.watch()  # seen running again
        self.clock += 86400
        self.assertIn("auto-resumed", self._stops_for_a_minute(sid, SC_AUTO_RESUME_MAX="2"))

    def test_automatic_resume_can_be_turned_off(self):
        self.register_chef()
        sid = self.spawn(kind=self.owner_kind())
        out = self._stops_for_a_minute(sid, SC_AUTO_RESUME_MAX="0")
        self.assertIn(f"{sid}: gone", out)
        self.assertNotIn("auto-resumed", out)

    def test_inbox_rerings_then_escalates(self):
        self.register_chef()
        sid = self.spawn()
        self.sc("send", sid, "please ack")
        for _ in range(3):
            self.clock += 130
            self.assertIn("re-rang message 1", self.watch())
        self.clock += 130
        self.assertIn("inbox-unread 1", self.watch())
        self.clock += 130
        self.assertNotIn("inbox-unread", self.watch())

    def test_acked_inbox_message_is_left_alone(self):
        sid = self.spawn()
        self.sc("send", sid, "please ack")
        self.as_session(sid, "inbox", "ack", "1")
        self.clock += 1000
        self.assertEqual(self.watch().strip(), "")

    def test_unread_events_rewake_chef_with_backoff_until_acked(self):
        self.register_chef()
        sid = self.spawn()
        self.as_session(sid, "report", "done", "finished")
        self.assertEqual(len(self.chef_wakes()), 1)
        self.clock += 60
        self.assertNotIn("re-woke", self.watch())
        self.clock += 70
        self.assertIn("re-woke", self.watch())
        self.clock += 130
        self.assertNotIn("re-woke", self.watch())
        self.clock += 130
        self.assertIn("re-woke", self.watch())
        out = self.sc("events").stdout
        self.sc("events", "ack", out.strip().splitlines()[-1].split("ack ")[1])
        self.clock += 5000
        self.assertNotIn("re-woke", self.watch())


class SyncTests(ScTestCase):
    """The watcher keeps a data folder that is a git repo with an upstream committed and pushed.
    Local bare repos stand in for GitHub; the fake clock drives the quiet period and retries."""

    GIT_ENV = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
               "GIT_COMMITTER_EMAIL": "t@t", "GIT_CONFIG_GLOBAL": "/dev/null"}

    def setUp(self):
        super().setUp()
        self.base_env.update(self.GIT_ENV)
        self.remote = Path(self.tmp.name) / "data.git"
        self.git(Path(self.tmp.name), "init", "-q", "--bare", "-b", "main", str(self.remote))
        (self.home / ".gitignore").write_text("state/\n.env\n")
        (self.home / "memory").mkdir()
        (self.home / "memory" / "focus.md").write_text("one\n")
        self.git(self.home, "init", "-q", "-b", "main")
        self.git(self.home, "add", "-A")
        self.git(self.home, "commit", "-qm", "start")
        self.git(self.home, "remote", "add", "origin", str(self.remote))
        self.git(self.home, "push", "-q", "-u", "origin", "main")
        self.register_chef()
        path = self.home / "state" / "fake-runtime.json"
        data = json.loads(path.read_text()) if path.exists() else {"sessions": {}, "wakes": []}
        data["sessions"]["chef-1"] = {"alive": True, "busy": False}
        path.write_text(json.dumps(data))

    def git(self, folder, *args, ok=True):
        out = subprocess.run(["git", "-C", str(folder), *args], capture_output=True, text=True,
                             env={**os.environ, **self.GIT_ENV})
        if ok and out.returncode != 0:
            self.fail(f"git {' '.join(args)}: {out.stderr}")
        return out.stdout

    def watch(self, **env):
        return self.sc("watch", "--once", env=env).stdout

    def remote_log(self):
        return self.git(self.remote, "log", "--format=%s", "main").splitlines()

    def sync_events(self):
        path = self.home / "state" / "sync" / "events.jsonl"
        return [json.loads(l) for l in path.read_text().splitlines()] if path.exists() else []

    def other_clone_pushes(self, rel, text):
        other = Path(self.tmp.name) / f"other-{len(list(Path(self.tmp.name).glob('other-*')))}"
        self.git(Path(self.tmp.name), "clone", "-q", str(self.remote), str(other))
        (other / rel).parent.mkdir(parents=True, exist_ok=True)
        (other / rel).write_text(text)
        self.git(other, "add", "-A")
        self.git(other, "commit", "-qm", f"elsewhere: {rel}")
        self.git(other, "push", "-q", "origin", "main")

    def change_and_wait(self, rel="memory/focus.md", text="two\n"):
        (self.home / rel).write_text(text)
        self.watch()
        self.clock += 120
        return self.watch()

    def test_without_an_upstream_nothing_is_committed(self):
        self.git(self.home, "branch", "--unset-upstream")
        self.change_and_wait()
        self.assertEqual(len(self.git(self.home, "log", "--oneline").splitlines()), 1)
        self.assertIn("M memory/focus.md", self.git(self.home, "status", "--porcelain"))

    def test_changes_are_committed_after_two_quiet_minutes_and_pushed(self):
        (self.home / "memory" / "focus.md").write_text("two\n")
        self.watch()
        self.clock += 60
        (self.home / "memory" / "ideas.md").write_text("an idea\n")  # a new change restarts the quiet period
        self.watch()
        self.clock += 100
        self.watch()
        self.assertEqual(self.remote_log(), ["start"])
        self.clock += 20
        out = self.watch()
        self.assertIn("sync: committed 2 file(s)", out)
        self.assertIn("sync: pushed", out)
        self.assertEqual(self.remote_log(), ["sync: memory/focus.md, memory/ideas.md", "start"])
        self.assertEqual(self.git(self.home, "status", "--porcelain"), "")

    def test_state_and_env_are_never_committed_even_if_not_ignored(self):
        (self.home / ".gitignore").unlink()
        (self.home / ".env").write_text("SC_RELAY_KEY=secret\n")
        self.change_and_wait()
        files = self.git(self.remote, "ls-tree", "-r", "--name-only", "main").split()
        self.assertIn("memory/focus.md", files)
        self.assertFalse([f for f in files if f.startswith("state/") or f == ".env"], files)

    def test_a_remote_that_moved_on_is_rebased_onto(self):
        self.other_clone_pushes("memory/ideas.md", "from the other machine\n")
        self.change_and_wait()
        self.assertEqual(self.remote_log(), ["sync: memory/focus.md", "elsewhere: memory/ideas.md", "start"])
        self.assertEqual((self.home / "memory" / "ideas.md").read_text(), "from the other machine\n")

    def test_a_conflict_stops_syncing_wakes_sous_chef_and_restarts_once_resolved(self):
        self.other_clone_pushes("memory/focus.md", "theirs\n")
        out = self.change_and_wait(text="mine\n")
        self.assertIn("sync: stopped (conflict)", out)
        [stopped] = self.sync_events()
        self.assertEqual(stopped["state"], "sync-stopped")
        self.assertIn("conflicted, so the rebase was aborted", stopped["text"])
        self.assertIn("woke sous chef: True", out)
        self.assertFalse((Path(self.git(self.home, "rev-parse", "--absolute-git-dir").strip()) / "rebase-merge").exists())
        self.assertEqual((self.home / "memory" / "focus.md").read_text(), "mine\n")
        self.assertIn("[sync] keeping your data folder committed and pushed", self.sc("events").stdout)
        self.clock += 600
        self.watch()
        self.assertEqual(len(self.sync_events()), 1)  # still stopped: nothing changed
        # The owner resolves it by hand.
        self.git(self.home, "pull", "-q", "--rebase", "-X", "theirs", "origin", "main")
        out = self.watch()
        self.assertIn("sync: resumed", out)
        self.assertEqual(self.sync_events()[-1]["state"], "sync-resumed")
        self.assertIn("sync: pushed", out)
        self.assertEqual(self.remote_log()[0], "sync: memory/focus.md")

    def test_failed_pushes_are_retried_then_stop_syncing_until_a_fetch_works(self):
        self.git(self.home, "remote", "set-url", "origin", str(Path(self.tmp.name) / "offline.git"))
        out = self.change_and_wait()
        self.assertIn("fetch or push failed (1 in a row)", out)
        self.assertNotIn("failed (2", self.watch())  # backing off
        for n in (2, 3, 4):
            self.clock += 60 * 2 ** (n - 2)
            self.assertIn(f"failed ({n} in a row)", self.watch())
        self.clock += 480
        out = self.watch()
        self.assertIn("sync: stopped (push)", out)
        [stopped] = self.sync_events()
        self.assertIn("5 fetches or pushes in a row failed", stopped["text"])
        self.clock += 600
        self.assertNotIn("resumed", self.watch())  # still offline
        self.git(self.home, "remote", "set-url", "origin", str(self.remote))
        self.clock += 600
        out = self.watch()
        self.assertIn("sync: resumed", out)
        self.assertIn("sync: pushed", out)
        self.assertEqual(self.sync_events()[-1]["state"], "sync-resumed")
        self.assertEqual(self.remote_log()[0], "sync: memory/focus.md")

    def test_an_uncommitted_edit_holds_the_push_back_instead_of_stopping_sync(self):
        self.other_clone_pushes("memory/ideas.md", "from the other machine\n")
        (self.home / "memory" / "focus.md").write_text("two\n")
        self.git(self.home, "commit", "-qam", "unpushed")  # one commit ahead of a remote that moved on
        (self.home / "memory" / "focus.md").write_text("three\n")  # and an edit still in its quiet period
        out = self.watch()
        self.assertNotIn("sync:", out)
        self.assertEqual(self.sync_events(), [])
        self.clock += 120
        out = self.watch()
        self.assertIn("sync: committed 1 file(s)", out)
        self.assertIn("sync: pushed", out)
        self.assertEqual(self.remote_log()[:2], ["sync: memory/focus.md", "unpushed"])
        self.assertEqual(self.sync_events(), [])

    def test_nothing_is_done_while_a_merge_is_in_progress(self):
        self.other_clone_pushes("memory/focus.md", "theirs\n")
        (self.home / "memory" / "focus.md").write_text("mine\n")
        self.git(self.home, "commit", "-qam", "mine")
        self.git(self.home, "pull", "-q", "--no-rebase", "origin", "main", ok=False)  # conflicts, left for the owner
        self.clock += 600
        self.watch()
        self.clock += 600
        self.watch()
        self.assertEqual(self.remote_log(), ["elsewhere: memory/focus.md", "start"])
        self.assertEqual(self.sync_events(), [])


class PromptWatcherTests(ScTestCase):
    PROMPT = "permission prompt (approve Bash: ./scripts/db-reset.sh)"

    def watch(self, **env):
        return self.sc("watch", "--once", env={"SC_SILENT_GRACE": "600", "SC_INBOX_GRACE": "120",
                                                "SC_WAKE_RETRY": "120", "SC_PROMPT_GRACE": "180", **env}).stdout

    def chef_wakes(self):
        return [w for w in self.fake_state()["wakes"] if w[0] == "chef"]

    def prompt_events(self, sid):
        return [e for e in self.events(sid) if e["state"].startswith("prompt-")]

    def test_a_held_session_is_reported_once_after_the_grace_period(self):
        self.register_chef()
        sid = self.spawn()
        self.hook("worker-prompt", sid)
        self.set_fake(sid, prompt=self.PROMPT)
        self.assertNotIn("prompt-waiting", self.watch())  # the first poll only starts the clock
        self.clock += 170
        self.assertNotIn("prompt-waiting", self.watch())
        self.clock += 15
        self.assertIn(f"{sid}: prompt-waiting", self.watch())
        event = self.events(sid)[-1]
        self.assertEqual((event["state"], event["author"]), ("prompt-waiting", "watcher"))
        self.assertIn("approve Bash: ./scripts/db-reset.sh", event["text"])
        self.assertIn(f"fake attach {sid}", event["text"])
        self.assertEqual(self.chef_wakes()[-1][1],
                         f"sous chef watcher: sessions need attention ({sid}). Run `sc events`.")
        self.assertIn("waiting on: alex", self.sc("status", sid).stdout)
        self.assertIn("held at a prompt", self.sc("sessions").stdout)
        self.assertIn(f"HELD AT A PROMPT: {self.PROMPT}", self.sc("status", sid).stdout)
        for _ in range(4):  # still held: no second event on later polls
            self.clock += 200
            self.assertNotIn("prompt-waiting", self.watch())
        self.assertEqual([e["state"] for e in self.prompt_events(sid)], ["prompt-waiting"])

    def test_a_prompt_answered_within_the_grace_period_is_never_reported(self):
        self.register_chef()
        sid = self.spawn()
        self.set_fake(sid, prompt=self.PROMPT)
        self.watch()
        self.clock += 100
        self.watch()
        self.set_fake(sid, prompt=None, busy=True)
        self.clock += 100
        self.assertNotIn("prompt", self.watch())
        self.clock += 1000
        self.assertNotIn("prompt", self.watch())
        self.assertEqual(self.prompt_events(sid), [])
        self.assertEqual(self.chef_wakes(), [])

    def test_a_reported_prompt_that_is_answered_gives_back_who_the_session_waits_on(self):
        self.register_chef()
        sid = self.spawn()
        self.hook("worker-prompt", sid)
        self.set_fake(sid, prompt=self.PROMPT)
        self.watch()
        self.clock += 200
        self.watch()
        wakes = len(self.chef_wakes())
        self.set_fake(sid, prompt=None, busy=True)
        self.clock += 15
        self.watch()
        self.assertEqual([e["state"] for e in self.prompt_events(sid)], ["prompt-waiting", "prompt-answered"])
        self.assertIn("waiting on: agent", self.sc("status", sid).stdout)
        self.assertEqual(len(self.chef_wakes()), wakes)  # an answered prompt needs nothing, so no wake-up
        # With "waiting on" back to the agent, a later silent stop is still noticed.
        self.hook("worker-stop", sid)
        self.set_fake(sid, busy=False)
        self.clock += 700
        self.assertIn("silent-stop", self.watch())

    def test_a_report_made_after_the_prompt_is_not_overwritten_when_it_closes(self):
        sid = self.spawn()
        self.set_fake(sid, prompt=self.PROMPT)
        self.watch()
        self.clock += 200
        self.watch()
        self.sc("mark", sid, "external", "Alex is on it")
        self.set_fake(sid, prompt=None)
        self.clock += 15
        self.watch()
        self.assertEqual(self.events(sid)[-1]["state"], "prompt-answered")
        self.assertIn("waiting on: external", self.sc("status", sid).stdout)

    def test_a_different_prompt_is_a_new_occurrence(self):
        sid = self.spawn()
        self.set_fake(sid, prompt=self.PROMPT)
        self.watch()
        self.clock += 200
        self.assertIn("prompt-waiting", self.watch())
        self.set_fake(sid, prompt="permission prompt (approve Bash: git push)")
        self.clock += 15
        self.assertNotIn("prompt-waiting", self.watch())  # a new prompt: its own clock starts
        self.clock += 200
        self.assertIn("prompt-waiting", self.watch())
        self.assertEqual([e["state"] for e in self.prompt_events(sid)],
                         ["prompt-waiting", "prompt-answered", "prompt-waiting"])
        self.assertIn("git push", self.events(sid)[-1]["text"])

    def test_a_held_session_is_busy_so_it_is_not_re_rung_or_called_silent(self):
        self.register_chef()
        sid = self.spawn()
        self.hook("worker-prompt", sid)
        self.sc("send", sid, "please ack")
        self.set_fake(sid, prompt=self.PROMPT, busy=False)
        self.clock += 2000
        out = self.watch()
        self.assertNotIn("re-rang", out)
        self.assertNotIn("silent-stop", out)
        self.assertNotIn("inbox-unread", out)

    def test_a_session_that_dies_at_a_prompt_is_gone_not_answered(self):
        sid = self.spawn()
        self.set_fake(sid, prompt=self.PROMPT)
        self.watch()
        self.clock += 200
        self.watch()
        self.set_fake(sid, alive=False)
        self.clock += 15
        self.watch(SC_GONE_GRACE="60", SC_AUTO_RESUME_MAX="0")
        self.clock += 60
        self.assertIn(f"{sid}: gone", self.watch(SC_GONE_GRACE="60", SC_AUTO_RESUME_MAX="0"))
        self.assertEqual([e["state"] for e in self.prompt_events(sid)], ["prompt-waiting"])

    def test_a_session_that_stops_at_a_prompt_is_resumed_and_still_waits_on_alex(self):
        sid = self.spawn()
        self.set_fake(sid, prompt=self.PROMPT)
        self.watch()
        self.clock += 200
        self.watch()  # prompt-waiting: waiting on Alex
        self.set_fake(sid, alive=False)
        self.clock += 15
        self.watch(SC_GONE_GRACE="60")
        self.clock += 60
        self.assertIn(f"{sid}: auto-resumed", self.watch(SC_GONE_GRACE="60"))
        self.assertIn("waiting on: alex", self.sc("status", sid).stdout)


class RunningWatcherTestCase(ScTestCase):
    """Starts real watcher processes (no Claude sessions) from a copy of the code under test, and
    stops them afterwards. A test never takes the watcher's lock itself: how the lock is held
    differs by language (TRV-1143 decision 13), so a test that needs a running watcher starts one."""

    def setUp(self):
        super().setUp()
        self.code = core_paths.copy_code(Path(self.tmp.name) / "code", root=CODE)
        self.state = self.home / "state"

    def tearDown(self):
        self.stop_watchers()  # before the temporary home (and its watch.pid) is deleted
        super().tearDown()

    def copy_sc(self, *args, poll="0.2", stdin=None, env=None):
        env = {**self.base_env, "SC_WATCH_POLL": poll, **(env or {})}
        return subprocess.run([str(self.code / "bin" / "sc"), *args], capture_output=True, text=True, env=env,
                              timeout=60, input=stdin)

    def stop_watchers(self):
        # Every watcher any test started runs from this test's copy of the code.
        subprocess.run(["pkill", "-KILL", "-f", f"{self.code}/bin/sc watch"], capture_output=True)

    def wait_for(self, condition, seconds=10):
        import time
        deadline = time.time() + seconds
        while time.time() < deadline:
            if condition():
                return True
            time.sleep(0.1)
        return condition()

    def code_record(self):
        path = self.state / "watch.code"
        return json.loads(path.read_text()) if path.exists() else {}

    def pid(self):
        return int((self.state / "watch.pid").read_text())


class WatcherCodeTests(RunningWatcherTestCase):
    """A running watcher and the code under it: the copy lets a test change that code without
    touching the code under test."""

    def change_code(self, text="# a change\n"):
        with open(self.code / "lib" / "sc" / "util.py", "a") as f:
            f.write(text)

    def test_a_watcher_restarts_itself_on_new_code_between_cycles(self):
        self.assertIn("watcher running", self.copy_sc("watch", "--ensure").stdout)
        before, pid = self.code_record()["code"], self.pid()
        self.change_code()
        self.assertTrue(self.wait_for(lambda: self.code_record().get("code") not in (None, before)),
                        (self.state / "watch.log").read_text())
        self.assertEqual(self.pid(), pid)  # replaced itself in place, so no second watcher
        self.assertIn("restarting on the new code", (self.state / "watch.log").read_text())
        self.assertIn("## Watcher\nrunning\n", self.copy_sc("summary").stdout)

    def test_new_code_that_does_not_load_is_refused_and_the_old_code_keeps_running(self):
        self.copy_sc("watch", "--ensure")
        before = self.code_record()["code"]
        self.change_code("def broken(:\n")
        self.assertTrue(self.wait_for(lambda: "does not load" in (self.state / "watch.log").read_text()))
        beat = (self.state / "watch.beat").read_text()
        self.assertTrue(self.wait_for(lambda: (self.state / "watch.beat").read_text() != beat))
        self.assertEqual(self.code_record()["code"], before)

    def test_ensure_replaces_a_watcher_that_cannot_vouch_for_its_code(self):
        # A watcher started before watch.code existed records nothing about its code.
        self.copy_sc("watch", "--ensure")
        old = self.pid()
        (self.state / "watch.code").unlink()
        self.assertIn("older code", self.copy_sc("summary").stdout)
        out = self.copy_sc("watch", "--ensure")
        self.assertIn("was running older code, so it was restarted", out.stdout)
        self.assertNotEqual(self.pid(), old)
        self.assertTrue(self.wait_for(lambda: subprocess.run(["kill", "-0", str(old)],
                                                             capture_output=True).returncode != 0))
        self.assertIn("watcher stopped between cycles", (self.state / "watch.log").read_text())
        self.assertEqual(self.code_record()["pid"], self.pid())

    def test_cron_list_says_when_the_watcher_or_sous_chef_cannot_fire_jobs(self):
        self.copy_sc("cron", "add", "tidy", "--every", "30m", "--target", "chef",
                     stdin="tidy up").check_returncode()
        self.copy_sc("watch", "--ensure")
        out = self.copy_sc("cron", "list").stdout  # no sous chef registered
        self.assertIn("WARNING: sous chef is not running", out)
        (self.state / "watch.code").unlink()  # as a watcher started by older code leaves it
        out = self.copy_sc("cron", "list").stdout
        self.assertIn("WARNING: the watcher running now was started by older code", out)

    def test_ensure_leaves_a_watcher_on_current_code_alone(self):
        self.copy_sc("watch", "--ensure")
        pid = self.pid()
        out = self.copy_sc("watch", "--ensure")
        self.assertEqual(out.stdout.strip(), "watcher running")
        self.assertEqual(self.pid(), pid)


class CleanupTests(ScTestCase):
    def git(self, *args):
        subprocess.run(["git", "-C", str(self.work), *args], check=True, capture_output=True)

    def test_cleanup_refuses_uncommitted_changes_then_force_archives(self):
        self.git("init", "-q")
        (self.work / "file.txt").write_text("changed")
        sid = self.spawn()
        out = self.sc("cleanup", sid, ok=False)
        self.assertIn("uncommitted changes", out.stderr)
        self.sc("cleanup", sid, "--force")
        self.assertTrue((self.home / "state" / "archive" / sid / "record.json").is_file())
        self.assertNotIn(sid, self.sc("sessions").stdout)

    def test_cleanup_refuses_commits_no_remote_has(self):
        self.git("init", "-q")
        self.git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "local")
        sid = self.spawn()
        self.assertIn("no remote has", self.sc("cleanup", sid, ok=False).stderr)


class HookTests(ScTestCase):
    def test_guard_denies_edits_under_state_only(self):
        inside = json.dumps({"tool_input": {"file_path": str(self.home / "state" / "cursors.json")}})
        out = self.sc("hook", "guard-edit", stdin=inside).stdout
        self.assertEqual(json.loads(out)["hookSpecificOutput"]["permissionDecision"], "deny")
        outside = json.dumps({"tool_input": {"file_path": str(self.home / "memory" / "ideas.md")}})
        self.assertEqual(self.sc("hook", "guard-edit", stdin=outside).stdout.strip(), "")

    def test_worker_start_mentions_unhandled_messages(self):
        sid = self.spawn()
        self.sc("send", sid, "hello")
        out = self.sc("hook", "worker-start", "--session", sid, stdin=json.dumps({"source": "compact"})).stdout
        ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("1 unhandled message", ctx)
        self.assertIn("source=compact", ctx)

    def _chef_start(self, session_id, source="startup"):
        return self.sc("hook", "chef-start",
                       stdin=json.dumps({"session_id": session_id, "source": source}),
                       env={"SC_WATCH_DISABLE_ENSURE": "1"}).stdout

    def _fake_alive(self, session_id, alive=True):
        """Put a row in the fake runtime's listing so a chef looks running (or not)."""
        path = self.home / "state" / "fake-runtime.json"
        data = json.loads(path.read_text()) if path.exists() else {"sessions": {}, "wakes": []}
        data.setdefault("sessions", {})[session_id] = {"alive": alive, "busy": False}
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data))

    def _registered(self):
        return json.loads((self.home / "state" / "chef.json").read_text())["session_id"]

    def test_a_second_session_does_not_take_a_running_chefs_registration(self):
        self._chef_start("chef-1")
        self._fake_alive("chef-1")
        out = self._chef_start("chef-2")
        self.assertIn("You are NOT sous chef", out)
        self.assertIn("chef-1", out)
        self.assertNotIn("SOUS CHEF STARTUP SUMMARY", out)
        self.assertEqual(self._registered(), "chef-1")

    def test_the_chef_still_gets_its_summary_on_its_own_restart(self):
        """The hook fires again on resume and compaction: the summary must not be skipped."""
        self._chef_start("chef-1")
        self._fake_alive("chef-1")
        out = self._chef_start("chef-1", source="compact")
        self.assertIn("SOUS CHEF STARTUP SUMMARY", out)
        self.assertNotIn("You are NOT sous chef", out)
        self.assertEqual(self._registered(), "chef-1")

    def test_a_dead_chefs_registration_is_taken_over(self):
        self._chef_start("chef-1")
        self._fake_alive("chef-1", alive=False)
        out = self._chef_start("chef-2")
        self.assertIn("SOUS CHEF STARTUP SUMMARY", out)
        self.assertIn("it is not running, so this session took over", out)
        self.assertEqual(self._registered(), "chef-2")

    def test_an_unknown_chef_is_treated_as_gone(self):
        """No row at all in the runtime listing means the session is not there."""
        self._chef_start("chef-1")
        self.assertEqual(self._registered(), "chef-1")
        self._chef_start("chef-2")
        self.assertEqual(self._registered(), "chef-2")

    def test_chef_take_hands_the_role_over_deliberately(self):
        self._chef_start("chef-1")
        self._fake_alive("chef-1")
        out = self.sc("chef", "--take", env={"CLAUDE_CODE_SESSION_ID": "chef-2"}).stdout
        self.assertIn("is now sous chef", out)
        self.assertIn("taken from chef-1", out)
        self.assertEqual(self._registered(), "chef-2")

    def _code_repo(self, name):
        """A copy of the core's code, committed in a git repo of its own."""
        repo = core_paths.copy_code(Path(self.tmp.name) / name, root=CODE)
        for args in (("init", "-q"), ("config", "user.email", "t@t"), ("config", "user.name", "t"),
                     ("add", "-A"), ("commit", "-qm", "init")):
            subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True)
        return repo

    def _copy_chef_start(self, code, session_id, **env):
        e = {**self.base_env, "SC_TEST_WORKTREE_CHECK": "1", "SC_WATCH_DISABLE_ENSURE": "1", **env}
        return subprocess.run([str(code / "bin" / "sc"), "hook", "chef-start"], capture_output=True, text=True,
                              input=json.dumps({"session_id": session_id, "source": "startup"}), env=e).stdout

    def test_a_session_in_a_worktree_of_the_repo_is_not_sous_chef(self):
        """A worktree of the core has no data folder of its own, and must not become sous chef."""
        repo = self._code_repo("repo")
        wt = Path(self.tmp.name) / "wt"
        subprocess.run(["git", "-C", str(repo), "worktree", "add", "-q", str(wt)], capture_output=True, check=True)
        for env in ({}, {"SC_TEST_HOME": ""}):  # with a test data folder, and with none at all (no my link)
            out = self._copy_chef_start(wt, "wt-session", **env)
            self.assertIn("You are NOT sous chef", out)
            self.assertIn("git worktree", out)
            self.assertIn(str(repo.resolve()), out)
            self.assertNotIn("SOUS CHEF STARTUP SUMMARY", out)
        self.assertFalse((self.home / "state" / "chef.json").exists())
        self.assertFalse((wt / "state").exists())

    def test_the_ordinary_checkout_is_not_mistaken_for_a_worktree(self):
        repo = self._code_repo("plain")
        out = self._copy_chef_start(repo, "plain-session")
        self.assertIn("SOUS CHEF STARTUP SUMMARY", out)
        self.assertEqual(json.loads((self.home / "state" / "chef.json").read_text())["session_id"],
                         "plain-session")

    def test_chef_take_needs_to_run_inside_a_claude_session(self):
        out = self.sc("chef", "--take", ok=False)
        self.assertIn("CLAUDE_CODE_SESSION_ID is not set", out.stderr)

    def test_chef_start_registers_and_injects_summary(self):
        (self.home / "memory").mkdir()
        (self.home / "memory" / "focus.md").write_text("Working on sous chef docs")
        self.spawn(title="Visible task")
        out = self.sc("hook", "chef-start", stdin=json.dumps({"session_id": "chef-9", "source": "compact"}),
                      env={"SC_WATCH_DISABLE_ENSURE": "1"}).stdout
        ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("source=compact", ctx)
        self.assertIn("Working on sous chef docs", ctx)
        self.assertIn("Visible task", ctx)
        self.assertIn("chef-9", self.sc("chef").stdout)

    def test_hook_errors_never_fail_and_are_logged(self):
        out = self.sc("hook", "worker-stop", "--session", "missing-session", stdin="{}")
        self.assertEqual(out.returncode, 0)
        self.assertIn("worker-stop", (self.home / "state" / "hook-errors.log").read_text())


class WorktreeTests(ScTestCase):
    def make_repo(self):
        """An origin with one commit, and a repo root in Alex's layout: .bare/, a .git file, .local/.env."""
        origin = Path(self.tmp.name) / "origin.git"
        seed = Path(self.tmp.name) / "seed"
        run = lambda *a, cwd=None: subprocess.run(a, cwd=cwd, check=True, capture_output=True)
        run("git", "init", "-q", "--bare", "-b", "main", str(origin))
        run("git", "init", "-q", "-b", "main", str(seed))
        (seed / ".gitignore").write_text(".env\n")
        run("git", "-C", str(seed), "add", ".gitignore")
        run("git", "-C", str(seed), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "first")
        run("git", "-C", str(seed), "push", "-q", str(origin), "main")
        root = self.work / "repo"
        run("git", "init", "-q", "--bare", str(root / ".bare"))
        (root / ".git").write_text("gitdir: ./.bare\n")
        run("git", "-C", str(root / ".bare"), "remote", "add", "origin", str(origin))
        run("git", "-C", str(root / ".bare"), "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*")
        (root / ".local").mkdir()
        (root / ".local" / ".env").write_text("SECRET=1\n")
        return root

    def test_worktree_created_from_origin_with_env_linked_and_recorded(self):
        root = self.make_repo()
        out = self.sc("worktree", "--repo", str(root), "--branch", "alx/TRV-1-thing", "--dir", "thing", "--base", "main")
        self.assertIn("linked env files from .local/: .env", out.stdout)
        wt = root / "thing"
        self.assertEqual(os.readlink(wt / ".env"), "../.local/.env")
        branch = subprocess.run(["git", "-C", str(wt), "branch", "--show-current"], capture_output=True, text=True)
        self.assertEqual(branch.stdout.strip(), "alx/TRV-1-thing")
        upstream = subprocess.run(["git", "-C", str(wt), "rev-parse", "--abbrev-ref", "@{u}"], capture_output=True)
        self.assertNotEqual(upstream.returncode, 0)
        reg = json.loads((self.home / "state" / "worktrees.json").read_text())
        self.assertIsNone(reg[str(wt.resolve())]["session"])

    def test_worktree_refuses_existing_dir_or_branch_and_bad_names(self):
        root = self.make_repo()
        self.sc("worktree", "--repo", str(root), "--branch", "alx/a", "--dir", "a", "--base", "main")
        self.assertIn("already exists", self.sc("worktree", "--repo", str(root), "--branch", "alx/b", "--dir", "a",
                                                 "--base", "main", ok=False).stderr)
        self.assertIn("branch alx/a already exists", self.sc("worktree", "--repo", str(root), "--branch", "alx/a",
                                                             "--dir", "b", "--base", "main", ok=False).stderr)
        self.assertIn("kebab-case", self.sc("worktree", "--repo", str(root), "--branch", "alx/c", "--dir", "Bad Name",
                                            "--base", "main", ok=False).stderr)

    def test_session_in_its_own_worktree_turns_off_isolation_only_for_itself(self):
        root = self.make_repo()
        self.sc("worktree", "--repo", str(root), "--branch", "alx/x", "--dir", "x", "--base", "main")
        wt = root / "x"
        out = self.sc("spawn", "--kind", "general", "--title", "Build x", "--cwd", str(wt), "--runtime", "fake",
                      stdin="build it")
        sid = out.stdout.split()[1]
        launched = self.fake_state()["sessions"][sid]
        self.assertEqual(launched["settings"].get("worktree"), {"bgIsolation": "none"})
        self.assertIn("worktree sous chef created for this task", (self.home / "state" / "sessions" / sid / "brief.md").read_text())
        self.assertIn("used by active session", self.sc("spawn", "--kind", "general", "--title", "again", "--cwd", str(wt),
                                                        "--runtime", "fake", stdin="again", ok=False).stderr)
        other = self.spawn(title="elsewhere")
        self.assertNotIn("worktree", self.fake_state()["sessions"][other]["settings"])
        self.assertIn("may require you to enter a worktree",
                      (self.home / "state" / "sessions" / other / "brief.md").read_text())

    def test_worktree_can_be_reused_after_its_session_is_cleaned_up(self):
        root = self.make_repo()
        self.sc("worktree", "--repo", str(root), "--branch", "alx/y", "--dir", "y", "--base", "main")
        wt = root / "y"
        sid = self.sc("spawn", "--kind", "general", "--title", "first", "--cwd", str(wt), "--runtime", "fake",
                      stdin="t").stdout.split()[1]
        self.sc("cleanup", sid)
        again = self.sc("spawn", "--kind", "general", "--title", "second", "--cwd", str(wt), "--runtime", "fake",
                        stdin="t").stdout.split()[1]
        self.assertEqual(self.fake_state()["sessions"][again]["settings"].get("worktree"), {"bgIsolation": "none"})


class SouschefTests(ScTestCase):
    """`souschef --print` against the fake runtime (SC_CHEF_RUNTIME=fake): what it decides from the
    registered sous chef and the runtime's listing. Never run without --print, which would attach."""

    def souschef(self, *args, env=None, ok=True):
        e = {**self.base_env, "SC_FAKE_NOW": str(self.clock), **(env or {})}
        out = subprocess.run([str(SOUSCHEF), "--print", *args], capture_output=True, text=True, env=e)
        if ok and out.returncode != 0:
            self.fail(f"souschef {' '.join(args)} failed ({out.returncode}): {out.stdout}{out.stderr}")
        return out

    def fake_rows(self, **rows):
        """Replace the fake runtime's sessions with these rows."""
        path = self.home / "state" / "fake-runtime.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"sessions": rows, "wakes": []}))

    def started(self):
        """The rows of sous chef sessions souschef started (the fake runtime keys them fake-chef-<n>)."""
        return {k: v for k, v in self.fake_state()["sessions"].items() if k.startswith("fake-chef-")}

    def test_with_nothing_registered_a_new_sous_chef_is_started_in_bypass_mode(self):
        out = self.souschef().stdout
        self.assertEqual(out, "started sous chef (chef-1) with permissions: bypass\nfake attach chef-1\n")
        row = self.started()["fake-chef-1"]
        self.assertEqual((row["name"], row["permissions"], row["cwd"]), ("sous-chef", "bypass", str(CODE)))

    def test_a_running_background_sous_chef_is_attached_not_started(self):
        self.register_chef()
        self.fake_rows(**{"chef-1": {"alive": True, "pid": 1, "kind": "background", "id": "abcd1234"}})
        self.assertEqual(self.souschef().stdout, "fake attach abcd1234\n")
        self.assertEqual(self.started(), {})

    def test_a_sous_chef_open_in_a_terminal_is_reported_and_left_alone(self):
        self.register_chef()
        self.fake_rows(**{"chef-1": {"alive": True, "pid": 1, "kind": "interactive", "id": "abcd1234"}})
        out = self.souschef(ok=False)
        self.assertEqual(out.returncode, 1)
        self.assertIn("already open in another terminal", out.stdout)
        self.assertNotIn("fake attach", out.stdout)
        self.assertEqual(self.started(), {})

    def test_a_stopped_or_unlisted_sous_chef_is_resumed(self):
        self.register_chef()
        for rows in ({"chef-1": {"alive": False, "kind": "background", "id": "abcd1234"}}, {}):
            self.fake_rows(**rows)
            out = self.souschef().stdout
            short = "abcd1234" if rows else "chef-1"
            self.assertEqual(out, f"resumed sous chef ({short})\nfake attach {short}\n")
            self.assertEqual(self.fake_state()["sessions"]["chef-1"]["pid"], 1)
            self.assertEqual(self.started(), {})

    def test_a_sous_chef_that_does_not_come_back_is_replaced_by_a_new_one(self):
        self.register_chef()
        self.fake_rows(**{"chef-1": {"alive": False, "kind": "background", "id": "abcd1234"}})
        out = self.souschef(env={"SC_FAKE_RESUME_FAILS": "1"}).stdout
        self.assertEqual(out, "could not resume the previous sous chef session; starting a new one\n"
                              "started sous chef (chef-1) with permissions: bypass\nfake attach chef-1\n")
        self.assertEqual(list(self.started()), ["fake-chef-1"])

    def test_new_stops_the_background_sous_chef_and_starts_a_fresh_one(self):
        self.register_chef()
        self.fake_rows(**{"chef-1": {"alive": True, "pid": 1, "kind": "background", "id": "abcd1234"}})
        out = self.souschef("--new").stdout
        self.assertEqual(out, "stopped the previous sous chef (abcd1234); its conversation is kept\n"
                              "started sous chef (chef-1) with permissions: bypass\nfake attach chef-1\n")
        old = self.fake_state()["sessions"]["chef-1"]
        self.assertFalse(old["alive"])
        self.assertNotIn("pid", old)
        self.assertEqual(self.started()["fake-chef-1"]["permissions"], "bypass")


class SouschefClaudeArgsTests(unittest.TestCase):
    """How `souschef` starts sous chef on the Claude runtime, from claude_bg's own arguments."""

    def setUp(self):
        sys.path.insert(0, str(CODE / "lib"))

    def test_a_new_sous_chef_is_started_in_bypass_mode(self):
        from sc import souschef
        from sc.runtimes import claude_bg
        self.assertEqual(souschef.PERMISSIONS, "bypass")
        args = claude_bg._named_args(souschef.SESSION_NAME, "hello", souschef.PERMISSIONS)
        self.assertEqual(args, ["claude", "--bg", "-n", "sous-chef", "--permission-mode", "bypassPermissions", "hello"])

    def test_start_named_refuses_an_unknown_permission_value(self):
        from sc import util
        from sc.runtimes import claude_bg
        with self.assertRaises(util.SCError):
            claude_bg._named_args("sous-chef", "hello", "everything")


class ResumeAndReleaseTests(ScTestCase):
    def test_resume_clears_the_stopped_flag_and_records_it(self):
        sid = self.spawn()
        self.sc("stop", sid)
        rec = json.loads((self.home / "state" / "sessions" / sid / "record.json").read_text())
        self.assertTrue(rec["stopped_by_sc"])
        self.assertEqual(self.events(sid)[-1]["state"], "stopped")
        self.sc("resume", sid)
        rec = json.loads((self.home / "state" / "sessions" / sid / "record.json").read_text())
        self.assertFalse(rec["stopped_by_sc"])
        self.assertEqual(self.events(sid)[-1]["state"], "resumed")
        self.assertIn("waiting on: agent", self.sc("sessions").stdout)
        self.assertTrue(self.fake_state()["sessions"][sid]["alive"])

    def test_resume_refuses_a_session_that_is_still_running(self):
        sid = self.spawn()
        out = self.sc("resume", sid, ok=False)
        self.assertIn("already running", out.stderr)
        self.assertIn(f"sc send {sid}", out.stderr)
        self.assertNotIn("resumed", [e["state"] for e in self.events(sid)])

    def test_resumed_session_is_reachable_again(self):
        sid = self.spawn()
        self.sc("stop", sid)
        self.assertIn("not running", self.sc("send", sid, "while stopped").stdout)
        self.sc("resume", sid)
        self.assertIn("session was woken", self.sc("send", sid, "after resume").stdout)

    def test_a_failed_launch_does_not_keep_holding_the_worktree(self):
        root = WorktreeTests.make_repo(self)
        self.sc("worktree", "--repo", str(root), "--branch", "alx/z", "--dir", "z", "--base", "main")
        wt = root / "z"
        failed = self.sc("spawn", "--kind", "general", "--title", "doomed", "--cwd", str(wt),
                         "--runtime", "fake", stdin="t", env={"SC_FAKE_LAUNCH_FAILS": "1"}, ok=False)
        self.assertIn("fake runtime was told to fail", failed.stderr)
        reg = json.loads((self.home / "state" / "worktrees.json").read_text())
        self.assertIsNone(reg[str(wt.resolve())]["session"])
        self.sc("spawn", "--kind", "general", "--title", "next", "--cwd", str(wt), "--runtime", "fake", stdin="t")

    def test_cleanup_frees_the_worktree_registry_entry(self):
        root = WorktreeTests.make_repo(self)
        self.sc("worktree", "--repo", str(root), "--branch", "alx/w", "--dir", "w", "--base", "main")
        wt = root / "w"
        sid = self.sc("spawn", "--kind", "general", "--title", "first", "--cwd", str(wt),
                      "--runtime", "fake", stdin="t").stdout.split()[1]
        self.sc("cleanup", sid)
        reg = json.loads((self.home / "state" / "worktrees.json").read_text())
        self.assertIsNone(reg[str(wt.resolve())]["session"])

    def test_entries_whose_folder_is_gone_are_dropped_unless_an_active_session_holds_them(self):
        root = WorktreeTests.make_repo(self)
        for name in ("kept", "held", "gone"):
            self.sc("worktree", "--repo", str(root), "--branch", f"alx/{name}", "--dir", name, "--base", "main")
        kept, held, gone = ((root / n).resolve() for n in ("kept", "held", "gone"))
        sid = self.sc("spawn", "--kind", "general", "--title", "holds it", "--cwd", str(held),
                      "--runtime", "fake", stdin="t").stdout.split()[1]
        shutil.rmtree(held)
        shutil.rmtree(gone)
        self.sc("worktree", "--repo", str(root), "--branch", "alx/new", "--dir", "new", "--base", "main")
        reg = json.loads((self.home / "state" / "worktrees.json").read_text())
        self.assertEqual(sorted(reg), sorted(str(p) for p in (kept, held, (root / "new").resolve())))
        self.assertEqual(reg[str(held)]["session"], sid)
        self.sc("cleanup", sid)
        reg = json.loads((self.home / "state" / "worktrees.json").read_text())
        self.assertEqual(sorted(reg), sorted(str(p) for p in (kept, (root / "new").resolve())))


class ResolvedWakesSousChefTests(ScTestCase):
    def test_a_session_closing_its_own_question_wakes_sous_chef(self):
        self.register_chef()
        sid = self.spawn()
        self.as_session(sid, "report", "blocked", "need a token", "--key", "tok")
        self.as_session(sid, "report", "resolved", "Alex answered here", "--key", "tok")
        wakes = [w[1] for w in self.fake_state()["wakes"] if w[0] == "chef"]
        self.assertTrue(any("reported resolved" in w for w in wakes), wakes)
        self.assertIn("resolved", self.sc("events").stdout)


class SummaryTests(ScTestCase):
    def test_summary_caps_a_long_memory_file_and_says_where_to_read_it(self):
        (self.home / "memory").mkdir()
        (self.home / "memory" / "ideas.md").write_text("idea\n" * 4000)
        out = self.sc("summary").stdout
        self.assertIn("read my/memory/ideas.md for the rest", out)
        self.assertLess(len(out), 40000)

    def test_the_owners_instructions_come_right_after_the_owner_line(self):
        (self.home / "instructions.md").write_text("Say yes, chef.\nAsk before writing to the tracker.\n")
        lines = self.sc("summary").stdout.splitlines()
        self.assertTrue(lines[0].startswith("Owner: Alex."))
        self.assertEqual(lines[2], "## Your owner's instructions: follow them as you follow AGENTS.md "
                                   "(my/instructions.md)")
        self.assertEqual(lines[3:5], ["Say yes, chef.", "Ask before writing to the tracker."])

    def test_long_instructions_are_cut_and_the_memory_sections_still_fit(self):
        (self.home / "instructions.md").write_text("rule\n" * 4000)
        (self.home / "memory" / "threads").mkdir(parents=True)
        for rel in ("focus.md", "threads/index.md", "ideas.md", "pocs.md", "repos.md"):
            (self.home / "memory" / rel).write_text(f"{rel}\n" + "x" * 4000 + "\nend of file\n")
        out = self.sc("summary").stdout
        self.assertIn("[... cut at 12000 characters; read my/instructions.md for the rest]", out)
        # Over the old 30,000 limit: the total grew with the instructions, so the memory still fits.
        self.assertGreater(len(out), 30000)
        self.assertTrue(out.rstrip().endswith("repos.md\n" + "x" * 4000 + "\nend of file"))
        self.assertNotIn("summary cut", out)

    def test_no_instructions_file_is_shown_absent(self):
        self.assertIn("(my/instructions.md)\nABSENT", self.sc("summary").stdout)

    def test_summary_marks_missing_memory_files_absent(self):
        self.assertIn("ABSENT", self.sc("summary").stdout)

    def test_summary_shows_sessions_and_what_needs_attention(self):
        sid = self.spawn(title="A task")
        self.as_session(sid, "report", "needs-decision", "which way?")
        out = self.sc("summary").stdout
        self.assertIn("A task", out)
        self.assertIn("Unread events needing attention: 1", out)
        self.assertIn("Open questions: 1", out)

    def test_summary_counts_unread_notes_without_calling_them_attention(self):
        sid = self.spawn()
        self.as_session(sid, "report", "note", "the staging deploy finished")
        out = self.sc("summary").stdout
        self.assertIn("Unread events needing attention: 0", out)
        self.assertIn("Unread notes (no action needed): 1", out)
        self.assertIn("Run `sc events` now.", out)
        self.assertNotIn("Nothing waiting.", out)

    def test_summary_says_nothing_waiting_when_notes_have_been_read(self):
        sid = self.spawn()
        self.as_session(sid, "report", "note", "the staging deploy finished")
        self.sc("events")
        self.sc("events", "ack", f"{sid}:2")
        out = self.sc("summary").stdout
        self.assertIn("Nothing waiting.", out)
        self.assertNotIn("Unread notes", out)


class OwnerTests(ScTestCase):
    """owner.json: who this sous chef works for (`sc owner`)."""

    def owner_file(self):
        return self.home / "owner.json"

    def test_sc_owner_shows_the_owner(self):
        out = self.sc("owner").stdout
        self.assertIn("owner: Alex", out)
        self.assertIn("branch prefix: alx/", out)
        self.assertIn("waiting on: alex", out)

    def test_set_writes_owner_json_and_the_summary_opens_with_it(self):
        self.owner_file().unlink()
        out = self.sc("owner", "set", "--name", "Sam", "--branch-prefix", "sam/").stdout
        self.assertIn("saved owner.json", out)
        self.assertIn("owner: Sam", out)
        self.assertEqual(json.loads(self.owner_file().read_text()), {"name": "Sam", "branch_prefix": "sam/"})
        self.assertEqual(self.sc("summary").stdout.splitlines()[0], "Owner: Sam. Branch prefix: sam/.")

    def test_set_refuses_a_name_that_is_another_waiting_on_value_and_a_prefix_with_spaces(self):
        for name in ("agent", "Nobody", "SC", "external", "owner", " "):
            self.sc("owner", "set", "--name", name, "--branch-prefix", "x/", ok=False)
        self.assertIn("without spaces", self.sc("owner", "set", "--name", "Sam", "--branch-prefix", "s am/",
                                                ok=False).stderr)
        for name in ("Sam\rNOT FROM SAM", "Sam\nX", "Sam\tX", "Sam\x1b[2K"):
            self.assertIn("printable", self.sc("owner", "set", "--name", name, "--branch-prefix", "x/",
                                               ok=False).stderr)
        self.assertIn("usage: sc owner set", self.sc("owner", "set", "--name", "Sam", ok=False).stderr)
        self.assertEqual(json.loads(self.owner_file().read_text())["name"], "Alex")

    def test_an_empty_branch_prefix_is_allowed(self):
        self.sc("owner", "set", "--name", "Sam", "--branch-prefix", "")
        self.assertEqual(self.sc("summary").stdout.splitlines()[0], "Owner: Sam. Branch prefix: (none).")

    def test_without_an_owner_spawn_and_events_refuse_with_the_fix(self):
        sid = self.spawn()
        self.owner_file().unlink()
        fix = "no owner set: run sc owner set --name <name> --branch-prefix <prefix>"
        self.assertIn("no owner set", self.sc("owner").stdout)
        out = self.sc("spawn", "--kind", "general", "--title", "x", "--cwd", str(self.work),
                      "--runtime", "fake", stdin="task", ok=False)
        self.assertIn(fix, out.stderr)
        self.assertEqual(list(self.fake_state()["sessions"]), [sid], "nothing new is launched")
        self.assertIn(fix, self.sc("events", ok=False).stderr)

    def test_without_an_owner_the_summary_still_shows_everything_and_says_so_first(self):
        sid = self.spawn(title="A task")
        self.owner_file().unlink()
        for out in (self.sc("summary").stdout,
                    json.loads(self.sc("hook", "chef-start",
                                       stdin=json.dumps({"session_id": "chef-1", "source": "startup"}),
                                       env={"SC_WATCH_DISABLE_ENSURE": "1"}).stdout
                               )["hookSpecificOutput"]["additionalContext"]):
            self.assertIn("No owner set: run `sc owner set --name <name> --branch-prefix <prefix>`.", out)
            self.assertIn(sid, out)
            self.assertIn("## Attention", out)
        self.assertTrue(self.sc("summary").stdout.startswith("No owner set"))

    def test_without_an_owner_the_read_only_views_still_work(self):
        sid = self.spawn()
        self.owner_file().unlink()
        self.assertIn("general", self.sc("kinds", "--runtime", "fake").stdout)
        self.assertIn(sid, self.sc("sessions").stdout)
        self.assertIn(sid, self.sc("status", sid).stdout)

    def test_an_unreadable_owner_json_is_named_in_the_summary_and_refuses_spawn(self):
        self.owner_file().write_text("{not json")
        self.assertIn("No usable owner", self.sc("summary").stdout.splitlines()[0])
        self.assertIn("not valid JSON", self.sc("spawn", "--kind", "general", "--title", "x", "--cwd",
                                                str(self.work), "--runtime", "fake", stdin="t", ok=False).stderr)
        self.owner_file().write_text(json.dumps({"name": "Sam"}))
        self.assertIn("needs a name and a branch_prefix", self.sc("events", ok=False).stderr)

    def test_a_hand_edited_owner_json_is_checked_on_every_read(self):
        """owner.json is tracked and can be edited by hand, so reading it applies the same checks as setting it."""
        for name in ("Agent", "Sam\rNOT FROM SAM"):
            self.owner_file().write_text(json.dumps({"name": name, "branch_prefix": "x/"}))
            self.assertIn("cannot be used", self.sc("spawn", "--kind", "general", "--title", "x", "--cwd",
                                                    str(self.work), "--runtime", "fake", stdin="t", ok=False).stderr)
            self.assertIn("No usable owner", self.sc("summary").stdout.splitlines()[0])
            self.assertIn("starts waiting on agent", self.sc("kinds", "--runtime", "fake").stdout)

    def test_the_owner_file_is_kept_by_the_data_folder_and_ignored_by_the_core(self):
        self.assertIn("/owner.json", (REPO / ".gitignore").read_text().split())
        sys.path.insert(0, str(CODE / "lib"))
        from sc.setup import DATA_GITIGNORE
        self.assertNotIn("owner.json", DATA_GITIGNORE)


class OwnerNameTests(ScTestCase):
    """What sessions, kinds, events and the watcher say and store now that the owner is a setting."""

    def become(self, name, prefix):
        (self.home / "owner.json").write_text(json.dumps({"name": name, "branch_prefix": prefix}))

    def brief(self, sid):
        return (self.home / "state" / "sessions" / sid / "brief.md").read_text()

    def append_event(self, sid, **event):
        path = self.home / "state" / "sessions" / sid / "events.jsonl"
        seq = len(path.read_text().splitlines()) + 1
        with open(path, "a") as f:
            f.write(json.dumps({"seq": seq, "ts": self.clock, "author": "sc", "text": "", **event}) + "\n")

    def test_a_second_owners_briefs_name_them_and_never_alex(self):
        self.become("Sam", "sam/")
        self.user_kind("pairing-page", body="Open the page for\n{{owner}}.")
        for kind in core_paths.core_kind_names() + ["pairing-page"]:
            brief = self.brief(self.spawn(kind=kind, title=f"{kind} task"))
            self.assertIn("**sous chef**, Sam's agent that keeps track of Sam's work", brief)
            self.assertNotIn("alex", brief.replace(str(CODE), "<CODE>").lower())  # the checkout's own path aside
            self.assertNotIn("{{", brief)
        self.assertIn("Open the page for\nSam.", self.brief(self.spawn(kind="pairing-page", title="again")))

    def test_a_placeholder_in_the_task_is_left_as_written(self):
        sid = self.spawn(task="Write {{owner}} and {{task}} and {{kind_instructions}} literally.")
        self.assertIn("Write {{owner}} and {{task}} and {{kind_instructions}} literally.", self.brief(sid))

    def test_a_cron_workers_note_names_the_owner(self):
        self.become("Sam", "sam/")
        self.register_chef()
        self.sc("cron", "add", "scan", "--every", "6h", "--target", "worker", "--kind", "general",
                "--cwd", str(self.work), "--runtime", "fake", stdin="scan {{owner}}'s inbox")
        self.sc("cron", "run", "scan")
        [sid] = [l.split()[1] for l in self.sc("sessions").stdout.splitlines() if l.startswith("- ")]
        brief = self.brief(sid)
        self.assertIn("only report what is worth Sam's attention", brief)
        self.assertIn("scan {{owner}}'s inbox", brief)

    def test_waiting_on_the_owner_is_stored_as_owner_and_shown_as_their_name(self):
        sid = self.spawn(kind=self.owner_kind())
        self.assertEqual(self.events(sid)[0]["waiting_on"], "owner")
        self.assertIn("waiting on: alex", self.sc("status", sid).stdout)
        self.become("Sam", "sam/")
        self.assertIn("waiting on: sam", self.sc("status", sid).stdout)
        self.assertIn("waiting on: sam", self.sc("sessions").stdout)
        self.assertIn("pairing        starts waiting on sam", self.sc("kinds", "--runtime", "fake").stdout)

    def test_a_legacy_owner_value_is_read_as_the_owner(self):
        """Events written before owner.json stored the first owner's name; they are read as `owner`."""
        sid = self.spawn()
        self.append_event(sid, state="marked", waiting_on=LEGACY_OWNER)
        self.assertIn("waiting on: alex", self.sc("status", sid).stdout)
        self.become("Sam", "sam/")
        self.assertIn("waiting on: sam", self.sc("status", sid).stdout)

    def test_a_legacy_owner_session_that_stops_is_still_resumed(self):
        self.register_chef()
        sid = self.spawn()
        self.append_event(sid, state="marked", waiting_on=LEGACY_OWNER)
        self.hook("worker-prompt", sid)
        self.hook("worker-stop", sid)
        self.set_fake(sid, alive=False)
        self.sc("watch", "--once", env={"SC_GONE_GRACE": "60"})
        self.clock += 60
        self.assertIn(f"{sid}: auto-resumed", self.sc("watch", "--once", env={"SC_GONE_GRACE": "60"}).stdout)

    def test_mark_takes_owner_or_the_owners_name_and_stores_owner(self):
        sid = self.spawn()
        for value in ("owner", "alex", "Alex"):
            self.assertIn("is now waiting on: alex", self.sc("mark", sid, value, "why").stdout)
            self.assertEqual(self.events(sid)[-1]["waiting_on"], "owner")
        out = self.sc("mark", sid, "sam", "why", ok=False)
        self.assertIn("waiting-on must be one of: owner (or alex), agent, external, nobody, sc", out.stderr)
        self.become("Sam", "sam/")
        self.assertIn("is now waiting on: sam", self.sc("mark", sid, "sam", "why").stdout)
        self.sc("mark", sid, "alex", "why", ok=False)
        (self.home / "owner.json").unlink()
        self.assertIn("is now waiting on: owner", self.sc("mark", sid, "owner", "why").stdout)
        self.assertIn("one of: owner, agent", self.sc("mark", sid, "alex", "why", ok=False).stderr)

    def test_without_an_owner_the_read_only_views_show_the_stored_value(self):
        sid = self.spawn(kind=self.owner_kind())
        (self.home / "owner.json").unlink()
        self.assertIn("waiting on: owner", self.sc("status", sid).stdout)
        self.assertIn("waiting on: owner", self.sc("sessions").stdout)
        self.assertIn("waiting on: owner", self.sc("summary").stdout)
        kinds = self.sc("kinds", "--runtime", "fake").stdout
        self.assertIn("pairing        starts waiting on owner   pair on an idea with the owner", kinds)

    def test_the_watchers_messages_name_the_owner(self):
        self.become("Sam", "sam/")
        self.register_chef()
        sid = self.spawn()
        self.hook("worker-prompt", sid)
        self.set_fake(sid, prompt="permission prompt (approve Bash: ls)")
        env = {"SC_PROMPT_GRACE": "60"}
        self.sc("watch", "--once", env=env)
        self.clock += 61
        self.sc("watch", "--once", env=env)
        self.assertIn("Tell Sam which session it is and what it asks; Sam answers it with",
                      self.events(sid)[-1]["text"])

    def test_the_first_prompt_waits_for_the_owner(self):
        self.become("Sam", "sam/")
        subprocess.run([str(SOUSCHEF), "--print"], capture_output=True, text=True, env=self.base_env, check=True)
        prompt = self.fake_state()["sessions"]["fake-chef-1"]["launch_prompt"]
        self.assertTrue(prompt.endswith("Then wait for Sam."), prompt)


class OwnerKindTests(ScTestCase):
    """A kind file may name the owner as `owner` or by name; it runs a copy of the code with its own kinds."""

    def setUp(self):
        super().setUp()
        self.code = core_paths.copy_code(Path(self.tmp.name) / "code", root=CODE)

    def copy_sc(self, *args, ok=True):
        out = subprocess.run([str(self.code / "bin" / "sc"), *args], input="do it", capture_output=True, text=True,
                             env={**self.base_env, "SC_FAKE_NOW": str(self.clock)})
        if ok and out.returncode != 0:
            self.fail(f"sc {' '.join(args)} failed: {out.stdout}{out.stderr}")
        return out

    def test_starts_waiting_on_takes_the_owners_name(self):
        (self.code / "kinds" / "pair.md").write_text(
            "---\ndescription: pair with {{owner}}\nstarts_waiting_on: Alex\n---\nWork with {{owner}}.\n")
        self.assertIn("pair           starts waiting on alex    pair with Alex", self.copy_sc("kinds", "--runtime", "fake").stdout)
        out = self.copy_sc("spawn", "--kind", "pair", "--title", "t", "--cwd", str(self.work), "--runtime", "fake")
        sid = out.stdout.split()[1]
        self.assertEqual(json.loads((self.home / "state" / "sessions" / sid / "events.jsonl")
                                    .read_text().splitlines()[0])["waiting_on"], "owner")
        (self.code / "kinds" / "pair.md").write_text("---\nstarts_waiting_on: sam\n---\nx\n")
        self.assertIn("starts_waiting_on must be owner or agent, not 'sam'", self.copy_sc("kinds", "--runtime", "fake", ok=False).stderr)


class CronTests(ScTestCase):
    """Scheduled jobs. The clock starts at 08:00 UTC; TZ is UTC so times of day are predictable."""

    HOUR = 3600

    def setUp(self):
        super().setUp()
        self.base_env["TZ"] = "UTC"
        self.register_chef()
        self.chef(alive=True, busy=False)

    def chef(self, **fields):
        """Set sous chef's own row in the fake runtime: running or not, idle or mid-turn."""
        path = self.home / "state" / "fake-runtime.json"
        data = json.loads(path.read_text()) if path.exists() else {"sessions": {}, "wakes": []}
        data["sessions"].setdefault("chef-1", {}).update(fields)
        path.write_text(json.dumps(data))

    def add(self, name, *args, task="check the inbox", ok=True):
        return self.sc("cron", "add", name, *args, stdin=task, ok=ok)

    def add_worker(self, name, *args):
        return self.add(name, "--target", "worker", "--kind", "general", "--cwd", str(self.work),
                        "--runtime", "fake", *args)

    def watch(self, env=None):
        return self.sc("watch", "--once", env={"SC_SILENT_GRACE": "600", "SC_INBOX_GRACE": "120",
                                                "SC_WAKE_RETRY": "120", **(env or {})}).stdout

    def chef_wakes(self):
        return [w[1] for w in self.fake_state()["wakes"] if w[0] == "chef"]

    def session_wakes(self, sid):
        return [w[1] for w in self.fake_state()["wakes"] if w[0] == sid]

    def cron_events(self):
        path = self.home / "state" / "cron" / "events.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def worker_ids(self):
        return [line.split()[1] for line in self.sc("sessions").stdout.splitlines() if line.startswith("- ")]

    def inbox(self, sid):
        d = self.home / "state" / "sessions" / sid / "inbox"
        return [json.loads(p.read_text()) for p in sorted(d.glob("*.json"))] if d.is_dir() else []

    # --- definitions

    def test_add_writes_a_definition_file_and_list_shows_it(self):
        self.add("email-check", "--at", "16:00,9:00", "--target", "chef",
                 task="read Alex's email and summarise what matters")
        text = (self.home / "cron" / "email-check.md").read_text()
        self.assertIn("at: 16:00,9:00", text)
        self.assertIn("read Alex's email", text)
        self.assertNotIn("delivery", text)
        out = self.sc("cron", "list").stdout
        self.assertIn("email-check: at 09:00, 16:00 | sous chef", out)
        self.assertIn("last fired: never", out)
        self.assertIn("email-check: at 09:00, 16:00, done by you", self.sc("summary").stdout)

    def test_add_refuses_bad_definitions_and_writes_nothing(self):
        chef = ("--target", "chef")
        worker = ("--target", "worker")
        cases = [
            (("Email", "--at", "09:00", *chef), "kebab-case"),
            (("a", "--at", "9am", *chef), "not a time of day"),
            (("a", "--every", "0h", *chef), "not an interval"),
            (("a", *chef), "exactly one schedule"),
            (("a", "--at", "09:00"), "target must be chef or worker"),
            (("a", "--at", "09:00", "--delivery", "queue", *chef), "unrecognized arguments"),
            (("a", "--at", "09:00", *chef, "--cwd", str(self.work)), "only apply to a worker job"),
            (("a", "--at", "09:00", *worker), "needs a kind and a cwd"),
            (("a", "--at", "09:00", *worker, "--kind", "general", "--cwd", str(self.home)),
             "inside the sous chef data folder"),
            (("a", "--at", "09:00", *worker, "--kind", "nope", "--cwd", str(self.work)), "unknown kind"),
        ]
        for args, message in cases:
            self.assertIn(message, self.add(*args, ok=False).stderr, args)
        self.assertIn("task text is empty", self.add("a", "--at", "09:00", *chef, task="", ok=False).stderr)
        self.assertFalse((self.home / "cron").exists() and list((self.home / "cron").iterdir()))
        self.add("a", "--at", "09:00", *chef)
        self.assertIn("already exists", self.add("a", "--at", "10:00", *chef, ok=False).stderr)

    def test_remove_deletes_the_definition_and_its_run_record(self):
        self.add("email-check", "--every", "1h", "--target", "chef")
        self.sc("cron", "remove", "email-check")
        self.assertFalse((self.home / "cron" / "email-check.md").exists())
        self.assertNotIn("email-check", json.loads((self.home / "state" / "cron" / "runs.json").read_text()))
        self.assertIn("No cron jobs", self.sc("cron", "list").stdout)
        self.assertIn("no cron job", self.sc("cron", "remove", "email-check", ok=False).stderr)

    def test_a_hand_edited_broken_definition_is_shown_and_never_fires(self):
        (self.home / "cron").mkdir()
        (self.home / "cron" / "oops.md").write_text("---\nat: noon\ntarget: chef\n---\ndo it\n")
        self.assertIn("oops: BROKEN, never fires until fixed", self.sc("cron", "list").stdout)
        self.assertIn("oops: BROKEN", self.sc("summary").stdout)
        self.clock += 24 * self.HOUR
        self.assertNotIn("oops", self.watch())

    # --- jobs for sous chef: wake if idle, queue if mid-turn

    def test_a_chef_job_fires_at_its_time_and_wakes_an_idle_sous_chef(self):
        self.add("email-check", "--at", "09:00", "--target", "chef", task="read Alex's email")
        self.assertNotIn("email-check", self.watch())
        self.clock += self.HOUR + 30
        out = self.watch()
        self.assertIn("cron email-check: wrote due as cron event #1 for sous chef", out)
        self.assertIn("cron: woke sous chef for unread cron events", out)
        self.assertEqual(self.chef_wakes(), ["sous chef watcher: scheduled jobs are waiting for you. Run `sc events`."])
        out = self.sc("events").stdout
        self.assertIn("[cron] scheduled jobs for sous chef itself", out)
        self.assertIn("due (cron", out)
        self.assertIn("cron job email-check: read Alex's email", out)
        self.assertIn("sc events ack cron:1", out)
        self.sc("events", "ack", "cron:1")
        self.assertEqual(self.sc("events").stdout.strip(), "No unread events.")

    def test_a_chef_job_waits_while_sous_chef_is_mid_turn_then_wakes_it_once_idle(self):
        self.add("email-check", "--every", "6h", "--target", "chef")
        self.chef(busy=True)
        self.clock += 6 * self.HOUR
        self.assertIn("wrote due as cron event #1 for sous chef", self.watch())
        for _ in range(5):  # the watcher must not wake it either, however long the turn lasts
            self.clock += 20 * 60
            self.assertNotIn("woke", self.watch())
        self.assertEqual(self.chef_wakes(), [])
        self.assertIn("Unread events needing attention: 1", self.sc("summary").stdout)
        self.chef(busy=False)
        self.clock += 15
        self.assertIn("cron: woke sous chef for unread cron events", self.watch())
        self.assertEqual(len(self.chef_wakes()), 1)

    def test_an_unknown_busy_state_is_never_treated_as_idle(self):
        self.add("email-check", "--every", "1h", "--target", "chef")
        self.chef(busy=None)
        self.clock += self.HOUR
        self.watch()
        self.clock += self.HOUR / 2
        self.watch()
        self.assertEqual(self.chef_wakes(), [])

    def test_an_unread_cron_event_is_woken_again_with_backoff_until_acked(self):
        self.add("email-check", "--every", "6h", "--target", "chef")
        self.clock += 6 * self.HOUR
        self.watch()
        self.assertEqual(len(self.chef_wakes()), 1)
        self.clock += 60
        self.assertNotIn("woke", self.watch())
        self.clock += 70
        self.assertIn("woke sous chef for unread cron events", self.watch())
        self.assertEqual(len(self.chef_wakes()), 2)
        self.sc("events", "ack", "cron:1")
        self.clock += 5000
        self.assertNotIn("woke", self.watch())

    def test_a_chef_job_fires_again_while_its_previous_event_is_unread(self):
        """Alex: a firing fires. Unread messages stack up; each stays visible."""
        self.add("email-check", "--every", "1h", "--target", "chef")
        self.clock += self.HOUR
        self.watch()
        self.clock += self.HOUR
        self.assertIn("wrote due as cron event #2 for sous chef", self.watch())
        self.assertEqual([e["state"] for e in self.cron_events()], ["due", "due"])
        out = self.sc("events").stdout
        self.assertIn("#1 due", out)
        self.assertIn("#2 due", out)
        self.assertIn("sc events ack cron:2", out)
        self.assertNotIn("skip", self.sc("cron", "list").stdout)

    # --- schedule

    def test_missed_firings_fire_once_when_sous_chef_is_back(self):
        self.add("email-check", "--at", "09:00,16:00", "--target", "chef")
        self.chef(alive=False)
        self.clock += 2 * 24 * self.HOUR
        self.assertIn("due, but sous chef is not running", self.watch())
        self.clock += 60
        self.assertEqual(self.watch().strip(), "")  # said once, not every cycle
        self.assertEqual(self.cron_events(), [])
        self.chef(alive=True)
        self.assertIn("wrote due as cron event #1 for sous chef", self.watch())
        self.clock += 60
        self.assertNotIn("email-check", self.watch())
        self.assertEqual(len(self.cron_events()), 1)

    def test_a_new_job_waits_for_its_next_time_rather_than_firing_for_a_past_one(self):
        self.add("early", "--at", "07:00", "--target", "chef")
        self.clock += 60
        self.assertNotIn("early", self.watch())
        self.clock += 23 * self.HOUR
        self.assertIn("cron early: wrote due as cron event #1", self.watch())

    def test_a_definition_synced_from_elsewhere_also_waits_for_its_next_time(self):
        """A file that arrives without `sc cron add` (git pull on another machine) has no run record here."""
        (self.home / "cron").mkdir()
        (self.home / "cron" / "early.md").write_text("---\nat: 07:00\ntarget: chef\n---\ndo it\n")
        self.assertNotIn("early", self.watch())
        self.clock += 23 * self.HOUR
        self.assertIn("cron early: wrote due as cron event #1", self.watch())

    def test_list_says_why_an_overdue_job_has_not_fired_instead_of_a_due_time(self):
        # Seen live: "next due in 0s" for hours while nothing could fire it.
        self.add("tidy", "--every", "30m", "--target", "chef")
        self.add("email-check", "--at", "09:00", "--target", "chef")
        self.clock += 2 * self.HOUR  # 10:00: both are due, and no watcher runs in the tests
        out = self.sc("cron", "list").stdout
        self.assertIn("WARNING: the watcher is not running", out)
        self.assertIn("OVERDUE: due since", out)
        self.assertEqual(out.count("OVERDUE"), 2)
        self.assertNotIn("in 0s", out)

    def test_list_still_shows_the_next_due_time_for_a_job_that_is_not_overdue(self):
        self.add("email-check", "--at", "09:00", "--target", "chef")
        out = self.sc("cron", "list").stdout
        self.assertIn("next due:", out)
        self.assertNotIn("OVERDUE", out)

    def test_run_fires_now_says_who_was_woken_and_leaves_the_schedule_alone(self):
        self.add("email-check", "--at", "09:00", "--target", "chef")
        env = {"SC_WATCH_DISABLE_ENSURE": "1"}
        out = self.sc("cron", "run", "email-check", env=env).stdout
        self.assertIn("cron job email-check: wrote due as cron event #1 for sous chef", out)
        self.assertIn("Nobody was woken, and nobody will be: the watcher is not running", out)
        out = self.sc("cron", "run", "email-check").stdout  # fires again: nothing is skipped
        self.assertIn("wrote due as cron event #2 for sous chef", out)
        self.assertEqual(self.chef_wakes(), [])
        self.clock += self.HOUR
        self.assertIn("wrote due as cron event #3 for sous chef", self.watch())

    def test_run_on_a_worker_job_says_what_it_launched(self):
        self.add_worker("inbox-scan", "--every", "12h")
        out = self.sc("cron", "run", "inbox-scan").stdout
        [sid] = self.worker_ids()
        self.assertIn(f"cron job inbox-scan: launched {sid}, which starts on the task now (attach: fake attach {sid})", out)

    # --- jobs for a worker

    def test_a_worker_job_launches_a_session_told_it_is_scheduled(self):
        self.add_worker("inbox-scan", "--every", "12h", "--title", "Scan the inbox")
        self.clock += 12 * self.HOUR
        self.assertIn("cron inbox-scan: launched general-scan-the-inbox-", self.watch())
        [sid] = self.worker_ids()
        rec = json.loads((self.home / "state" / "sessions" / sid / "record.json").read_text())
        self.assertEqual(rec["cron"], {"job": "inbox-scan"})
        brief = (self.home / "state" / "sessions" / sid / "brief.md").read_text()
        self.assertIn("check the inbox", brief)
        self.assertIn("cron job `inbox-scan`", brief)
        self.assertIn("sc report nothing-new", brief)
        self.assertEqual(self.chef_wakes(), [])  # a launch alone needs nothing from sous chef

    def test_a_worker_still_in_flight_gets_the_next_firing_queued_until_its_turn_ends(self):
        self.add_worker("inbox-scan", "--every", "1h")
        self.clock += self.HOUR
        self.watch()
        [sid] = self.worker_ids()
        self.set_fake(sid, busy=True)
        self.clock += self.HOUR
        self.assertIn(f"wrote inbox message 1 for {sid}, which is still on an earlier run; it was not woken", self.watch())
        self.assertEqual(self.worker_ids(), [sid])  # no second session
        [msg] = self.inbox(sid)
        self.assertEqual(msg["from"], "cron job inbox-scan")
        self.assertIn("check the inbox", msg["text"])
        for _ in range(3):
            self.clock += 5 * 60
            self.watch()
        self.assertEqual(self.session_wakes(sid), [])  # never interrupted mid-turn
        self.set_fake(sid, busy=False)
        self.clock += 15
        self.assertIn(f"{sid}: re-rang message 1", self.watch())
        self.assertEqual(len(self.session_wakes(sid)), 1)

    def test_a_worker_in_flight_but_idle_is_sent_the_next_firing_and_woken(self):
        self.add_worker("inbox-scan", "--every", "1h")
        self.clock += self.HOUR
        self.watch()
        [sid] = self.worker_ids()
        self.as_session(sid, "report", "needs-decision", "reply to the landlord?")
        self.clock += self.HOUR
        self.assertIn(f"wrote inbox message 1 for {sid}, which is still on an earlier run, and woke it", self.watch())
        self.assertEqual(self.session_wakes(sid),
                         ["sous chef: new message 1 in your inbox. Run `sc inbox`, act on it, then run `sc inbox ack 1`."])

    def test_a_worker_in_flight_gets_every_firing_in_its_inbox_and_no_second_session(self):
        self.add_worker("inbox-scan", "--every", "1h")
        self.clock += self.HOUR
        self.watch()
        [sid] = self.worker_ids()
        self.set_fake(sid, busy=True)
        self.clock += self.HOUR
        self.watch()
        self.clock += self.HOUR
        self.assertIn(f"wrote inbox message 2 for {sid}", self.watch())
        self.assertEqual([m["seq"] for m in self.inbox(sid)], [1, 2])
        self.assertEqual(self.worker_ids(), [sid])

    def test_a_finished_or_dead_worker_is_replaced_by_a_new_session(self):
        self.add_worker("inbox-scan", "--every", "1h")
        self.clock += self.HOUR
        self.watch()
        [first] = self.worker_ids()
        self.as_session(first, "report", "done", "two emails need replies")
        self.clock += self.HOUR
        self.assertIn("cron inbox-scan: launched", self.watch())
        second = [s for s in self.worker_ids() if s != first][0]
        self.set_fake(second, alive=False)  # unfinished, but no longer running: nobody would read a message
        self.clock += self.HOUR
        self.assertIn("cron inbox-scan: launched", self.watch())
        self.assertEqual(len(self.worker_ids()), 3)

    def test_a_workers_done_wakes_sous_chef_as_usual(self):
        self.add_worker("inbox-scan", "--every", "12h")
        self.clock += 12 * self.HOUR
        self.watch()
        [sid] = self.worker_ids()
        self.as_session(sid, "report", "done", "two emails need replies")
        self.assertEqual(self.chef_wakes(), [f"sous chef: session {sid} reported done. Run `sc events`."])
        self.assertIn("cron job inbox-scan", self.sc("events").stdout)

    def test_a_worker_that_finds_nothing_is_archived_without_waking_anyone(self):
        self.add_worker("inbox-scan", "--every", "12h")
        self.clock += 12 * self.HOUR
        self.watch()
        [sid] = self.worker_ids()
        self.as_session(sid, "report", "nothing-new", "checked 14 emails, none need Alex")
        self.assertIn(f"archived {sid}, which found nothing new", self.watch())
        self.assertEqual(self.worker_ids(), [])
        self.assertTrue((self.home / "state" / "archive" / sid / "record.json").is_file())
        self.assertEqual(self.chef_wakes(), [])
        self.assertIn("Nothing waiting.", self.sc("summary").stdout)
        self.assertIn("nothing new", self.sc("cron", "list").stdout)

    def test_only_scheduled_sessions_may_report_nothing_new(self):
        sid = self.spawn()
        out = self.as_session(sid, "report", "nothing-new", "nothing", ok=False)
        self.assertIn("only for sessions a scheduled job launched", out.stderr)
        self.assertEqual([e["state"] for e in self.events(sid)], ["launched"])

    def test_cron_add_refuses_a_worker_whose_kinds_skill_is_missing(self):
        self.user_kind("drafting", extra="skill: draft-it\n")
        self.fake_skills(missing=["draft-it"])
        out = self.add("drafts", "--every", "1h", "--target", "worker", "--kind", "drafting", "--cwd", str(self.work),
                       "--runtime", "fake", ok=False)
        self.assertIn("needs the skill 'draft-it'", out.stderr)
        self.assertNotIn("drafts", self.sc("cron", "list").stdout)
        self.fake_skills()
        self.add("drafts", "--every", "1h", "--target", "worker", "--kind", "drafting", "--cwd", str(self.work),
                 "--runtime", "fake")
        self.assertIn(["draft-it", str(self.work.resolve())], self.fake_state()["skill_checks"])

    def test_cron_add_checks_with_the_jobs_own_runtime(self):
        self.user_kind("drafting", extra="skill: zz-no-such-skill-for-tests\n")
        out = self.sc("cron", "add", "drafts", "--every", "1h", "--target", "worker", "--kind", "drafting",
                      "--cwd", str(self.work), stdin="t", ok=False,
                      env={"CLAUDE_CONFIG_DIR": str(Path(self.tmp.name) / "empty-config")})
        self.assertIn("needs the skill 'zz-no-such-skill-for-tests'", out.stderr)

    def test_a_worker_whose_skill_goes_missing_fails_when_fired_and_still_lists(self):
        self.user_kind("drafting", extra="skill: draft-it\n")
        self.add("drafts", "--every", "1h", "--target", "worker", "--kind", "drafting", "--cwd", str(self.work),
                 "--runtime", "fake")
        self.fake_skills(missing=["draft-it"])
        self.assertIn("drafts", self.sc("cron", "list").stdout)
        self.clock += self.HOUR
        self.assertIn("failed", self.watch())
        [event] = self.cron_events()
        self.assertEqual(event["state"], "failed")
        self.assertIn("needs the skill 'draft-it'", event["text"])

    def test_a_worker_that_cannot_launch_is_reported_to_sous_chef(self):
        self.add_worker("inbox-scan", "--every", "1h")
        self.clock += self.HOUR
        self.assertIn("failed", self.watch(env={"SC_FAKE_LAUNCH_FAILS": "1"}))
        [event] = self.cron_events()
        self.assertEqual(event["state"], "failed")
        self.assertIn("could not launch its session", event["text"])
        self.assertEqual(len(self.chef_wakes()), 1)


class CronWakeNoteTests(RunningWatcherTestCase):
    """What `sc cron run` says about waking sous chef, with a real watcher running. Whether the
    watcher runs is told by its lock, so the test starts one rather than taking the lock itself."""

    def set_chef(self, **fields):
        path = self.state / "fake-runtime.json"
        data = json.loads(path.read_text()) if path.exists() else {"sessions": {}, "wakes": []}
        data["sessions"]["chef-1"] = {"alive": True, "busy": False, **fields}
        path.write_text(json.dumps(data))

    def test_run_says_when_sous_chef_is_idle_busy_or_not_running(self):
        self.copy_sc("cron", "add", "tidy", "--every", "30m", "--target", "chef", stdin="tidy up").check_returncode()
        self.copy_sc("hook", "chef-start", stdin=json.dumps({"session_id": "chef-1", "source": "startup"}),
                     env={"SC_WATCH_DISABLE_ENSURE": "1"}).check_returncode()
        self.set_chef()
        self.assertIn("watcher running", self.copy_sc("watch", "--ensure", poll="3600").stdout)
        # Its first cycle is over, so it will not write fake-runtime.json while the test does.
        self.assertTrue(self.wait_for(lambda: (self.state / "watch.beat").exists()))
        for fields, note in (({}, "it is idle, so the watcher wakes it within one cycle"),
                             ({"busy": True}, "it is mid-turn"),
                             ({"alive": False}, "sous chef is not running")):
            self.set_chef(**fields)
            out = self.copy_sc("cron", "run", "tidy", poll="3600")
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertIn(note, out.stdout)


class WakeTests(unittest.TestCase):
    """The wake path, against a real Unix socket rather than a mock."""

    def setUp(self):
        import sys
        sys.path.insert(0, str(CODE / "lib"))
        from sc import wake
        self.wake = wake

    def test_post_writes_one_json_user_message_line(self):
        import socket as socketlib
        import tempfile
        import threading
        from unittest import mock
        with tempfile.TemporaryDirectory() as d:
            path = f"{d}/4242.sock"
            server = socketlib.socket(socketlib.AF_UNIX, socketlib.SOCK_STREAM)
            server.bind(path)
            server.listen(1)
            received = []

            def accept():
                conn, _ = server.accept()
                received.append(conn.recv(65536).decode())
                conn.close()

            t = threading.Thread(target=accept)
            t.start()
            with mock.patch.object(self.wake, "socket_dirs", return_value=(d,)):
                self.wake.post(4242, "sous chef: hello")
            t.join(5)
            server.close()
        self.assertEqual(len(received), 1)
        self.assertTrue(received[0].endswith("\n"))
        self.assertEqual(json.loads(received[0]),
                         {"type": "user", "message": {"role": "user", "content": "sous chef: hello"}})

    def test_failures_name_what_was_missing(self):
        from unittest import mock
        with self.assertRaises(self.wake.WakeError) as ctx:
            self.wake.post(None, "x")
        self.assertIn("not running", str(ctx.exception))
        with mock.patch.object(self.wake, "socket_dirs", return_value=("/tmp/nothing-here",)):
            with self.assertRaises(self.wake.WakeError) as ctx:
                self.wake.post(4242, "x")
        self.assertIn("/tmp/nothing-here", str(ctx.exception))


class GuardTests(ScTestCase):
    def guard(self, target, session=None):
        args = ["hook", "guard-edit"] + (["--session", session] if session else [])
        out = self.sc(*args, stdin=json.dumps({"tool_input": {"file_path": str(target)}}))
        return json.loads(out.stdout)["hookSpecificOutput"]["permissionDecision"] if out.stdout.strip() else "allow"

    def test_sessions_are_guarded_too_but_may_write_their_own_report(self):
        a = self.spawn(title="a")
        b = self.spawn(title="b")
        sdir = self.home / "state" / "sessions"
        self.assertEqual(self.guard(sdir / b / "events.jsonl", session=a), "deny")
        self.assertEqual(self.guard(sdir / a / "report.md", session=a), "allow")
        self.assertEqual(self.guard(sdir / b / "report.md", session=a), "deny")
        self.assertEqual(self.guard(sdir / a / "report.md"), "deny")  # sous chef itself: no exception

    def test_spawned_sessions_get_the_guard_hook(self):
        sid = self.spawn()
        hooks = self.fake_state()["sessions"][sid]["settings"]["hooks"]["PreToolUse"]
        self.assertEqual(hooks[0]["matcher"], "Edit|Write|MultiEdit|NotebookEdit")
        self.assertIn(f"guard-edit --session {sid}", hooks[0]["hooks"][0]["command"])


class AckResolutionTests(ScTestCase):
    def test_ack_accepts_an_id_prefix_and_really_marks_it_read(self):
        sid = self.spawn(title="prefix task")
        self.as_session(sid, "report", "done", "finished")
        self.sc("events", "ack", f"{sid[:12]}:2")
        self.assertIn("No unread events.", self.sc("events").stdout)
        self.assertEqual(json.loads((self.home / "state" / "cursors.json").read_text()), {sid: 2})

    def test_ack_refuses_an_id_that_matches_nothing(self):
        self.spawn()
        out = self.sc("events", "ack", "no-such-session:3", ok=False)
        self.assertIn("no session matches", out.stderr)
        self.assertFalse((self.home / "state" / "cursors.json").exists())


class ReportFeedbackTests(ScTestCase):
    def test_resolved_refuses_a_key_that_is_not_open(self):
        sid = self.spawn()
        out = self.as_session(sid, "report", "resolved", "--key", "nope", ok=False)
        self.assertIn("no open question with key 'nope'", out.stderr)
        self.assertEqual(len(self.events(sid)), 1)

    def test_report_says_when_sous_chef_could_not_be_woken(self):
        self.register_chef()
        sid = self.spawn()
        data = self.fake_state()
        data["chef_alive"] = False
        (self.home / "state" / "fake-runtime.json").write_text(json.dumps(data))
        out = self.as_session(sid, "report", "done", "finished")
        self.assertIn("could not be woken", out.stdout)
        self.assertEqual(self.events(sid)[-1]["state"], "done")

    def test_send_says_why_a_session_was_not_woken(self):
        sid = self.spawn()
        self.set_fake(sid, alive=False)
        out = self.sc("send", sid, "hello")
        self.assertIn("was not woken", out.stdout)
        self.assertIn("is not running", out.stdout)


class ActivityListingTests(ScTestCase):
    RUNNING = [{"kind": "subagent", "label": "Build TRV-1116 web types", "since": 1_799_999_400.0},
               {"kind": "subagent", "label": "rr2 finder: bugs", "since": 1_799_999_900.0},
               {"kind": "subagent", "label": "rr2 finder: hostile", "since": 1_799_999_900.0},
               {"kind": "shell", "label": "npm run typecheck", "since": 1_799_999_950.0}]

    def test_sessions_shows_what_a_session_is_doing_on_one_extra_line(self):
        sid = self.spawn(title="Orchestrate TRV-1114")
        other = self.spawn(title="Quiet one")
        self.set_fake(sid, activity={"detail": "TRV-1116 building, awaiting builder report", "in_flight": 4,
                                     "running": self.RUNNING})
        out = self.sc("sessions").stdout
        lines = out.splitlines()
        row = next(i for i, line in enumerate(lines) if sid in line)
        self.assertIn("idle, 4 in flight", lines[row])
        self.assertEqual(lines[row + 1],
                         "    doing: TRV-1116 building, awaiting builder report | "
                         "subagents: Build TRV-1116 web types, rr2 finder: bugs, +1 more")
        self.assertNotIn("npm run typecheck", out)
        self.assertEqual(len(lines), 3)  # one line for the quiet session, two for the busy one
        self.assertIn(other, lines[2])
        self.assertIn("doing: TRV-1116", self.sc("summary").stdout)

    def test_status_lists_everything_in_flight(self):
        sid = self.spawn()
        self.set_fake(sid, activity={"detail": "reviewing", "in_flight": 4, "running": self.RUNNING})
        out = self.sc("status", sid).stdout
        self.assertIn("doing: reviewing", out)
        self.assertIn("subagents and background commands in flight: 4", out)
        self.assertIn("subagent: Build TRV-1116 web types, started 10m ago", out)
        self.assertIn("shell: npm run typecheck, started 50s ago", out)

    def test_no_activity_changes_nothing_and_a_stopped_session_shows_none(self):
        sid = self.spawn()
        before = self.sc("sessions").stdout
        self.assertEqual(len(before.splitlines()), 1)
        self.assertNotIn("in flight", before)
        self.set_fake(sid, activity={"detail": "old news", "in_flight": 2, "running": self.RUNNING}, alive=False)
        out = self.sc("sessions").stdout
        self.assertNotIn("old news", out)
        self.assertNotIn("in flight", out)
        self.assertNotIn("doing:", self.sc("status", sid).stdout)


class ClaudeRuntimeParsingTests(unittest.TestCase):
    """The real `claude --bg` output, captured when sous chef launched a session from its own Bash tool."""

    COLOURED = ("backgrounded \u00b7 \x1b[36m80bb6d90\x1b[39m \u00b7 sc-general-e2e-colour-test-d544\n"
                "\x1b[2m  claude agents             list sessions\x1b[22m\n")

    def setUp(self):
        import sys
        sys.path.insert(0, str(CODE / "lib"))
        from sc.runtimes import claude_bg
        self.claude_bg = claude_bg

    def test_short_id_parsed_with_and_without_colour_codes(self):
        self.assertEqual(self.claude_bg.parse_short_id(self.COLOURED), "80bb6d90")
        self.assertEqual(self.claude_bg.parse_short_id("backgrounded · 9624e622 · sc-spike-a\n"), "9624e622")
        self.assertIsNone(self.claude_bg.parse_short_id("Error: not logged in"))

    def test_launch_passes_auto_permission_mode_model_and_effort(self):
        rec = {"id": "x", "cwd": "/", "handle_name": "sc-x", "model": "sonnet", "effort": "high"}
        args = self.claude_bg._launch_args(rec, {"hooks": {}})
        self.assertEqual(args[:4], ["claude", "--bg", "-n", "sc-x"])
        self.assertIn("--permission-mode", args)
        self.assertEqual(args[args.index("--permission-mode") + 1], "auto")
        self.assertEqual(args[args.index("--model") + 1], "sonnet")
        self.assertEqual(args[args.index("--effort") + 1], "high")
        plain = self.claude_bg._launch_args({"id": "y", "cwd": "/", "handle_name": "sc-y"}, {})
        self.assertNotIn("--model", plain)
        self.assertNotIn("--effort", plain)

    def test_each_permission_value_becomes_claude_codes_permission_mode(self):
        base = {"id": "x", "cwd": "/", "handle_name": "sc-x"}
        for value, mode in (("auto", "auto"), ("accept-edits", "acceptEdits"),
                            ("bypass", "bypassPermissions"), ("ask", "manual")):
            args = self.claude_bg._launch_args({**base, "permissions": value}, {})
            self.assertEqual(args[args.index("--permission-mode") + 1], mode)
        # A record from before permissions were recorded ran in auto mode, and still does.
        args = self.claude_bg._launch_args(base, {})
        self.assertEqual(args[args.index("--permission-mode") + 1], "auto")
        with self.assertRaises(Exception) as ctx:
            self.claude_bg._launch_args({**base, "permissions": "sometimes"}, {})
        self.assertIn("no permission mode for 'sometimes'", str(ctx.exception))

    def test_resume_passes_no_flags_so_claude_code_keeps_the_saved_permission_mode(self):
        from unittest import mock
        rec = {"id": "x", "cwd": "/", "permissions": "bypass",
               "handle": {"short_id": "abcd1234", "session_id": "abcd1234-full"}}
        out = subprocess.CompletedProcess([], 0, "backgrounded \u00b7 abcd1234 \u00b7 sc-x\n", "")
        with mock.patch.object(self.claude_bg, "_run", return_value=out) as run, \
                mock.patch.object(self.claude_bg, "status", return_value={"alive": True}):
            self.claude_bg.resume(rec, {}, {})
        self.assertEqual(run.call_args[0][0], ["claude", "--bg", "--resume", "abcd1234-full"])

    def test_status_reports_unknown_busy_rather_than_idle(self):
        from unittest import mock
        rec = {"id": "x", "handle": {"short_id": "abcd1234", "session_id": "full"}}
        rows = {"abcd1234": {"id": "abcd1234", "pid": 7}}  # alive, no status field
        with tempfile.TemporaryDirectory() as cfg, mock.patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": cfg}):
            self.assertEqual(self.claude_bg.status(rec, rows),
                             {"alive": True, "busy": None, "pid": 7, "prompt": None, "activity": None})
        rows = {"abcd1234": {"id": "abcd1234", "pid": 7, "status": "busy"}}
        self.assertIs(self.claude_bg.status(rec, rows)["busy"], True)

    def test_a_session_at_a_permission_prompt_is_busy_and_says_what_it_asks(self):
        # The row and job file as captured live from Claude Code 2.1.278, with a session in manual
        # mode held at a Bash permission prompt.
        from unittest import mock
        rec = {"id": "x", "handle": {"short_id": "fa641f31", "session_id": "full"}}
        row = {"pid": 29557, "id": "fa641f31", "kind": "background", "status": "waiting",
               "waitingFor": "permission prompt", "state": "blocked"}
        with tempfile.TemporaryDirectory() as cfg, mock.patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": cfg}):
            st = self.claude_bg.status(rec, {"fa641f31": row})
            self.assertEqual(st, {"alive": True, "busy": True, "pid": 29557, "prompt": "permission prompt",
                                  "activity": None})
            job = Path(cfg) / "jobs" / "fa641f31"
            job.mkdir(parents=True)
            (job / "state.json").write_text(json.dumps(
                {"state": "working", "tempo": "blocked",
                 "needs": "approve Bash: touch probe-file.txt && echo made-it"}))
            self.assertEqual(self.claude_bg.status(rec, {"fa641f31": row})["prompt"],
                             "permission prompt (approve Bash: touch probe-file.txt && echo made-it)")
            (job / "state.json").write_text("{not json")
            self.assertEqual(self.claude_bg.status(rec, {"fa641f31": row})["prompt"], "permission prompt")

    def test_a_session_that_ended_its_turn_on_a_question_is_not_held_at_a_prompt(self):
        # Seen live: Claude Code's `state` reads "blocked" for a session whose last message asked
        # the user something, with `status` idle, or busy while a background command of its runs.
        # No prompt is open, so it is left to the session's own report.
        rec = {"id": "x", "handle": {"short_id": "826a4277", "session_id": "full"}}
        for status in ("idle", "busy"):
            row = {"pid": 10674, "id": "826a4277", "status": status, "state": "blocked"}
            self.assertIsNone(self.claude_bg.status(rec, {"826a4277": row})["prompt"])

    # The job file of the TRV-1114 orchestrator, read live from Claude Code 2.1.278 while it had
    # ended its turn to wait for its subagents (trimmed: ids and one finished shell entry left out).
    ORCHESTRATOR_JOB = {
        "sessionId": "d5f03c3e-full", "state": "working", "tempo": "active", "cliVersion": "2.1.278",
        "inFlight": {"tasks": 3, "queued": 0, "kinds": ["local_agent"], "drainableMonitors": 0},
        "detail": "TRV-1115 merged; TRV-1116 building, awaiting builder report",
        "fan": [{"id": "a1", "kind": "agent", "label": "Build TRV-1116 web types",
                 "startedAt": 1790079437856, "doneAt": 1790080455527},
                {"id": "a2", "kind": "agent", "label": "rr2 finder: bugs", "startedAt": 1790080199946},
                {"id": "a3", "kind": "agent", "label": "rr2 finder: hostile", "startedAt": 1790080199957},
                {"id": "b1", "kind": "shell", "label": "npm run typecheck", "startedAt": 1790080472808}]}

    def _status_with_job(self, job_text, row_extra=None):
        from unittest import mock
        rec = {"id": "x", "handle": {"short_id": "d5f03c3e", "session_id": "d5f03c3e-full"}}
        row = {"pid": 5, "id": "d5f03c3e", "sessionId": "d5f03c3e-full", "status": "idle", **(row_extra or {})}
        with tempfile.TemporaryDirectory() as cfg, mock.patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": cfg}):
            if job_text is not None:
                job = Path(cfg) / "jobs" / "d5f03c3e"
                job.mkdir(parents=True)
                (job / "state.json").write_text(job_text)
            return self.claude_bg.status(rec, {"d5f03c3e": row})

    def test_activity_is_read_from_the_job_file(self):
        activity = self._status_with_job(json.dumps(self.ORCHESTRATOR_JOB))["activity"]
        self.assertEqual(activity, {
            "detail": "TRV-1115 merged; TRV-1116 building, awaiting builder report",
            "in_flight": 3,
            "running": [{"kind": "subagent", "label": "rr2 finder: bugs", "since": 1790080199.946},
                        {"kind": "subagent", "label": "rr2 finder: hostile", "since": 1790080199.957},
                        {"kind": "shell", "label": "npm run typecheck", "since": 1790080472.808}]})

    def test_a_missing_or_malformed_job_file_gives_no_activity(self):
        for text in (None, "{not json", "[]", "null", json.dumps({"state": "working"})):
            self.assertIsNone(self._status_with_job(text)["activity"], text)

    def test_an_in_flight_count_that_is_not_a_whole_number_reads_as_cannot_tell(self):
        for in_flight in ({"tasks": "4"}, {"tasks": True}, {"tasks": -1}, {"tasks": 2.5}, {"count": 4}, 4, None):
            job = {**self.ORCHESTRATOR_JOB, "inFlight": in_flight}
            self.assertIsNone(self._status_with_job(json.dumps(job))["activity"]["in_flight"], in_flight)

    def test_queued_and_monitors_alone_are_not_work_in_flight(self):
        # Seen live: a finished session (state done, tempo idle) whose job file said queued: 1.
        job = {**self.ORCHESTRATOR_JOB, "inFlight": {"tasks": 0, "queued": 1, "drainableMonitors": 2}}
        self.assertEqual(self._status_with_job(json.dumps(job))["activity"]["in_flight"], 0)

    def test_malformed_fan_entries_are_skipped_and_long_text_is_cut(self):
        job = {"detail": "x" * 500,
               "fan": ["junk", {"kind": "agent"}, {"kind": "agent", "label": "  two\n lines  ", "startedAt": "soon"},
                       {"label": "no kind", "startedAt": 1000}, 7]}
        activity = self._status_with_job(json.dumps(job))["activity"]
        self.assertEqual(len(activity["detail"]), 200)
        self.assertIsNone(activity["in_flight"])
        self.assertEqual(activity["running"], [{"kind": "subagent", "label": "two lines", "since": None},
                                               {"kind": "task", "label": "no kind", "since": 1.0}])
        self.assertIsNone(self._status_with_job(json.dumps({"fan": "nope", "detail": 3}))["activity"])

    def test_a_job_file_for_another_session_is_ignored(self):
        job = {**self.ORCHESTRATOR_JOB, "sessionId": "someone-else"}
        self.assertIsNone(self._status_with_job(json.dumps(job))["activity"])

    def test_a_stopped_session_has_no_activity(self):
        st = self.claude_bg.status({"id": "x", "handle": {"short_id": "d5f03c3e"}}, {})
        self.assertIsNone(st["activity"])

    def test_unparsed_output_falls_back_to_finding_the_session_by_name(self):
        from unittest import mock
        rec = {"id": "x", "cwd": "/", "handle_name": "sc-x"}
        row = {"id": "abcd1234", "sessionId": "abcd1234-full", "name": "sc-x", "pid": 5}
        done = subprocess.CompletedProcess([], 0, "something unexpected", "")
        with mock.patch.object(self.claude_bg, "_run", return_value=done), \
                mock.patch.object(self.claude_bg, "listing", return_value={"abcd1234": row, "abcd1234-full": row}):
            self.assertEqual(self.claude_bg.launch(rec, "p", {}, {}),
                             {"short_id": "abcd1234", "session_id": "abcd1234-full"})
        with mock.patch.object(self.claude_bg, "_run", return_value=done), \
                mock.patch.object(self.claude_bg, "listing", return_value={}):
            with self.assertRaises(Exception) as ctx:
                self.claude_bg.launch(rec, "p", {}, {})
            self.assertIn("did not start the session", str(ctx.exception))


class ContextCheckTests(ScTestCase):
    """sous chef's Stop hook: how full its context is, read from its transcript (lib/sc/context.py).

    The fixtures copy the shape of real transcript lines: one JSON object per line,
    assistant lines carrying message.usage.
    """

    def setUp(self):
        super().setUp()
        self.register_chef()
        self.chef(alive=True, busy=False)
        self.transcript = Path(self.tmp.name) / "chef-1.jsonl"
        self.transcript.write_text(self.line("user", text="hello"))

    def chef(self, **fields):
        path = self.home / "state" / "fake-runtime.json"
        data = json.loads(path.read_text()) if path.exists() else {"sessions": {}, "wakes": []}
        data["sessions"].setdefault("chef-1", {}).update(fields)
        path.write_text(json.dumps(data))

    @staticmethod
    def line(kind="assistant", tokens=None, model="claude-opus-5", usage=None, **extra):
        d = {"type": kind, "uuid": "u", "timestamp": "2026-09-21T10:00:00.000Z", **extra}
        if kind == "assistant":
            u = usage if usage is not None else {"input_tokens": 2, "cache_creation_input_tokens": 100,
                                                  "cache_read_input_tokens": tokens - 102, "output_tokens": 50}
            d["message"] = {"model": model, "role": "assistant", "usage": u}
        elif kind == "user":
            d["message"] = {"role": "user", "content": extra.pop("text", "hi")}
        return json.dumps(d) + "\n"

    def turn(self, tokens=None, **kw):
        """Append an assistant line, then run the Stop hook as Claude Code would."""
        with open(self.transcript, "a") as f:
            f.write(self.line("assistant", tokens, **kw))
        return self.stop()

    def stop(self, payload=None):
        payload = payload or {"session_id": "chef-1", "transcript_path": str(self.transcript),
                              "hook_event_name": "Stop"}
        out = self.sc("hook", "chef-stop", stdin=json.dumps(payload))
        self.assertEqual(out.stdout, "", "a Stop hook's output can keep the turn going; it must print nothing")
        return out

    def turn_on(self, *extra):
        self.sc("context", "set", "--warn-at", "70", "--window", "claude-opus-5=1000", *extra)

    def log(self):
        path = self.home / "state" / "context" / "events.jsonl"
        return [json.loads(x) for x in path.read_text().splitlines()] if path.exists() else []

    def chef_wakes(self):
        return [w[1] for w in self.fake_state()["wakes"] if w[0] == "chef"]

    def test_over_the_threshold_leaves_one_warning_with_numbers_and_what_to_do(self):
        self.turn_on()
        self.turn(712)
        [e] = self.log()
        self.assertEqual(e["state"], "context-high")
        self.assertIn("71.2%", e["text"])
        self.assertIn("712 of 1,000 tokens", e["text"])
        self.assertIn("memory/focus.md", e["text"])
        out = self.sc("events").stdout
        self.assertIn("[context]", out)
        self.assertIn("context:1", out)
        self.assertIn("Unread events needing attention: 1", self.sc("summary").stdout)

    def test_a_warning_does_not_wake_sous_chef_now_or_from_the_watcher(self):
        self.turn_on()
        self.turn(800)
        self.sc("watch", "--once")
        self.clock += 7200
        self.sc("watch", "--once")
        self.assertEqual(self.chef_wakes(), [])
        self.assertEqual(len(self.log()), 1)

    def test_under_the_threshold_says_nothing_but_records_the_reading(self):
        self.turn_on()
        self.turn(650)
        self.assertEqual(self.log(), [])
        out = self.sc("context").stdout
        self.assertIn("Last reading: 65.0% (650 of 1,000 tokens", out)
        self.assertIn("ON: warns at 70.0%", out)

    def test_crossing_then_staying_over_warns_once_until_it_falls_back(self):
        self.turn_on()
        for tokens in (690, 720, 760, 690, 740, 900):  # 690 is above the re-arm level of 60%
            self.turn(tokens)
        self.assertEqual([e["state"] for e in self.log()], ["context-high"])
        self.turn(300)  # compacted
        self.turn(710)
        self.assertEqual([e["state"] for e in self.log()], ["context-high", "context-high"])

    def test_a_compaction_rearms_the_warning(self):
        self.turn_on()
        self.turn(750)
        with open(self.transcript, "a") as f:
            f.write(json.dumps({"type": "system", "subtype": "compact_boundary",
                                "compactMetadata": {"trigger": "auto", "preTokens": 750}}) + "\n")
        self.stop()
        self.assertIn("compacted", self.sc("context").stdout)
        self.turn(720)
        self.assertEqual(len(self.log()), 2)

    def test_a_missing_transcript_is_reported_once_and_its_recovery_once(self):
        self.turn_on()
        missing = {"session_id": "chef-1", "transcript_path": str(self.transcript) + ".gone"}
        self.stop(missing)
        self.stop(missing)
        [e] = self.log()
        self.assertEqual(e["state"], "context-unreadable")
        self.assertIn("transcript not found", e["text"])
        self.assertIn("nothing warns you", e["text"])
        out = self.sc("context").stdout
        self.assertIn("FAILING", out)
        self.assertIn("2 check(s) in a row", out)
        self.assertIn("FAILING", self.sc("summary").stdout)
        self.turn(500)
        self.assertEqual([e["state"] for e in self.log()], ["context-unreadable", "context-readable"])
        self.assertNotIn("FAILING", self.sc("context").stdout)

    def test_last_lines_without_usage_are_a_failure_not_a_quiet_reading(self):
        self.turn_on()
        with open(self.transcript, "a") as f:
            f.write(self.line("user", text="more") * 20)
        self.stop()
        [e] = self.log()
        self.assertEqual(e["state"], "context-unreadable")
        self.assertIn("no assistant turn with usage", e["text"])

    def test_a_changed_usage_shape_is_a_failure_and_an_older_reading_is_not_used(self):
        self.turn_on()
        self.turn(900)  # warned; an older, readable line is now in the file
        self.turn(usage={"prompt_tokens": 950, "completion_tokens": 10})
        states = [e["state"] for e in self.log()]
        self.assertEqual(states, ["context-high", "context-unreadable"])
        self.assertIn("lacks input_tokens, cache_creation_input_tokens, cache_read_input_tokens",
                      self.log()[-1]["text"])
        with open(self.transcript, "a") as f:
            f.write(json.dumps({"type": "assistant", "message": {"model": "claude-opus-5"}}) + "\n")
        self.stop()
        self.assertIn("no `usage` block", self.sc("context").stdout)

    def test_synthetic_subagent_and_half_written_lines_are_skipped(self):
        self.turn_on()
        with open(self.transcript, "a") as f:
            f.write(self.line("assistant", 750))
            f.write(self.line("assistant", model="<synthetic>",
                              usage={"input_tokens": 0, "cache_creation_input_tokens": 0,
                                     "cache_read_input_tokens": 0, "output_tokens": 0}))
            f.write(self.line("assistant", 10, isSidechain=True))
            f.write('{"type": "assistant", "message": {"usa')
        self.stop()
        self.assertEqual([e["state"] for e in self.log()], ["context-high"])
        self.assertIn("75.0%", self.log()[0]["text"])

    def test_the_reader_finds_a_line_across_chunk_boundaries_in_a_large_file(self):
        with open(self.transcript, "a") as f:
            f.write(self.line("assistant", 640))
            for _ in range(60):  # about 3 MB of tool output after it, as a long turn writes
                f.write(self.line("user", text="x" * 50_000))
        out = self.sc("context", "check", "--transcript", str(self.transcript)).stdout
        self.assertIn("context: 640 tokens", out)

    def test_a_model_with_no_window_set_is_a_failure(self):
        self.turn_on()
        self.turn(500, model="claude-sonnet-5")
        [e] = self.log()
        self.assertIn("no window size is set for model claude-sonnet-5", e["text"])

    def test_off_by_default_records_readings_but_writes_no_events(self):
        self.assertIn("OFF", self.sc("context").stdout)
        self.assertIn("Last check: never", self.sc("context").stdout)
        self.stop({"session_id": "chef-1", "transcript_path": str(self.transcript) + ".gone"})
        self.sc("context", "set", "--window", "claude-opus-5=1k")
        self.turn(990)
        self.assertEqual(self.log(), [])
        self.assertIn("Last reading: 99.0%", self.sc("context").stdout)
        self.sc("context", "set", "--warn-at", "70")
        self.sc("context", "off")
        self.assertIn("OFF", self.sc("context").stdout)
        self.assertEqual(json.loads((self.home / "context.json").read_text()),
                         {"windows": {"claude-opus-5": 1000}})

    def test_only_the_registered_sous_chef_is_checked(self):
        self.turn_on()
        with open(self.transcript, "a") as f:
            f.write(self.line("assistant", 900))
        self.stop({"session_id": "someone-else", "transcript_path": str(self.transcript)})
        self.assertEqual(self.log(), [])
        self.assertFalse((self.home / "state" / "context" / "state.json").exists())

    def test_the_transcript_is_found_by_session_id_without_a_path(self):
        self.turn_on()
        fake_home = Path(self.tmp.name) / "userhome"
        proj = fake_home / ".claude" / "projects" / "-some-project"
        proj.mkdir(parents=True)
        (proj / "chef-1.jsonl").write_text(self.line("assistant", 720))
        self.sc("hook", "chef-stop", stdin=json.dumps({"session_id": "chef-1"}), env={"HOME": str(fake_home)})
        self.assertEqual([e["state"] for e in self.log()], ["context-high"])

    def test_a_broken_config_is_reported_not_ignored(self):
        (self.home / "context.json").write_text("{not json")
        self.turn(500)
        [e] = self.log()
        self.assertEqual(e["state"], "context-unreadable")
        self.assertIn("not valid JSON", e["text"])

    def test_bad_settings_are_refused(self):
        self.assertIn("between 0 and 100", self.sc("context", "set", "--warn-at", "120", ok=False).stderr)
        self.assertIn("must be below", self.sc("context", "set", "--warn-at", "70", "--rearm-below", "80",
                                                ok=False).stderr)
        self.assertIn("MODEL=TOKENS", self.sc("context", "set", "--window", "nope", ok=False).stderr)
        self.assertFalse((self.home / "context.json").exists())

    def test_acknowledging_the_context_log(self):
        self.turn_on()
        self.turn(800)
        self.assertIn("acknowledged: context", self.sc("events", "ack", "context:1").stdout)
        self.assertIn("No unread events", self.sc("events").stdout)


if __name__ == "__main__":
    unittest.main()
