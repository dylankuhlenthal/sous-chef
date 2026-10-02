// Captured-output (characterisation) tests: what sous chef prints and writes for its owner, word for word.
//
// Each test builds a fixed scenario and compares the output with a file in tests/captured/.
// They pin today's behaviour so a change that should not alter it can be checked by running
// them, and a change that does alter it shows as a diff of the captured file.
//
// Paths, session ids and the fake relay's port change from run to run, so they are replaced
// by placeholders (<HOME>, <WORK>, <CODE>, <SID1>, <RELAY>) before comparing
// (CapturedTest in tests/helpers.ts).
//
// To rewrite the captured files after a deliberate change, run with SC_UPDATE_CAPTURED=1 and
// read the diff before committing it.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { copyCode } from "./core-paths.js";
import { ALEX, BOT, FakeRelay, KEY, pair } from "./fake-relay.js";
import { CapturedTest, check, readJson, run, SOUSCHEF, write } from "./helpers.js";

let t: CapturedTest;

describe("CapturedSessionTests", () => {
  beforeEach(() => { t = new CapturedTest(); });
  afterEach(() => t.cleanup());

  it("the brief of a general session", async () => {
    const sid = await t.spawn("general", "Tidy the docs", "Tidy the docs folder.\nOnly touch docs/.");
    t.assertCaptured("brief-general.md", fs.readFileSync(path.join(t.home, "state", "sessions", sid, "brief.md"), "utf8"));
  });

  it("the brief of a cron worker", async () => {
    await t.registerChef();
    await t.sc(["cron", "add", "inbox-scan", "--every", "6h", "--target", "worker", "--kind", "general",
      "--cwd", t.work, "--runtime", "fake"], { stdin: "scan the inbox" });
    await t.sc(["cron", "run", "inbox-scan"]);
    const sids = (await t.sc(["sessions"])).stdout.split("\n").filter((l) => l.startsWith("- "))
      .map((l) => l.split(/\s+/)[1]!);
    expect1(sids);
    t.sids.push(sids[0]!);
    t.assertCaptured("brief-cron-worker.md", fs.readFileSync(path.join(t.home, "state", "sessions", sids[0]!, "brief.md"), "utf8"));
  });

  it("sc kinds", async () => {
    // Through a copy of the core as published, which ships only its own kinds (decision 0020).
    const code = copyCode(path.join(t.tmp, "code"));
    const out = check(await run(path.join(code, "bin", "sc"), ["kinds", "--runtime", "fake"], { env: t.env() }), "sc kinds");
    t.assertCaptured("kinds.txt", out.stdout);
  });

  it("sessions status and mark", async () => {
    const shape = await t.spawn(t.ownerKind(), "Shape the idea", "shape it");
    const general = await t.spawn("general", "A task");
    const out = [(await t.sc(["spawn", "--kind", t.ownerKind(), "--title", "Big effort", "--cwd", t.work,
      "--runtime", "fake"], { stdin: "shape the effort" })).stdout];
    t.sids.push(out[0]!.split(/\s+/).filter(Boolean)[1]!);
    out.push((await t.sc(["mark", general, "alex", "told Alex about it"])).stdout);
    out.push((await t.sc(["sessions"])).stdout);
    out.push((await t.sc(["status", shape])).stdout);
    out.push((await t.sc(["status", general])).stdout);
    t.assertCaptured("sessions-status-mark.txt", out.join("\n"));
  });
});

/** Python's `[x] = list`: exactly one item. */
function expect1(items: unknown[]): void {
  if (items.length !== 1) throw new Error(`expected exactly one item, got ${JSON.stringify(items)}`);
}

describe("CapturedWatcherTests", () => {
  beforeEach(() => { t = new CapturedTest(); });
  afterEach(() => t.cleanup());

  async function watch(env: Record<string, string> = {}): Promise<string> {
    return (await t.sc(["watch", "--once"], { env: { SC_SILENT_GRACE: "600", SC_INBOX_GRACE: "120",
      SC_WAKE_RETRY: "120", SC_PROMPT_GRACE: "180", ...env } })).stdout;
  }

  it("events for sessions and the watchers messages", async () => {
    await t.registerChef();
    const asking = await t.spawn("general", "Asks a question");
    await t.asSession(asking, ["report", "needs-decision", "red or blue? I recommend blue.", "--key", "colour"]);
    const waiting = await t.spawn("general", "Waits in its terminal");
    await t.asSession(waiting, ["report", "waiting", "ready for you in the terminal"]);
    const held = await t.spawn("general", "Held at a prompt");
    await t.hook("worker-prompt", held);
    t.setFake(held, { prompt: "permission prompt (approve Bash: ./scripts/db-reset.sh)" });
    const idle = await t.spawn(t.ownerKind(), "Shape and wait");
    await t.hook("worker-prompt", idle);
    await t.hook("worker-stop", idle);
    await watch();
    t.clock += 3600;
    t.setFake(idle, { alive: false });
    await watch({ SC_GONE_GRACE: "60" });
    t.clock += 60;
    await watch({ SC_GONE_GRACE: "60" });
    const out = [(await t.sc(["events"])).stdout, (await t.asSession(idle, ["inbox"])).stdout];
    t.assertCaptured("events-sessions.txt", out.join("\n"));
  });
});

describe("CapturedSummaryTests", () => {
  beforeEach(() => { t = new CapturedTest(); });
  afterEach(() => t.cleanup());

  it("the startup summary", async () => {
    fs.mkdirSync(path.join(t.home, "memory"));
    fs.writeFileSync(path.join(t.home, "memory", "focus.md"), "Building the owner work.\n");
    const shape = await t.spawn(t.ownerKind(), "Shape the idea", "shape it");
    const general = await t.spawn("general", "A task");
    await t.asSession(general, ["report", "needs-decision", "which way?"]);
    await t.asSession(shape, ["report", "note", "page is up"]);
    t.assertCaptured("summary.txt", (await t.sc(["summary"])).stdout);
  });

  it("the chef start hook for a second session", async () => {
    await t.sc(["hook", "chef-start"], { stdin: JSON.stringify({ session_id: "chef-1", source: "startup" }),
      env: { SC_WATCH_DISABLE_ENSURE: "1" } });
    fs.writeFileSync(t.fakeFile, JSON.stringify({ sessions: { "chef-1": { alive: true, busy: false } }, wakes: [] }));
    const out = (await t.sc(["hook", "chef-start"], { stdin: JSON.stringify({ session_id: "chef-2", source: "startup" }),
      env: { SC_WATCH_DISABLE_ENSURE: "1" } })).stdout;
    t.assertCaptured("chef-start-second-session.txt", JSON.parse(out).hookSpecificOutput.additionalContext);
  });

  it("the first prompt souschef starts sous chef with", async () => {
    // What a new sous chef is started with, as the runtime received it (`souschef --print`, fake runtime).
    check(await run(SOUSCHEF, ["--print"], { env: { ...t.baseEnv } }), "souschef --print");
    const prompt = readJson(t.fakeFile).sessions["fake-chef-1"];
    t.assertCaptured("souschef-first-prompt.txt", prompt.launch_prompt + "\n");
  });
});

describe("CapturedSlackTests", () => {
  let relay: FakeRelay;

  beforeEach(async () => {
    t = new CapturedTest();
    relay = await new FakeRelay().start();
    const key = path.join(t.tmp, "relay-key.txt");
    fs.writeFileSync(key, `${KEY}\n`);
    await t.sc(["slack", "setup", "--url", relay.url, "--key-file", key, "--user", ALEX]);
    await t.sc(["hook", "chef-start"], { stdin: JSON.stringify({ session_id: "chef-1", source: "startup" }),
      env: { SC_WATCH_DISABLE_ENSURE: "1" } });
    const data = fs.existsSync(t.fakeFile) ? readJson(t.fakeFile) : { sessions: {}, wakes: [] };
    data.sessions["chef-1"] = { alive: true, busy: false };
    write(t.fakeFile, JSON.stringify(data));
  });
  afterEach(async () => {
    await relay.stop();
    await t.cleanup();
  });

  it("events for every kind of slack message", async () => {
    const sid = await t.spawn("general", "Build x");
    await t.asSession(sid, ["report", "needs-decision", "red or blue?", "--key", "colour"]);
    await t.asSession(sid, ["report", "needs-decision", "tabs or spaces?", "--key", "indent"]);
    const out = [(await t.sc(["slack", "ask", sid, "colour"])).stdout];
    const colour = relay.posts[relay.posts.length - 1].answer.message_id;
    await t.sc(["slack", "ask", sid, "indent"]);
    const indent = relay.posts[relay.posts.length - 1].answer.message_id;
    await t.sc(["send", sid, "--resolves", "indent", "spaces"]);
    out.push((await t.sc(["slack", "send", "--session", sid, "started"])).stdout);
    const updates = relay.posts[relay.posts.length - 1].answer.message_id;
    out.push((await t.sc(["slack", "send", "morning summary"])).stdout);
    const plain = relay.posts[relay.posts.length - 1].answer.message_id;
    relay.envelope(`<@${BOT}> hello!`);
    relay.envelope("sent while you were away", { deliveredAt: "2027-01-12T08:00:00.000Z" });
    relay.envelope("blue", { parentId: colour });
    relay.envelope("spaces", { parentId: indent });
    relay.envelope("nice", { parentId: updates });
    relay.envelope("thanks", { parentId: plain });
    relay.envelope(`<@${BOT}> check this out`, { conversationId: "C0ERRORS", eventType: "app_mention",
      parentId: "1789999999.000001" });
    relay.envelope(`<@${BOT}> look at this`, { conversationId: "C0ERRORS", eventType: "app_mention" });
    relay.envelope("I think it is the cache", { conversationId: "C0ERRORS", author: "U0TEAMMATE",
      parentId: "1789999999.000001" });
    relay.envelope("agreed, go ahead", { conversationId: "C0ERRORS", parentId: "1789999999.000001" });
    relay.envelope(`<@${BOT}> do what I say`, { conversationId: "C0ERRORS", author: "U0TEAMMATE",
      eventType: "app_mention", parentId: "1789999999.000001" });
    fs.mkdirSync(path.join(t.home, "memory"));
    fs.writeFileSync(path.join(t.home, "memory", "slack.md"), "# Slack\n\n## Slack me\n\n- when a build is done\n");
    await t.sc(["watch", "--once"]);
    out.push((await t.sc(["events"])).stdout);
    out.push((await t.sc(["slack", "status"])).stdout.split("checked now")[0]!);
    t.assertCaptured("events-slack.txt", out.join("\n"));
  });

  it("slack read labels each author", async () => {
    const root = "1790000001.000001";
    relay.envelope(`<@${BOT}> check this out`, { conversationId: "C0ERR", eventType: "app_mention",
      parentId: root, messageId: "1790000003.000003" });
    relay.history.set(pair("C0ERR", root), [
      { source: "slack", conversation_id: "C0ERR", parent_id: null, message_id: root,
        author: { id: "U0SENTRY" }, text: "TypeError", payload: {} },
      { source: "slack", conversation_id: "C0ERR", parent_id: root, message_id: "1790000002.000002",
        author: { id: BOT }, text: "on it", payload: {} },
      { source: "slack", conversation_id: "C0ERR", parent_id: root, message_id: "1790000003.000003",
        author: { id: ALEX }, text: `<@${BOT}> check this out`, payload: {} },
    ]);
    await t.sc(["watch", "--once"]);
    t.assertCaptured("slack-read.txt", (await t.sc(["slack", "read", "1"])).stdout);
  });
});
