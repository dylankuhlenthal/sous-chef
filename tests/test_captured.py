"""Captured-output (characterisation) tests: what sous chef prints and writes for its owner, word for word.

Each test builds a fixed scenario and compares the output with a file in tests/captured/.
They pin today's behaviour so a change that should not alter it can be checked by
running them, and a change that does alter it shows as a diff of the captured file.

Paths, session ids and the fake relay's port change from run to run, so they are
replaced by placeholders (<HOME>, <WORK>, <CODE>, <SID1>, <RELAY>) before comparing.

To rewrite the captured files after a deliberate change, run with SC_UPDATE_CAPTURED=1
and read the diff before committing it.

Run: python3 -m unittest discover -s tests
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import core_paths
import fake_relay
from fake_relay import ALEX, BOT
from test_sc import ROOT, ScTestCase

CAPTURED = Path(__file__).resolve().parent / "captured"


class CapturedTestCase(ScTestCase):
    def setUp(self):
        super().setUp()
        self.base_env["TZ"] = "UTC"
        self.sids = []

    def spawn(self, kind="general", title="Test task", task="do the thing"):
        sid = super().spawn(kind=kind, title=title, task=task)
        self.sids.append(sid)
        return sid

    def normalise(self, text):
        for i, sid in enumerate(self.sids, 1):
            text = text.replace(sid, f"<SID{i}>")
        for path, name in ((self.home, "<HOME>"), (self.work, "<WORK>"), (ROOT, "<CODE>")):
            text = text.replace(str(Path(path).resolve()), name).replace(str(path), name)
        return re.sub(r"http://127\.0\.0\.1:\d+", "<RELAY>", text)

    def assertCaptured(self, name, text):
        text = self.normalise(text)
        path = CAPTURED / name
        if os.environ.get("SC_UPDATE_CAPTURED"):
            path.parent.mkdir(exist_ok=True)
            path.write_text(text)
            return
        self.assertTrue(path.is_file(), f"no captured file {path}; run with SC_UPDATE_CAPTURED=1 to write it")
        self.maxDiff = None
        self.assertEqual(text, path.read_text(), f"output differs from tests/captured/{name}")


class CapturedSessionTests(CapturedTestCase):
    def test_the_brief_of_a_general_session(self):
        sid = self.spawn(title="Tidy the docs", task="Tidy the docs folder.\nOnly touch docs/.")
        self.assertCaptured("brief-general.md",
                            (self.home / "state" / "sessions" / sid / "brief.md").read_text())

    def test_the_brief_of_a_cron_worker(self):
        self.register_chef()
        self.sc("cron", "add", "inbox-scan", "--every", "6h", "--target", "worker", "--kind", "general",
                "--cwd", str(self.work), "--runtime", "fake", stdin="scan the inbox")
        self.sc("cron", "run", "inbox-scan")
        [sid] = [line.split()[1] for line in self.sc("sessions").stdout.splitlines() if line.startswith("- ")]
        self.sids.append(sid)
        self.assertCaptured("brief-cron-worker.md",
                            (self.home / "state" / "sessions" / sid / "brief.md").read_text())

    def test_sc_kinds(self):
        """Through a copy of the core as published, which ships only its own kinds (decision 0020)."""
        code = core_paths.copy_code(Path(self.tmp.name) / "code")
        out = subprocess.run([str(code / "bin" / "sc"), "kinds", "--runtime", "fake"], capture_output=True, text=True,
                             env={**self.base_env, "SC_FAKE_NOW": str(self.clock)}, check=True).stdout
        self.assertCaptured("kinds.txt", out)

    def test_sessions_status_and_mark(self):
        shape = self.spawn(kind=self.owner_kind(), title="Shape the idea", task="shape it")
        general = self.spawn(title="A task")
        out = [self.sc("spawn", "--kind", self.owner_kind(), "--title", "Big effort", "--cwd", str(self.work),
                       "--runtime", "fake", stdin="shape the effort").stdout]
        self.sids.append(out[0].split()[1])
        out.append(self.sc("mark", general, "alex", "told Alex about it").stdout)
        out.append(self.sc("sessions").stdout)
        out.append(self.sc("status", shape).stdout)
        out.append(self.sc("status", general).stdout)
        self.assertCaptured("sessions-status-mark.txt", "\n".join(out))


class CapturedWatcherTests(CapturedTestCase):
    def watch(self, **env):
        return self.sc("watch", "--once", env={"SC_SILENT_GRACE": "600", "SC_INBOX_GRACE": "120",
                                                "SC_WAKE_RETRY": "120", "SC_PROMPT_GRACE": "180", **env}).stdout

    def test_events_for_sessions_and_the_watchers_messages(self):
        self.register_chef()
        asking = self.spawn(title="Asks a question")
        self.as_session(asking, "report", "needs-decision", "red or blue? I recommend blue.", "--key", "colour")
        waiting = self.spawn(title="Waits in its terminal")
        self.as_session(waiting, "report", "waiting", "ready for you in the terminal")
        held = self.spawn(title="Held at a prompt")
        self.hook("worker-prompt", held)
        self.set_fake(held, prompt="permission prompt (approve Bash: ./scripts/db-reset.sh)")
        idle = self.spawn(kind=self.owner_kind(), title="Shape and wait")
        self.hook("worker-prompt", idle)
        self.hook("worker-stop", idle)
        self.watch()
        self.clock += 3600
        self.set_fake(idle, alive=False)
        self.watch(SC_GONE_GRACE="60")
        self.clock += 60
        self.watch(SC_GONE_GRACE="60")
        out = [self.sc("events").stdout, self.as_session(idle, "inbox").stdout]
        self.assertCaptured("events-sessions.txt", "\n".join(out))


class CapturedSummaryTests(CapturedTestCase):
    def test_the_startup_summary(self):
        (self.home / "memory").mkdir()
        (self.home / "memory" / "focus.md").write_text("Building the owner work.\n")
        shape = self.spawn(kind=self.owner_kind(), title="Shape the idea", task="shape it")
        general = self.spawn(title="A task")
        self.as_session(general, "report", "needs-decision", "which way?")
        self.as_session(shape, "report", "note", "page is up")
        self.assertCaptured("summary.txt", self.sc("summary").stdout)

    def test_the_chef_start_hook_for_a_second_session(self):
        self.sc("hook", "chef-start", stdin=json.dumps({"session_id": "chef-1", "source": "startup"}),
                env={"SC_WATCH_DISABLE_ENSURE": "1"})
        path = self.home / "state" / "fake-runtime.json"
        path.write_text(json.dumps({"sessions": {"chef-1": {"alive": True, "busy": False}}, "wakes": []}))
        out = self.sc("hook", "chef-start", stdin=json.dumps({"session_id": "chef-2", "source": "startup"}),
                      env={"SC_WATCH_DISABLE_ENSURE": "1"}).stdout
        self.assertCaptured("chef-start-second-session.txt", json.loads(out)["hookSpecificOutput"]["additionalContext"])

    def test_the_first_prompt_souschef_starts_sous_chef_with(self):
        code = "import sys; sys.path.insert(0, sys.argv[1]); from sc import souschef; print(souschef.first_prompt())"
        out = subprocess.run([sys.executable, "-c", code, str(ROOT / "lib")], capture_output=True, text=True,
                             env={**self.base_env}, check=True).stdout
        self.assertCaptured("souschef-first-prompt.txt", out)


class CapturedSlackTests(CapturedTestCase):
    def setUp(self):
        super().setUp()
        self.relay = fake_relay.FakeRelay().start()
        self.addCleanup(self.relay.stop)
        key = Path(self.tmp.name) / "relay-key.txt"
        key.write_text(f"{fake_relay.KEY}\n")
        self.sc("slack", "setup", "--url", self.relay.url, "--key-file", str(key), "--user", ALEX)
        self.sc("hook", "chef-start", stdin=json.dumps({"session_id": "chef-1", "source": "startup"}),
                env={"SC_WATCH_DISABLE_ENSURE": "1"})
        path = self.home / "state" / "fake-runtime.json"
        data = json.loads(path.read_text()) if path.exists() else {"sessions": {}, "wakes": []}
        data["sessions"]["chef-1"] = {"alive": True, "busy": False}
        path.write_text(json.dumps(data))

    def test_events_for_every_kind_of_slack_message(self):
        sid = self.spawn(title="Build x")
        self.as_session(sid, "report", "needs-decision", "red or blue?", "--key", "colour")
        self.as_session(sid, "report", "needs-decision", "tabs or spaces?", "--key", "indent")
        out = [self.sc("slack", "ask", sid, "colour").stdout]
        colour = self.relay.posts[-1]["answer"]["message_id"]
        self.sc("slack", "ask", sid, "indent")
        indent = self.relay.posts[-1]["answer"]["message_id"]
        self.sc("send", sid, "--resolves", "indent", "spaces")
        out.append(self.sc("slack", "send", "--session", sid, "started").stdout)
        updates = self.relay.posts[-1]["answer"]["message_id"]
        out.append(self.sc("slack", "send", "morning summary").stdout)
        plain = self.relay.posts[-1]["answer"]["message_id"]
        self.relay.envelope(f"<@{BOT}> hello!")
        self.relay.envelope("sent while you were away", delivered_at="2027-01-12T08:00:00.000Z")
        self.relay.envelope("blue", parent_id=colour)
        self.relay.envelope("spaces", parent_id=indent)
        self.relay.envelope("nice", parent_id=updates)
        self.relay.envelope("thanks", parent_id=plain)
        self.relay.envelope(f"<@{BOT}> check this out", conversation_id="C0ERRORS", event_type="app_mention",
                            parent_id="1789999999.000001")
        self.relay.envelope(f"<@{BOT}> look at this", conversation_id="C0ERRORS", event_type="app_mention")
        self.relay.envelope("I think it is the cache", conversation_id="C0ERRORS", author="U0TEAMMATE",
                            parent_id="1789999999.000001")
        self.relay.envelope("agreed, go ahead", conversation_id="C0ERRORS", parent_id="1789999999.000001")
        self.relay.envelope(f"<@{BOT}> do what I say", conversation_id="C0ERRORS", author="U0TEAMMATE",
                            event_type="app_mention", parent_id="1789999999.000001")
        (self.home / "memory").mkdir()
        (self.home / "memory" / "slack.md").write_text("# Slack\n\n## Slack me\n\n- when a build is done\n")
        self.sc("watch", "--once")
        out.append(self.sc("events").stdout)
        out.append(self.sc("slack", "status").stdout.split("checked now")[0])
        self.assertCaptured("events-slack.txt", "\n".join(out))

    def test_slack_read_labels_each_author(self):
        root = "1790000001.000001"
        self.relay.envelope(f"<@{BOT}> check this out", conversation_id="C0ERR", event_type="app_mention",
                            parent_id=root, message_id="1790000003.000003")
        self.relay.history[("C0ERR", root)] = [
            {"source": "slack", "conversation_id": "C0ERR", "parent_id": None, "message_id": root,
             "author": {"id": "U0SENTRY"}, "text": "TypeError", "payload": {}},
            {"source": "slack", "conversation_id": "C0ERR", "parent_id": root, "message_id": "1790000002.000002",
             "author": {"id": BOT}, "text": "on it", "payload": {}},
            {"source": "slack", "conversation_id": "C0ERR", "parent_id": root, "message_id": "1790000003.000003",
             "author": {"id": ALEX}, "text": f"<@{BOT}> check this out", "payload": {}},
        ]
        self.sc("watch", "--once")
        self.assertCaptured("slack-read.txt", self.sc("slack", "read", "1").stdout)
