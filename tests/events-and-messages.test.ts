// Behaviour tests for sc, run against the real command line with the fake runtime: what
// sessions report, the events and open questions sous chef reads, and the messages it sends.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJson, ScTest } from "./helpers.js";

let t: ScTest;

/** The last line of `sc events` names the ack command; this is its token. */
function ackToken(out: string): string {
  const lines = out.trim().split("\n");
  return lines[lines.length - 1]!.split("ack ")[1]!;
}

describe("ReportTests", () => {
  beforeEach(() => { t = new ScTest(); });
  afterEach(() => t.cleanup());

  it("report requires a claude session", async () => {
    const out = await t.sc(["report", "done", "finished"], { ok: false });
    expect(out.stderr).toContain("CLAUDE_CODE_SESSION_ID is not set");
  });

  it("report refuses a claude session sous chef did not launch", async () => {
    await t.spawn();
    const out = await t.sc(["report", "done", "x"], { env: { CLAUDE_CODE_SESSION_ID: "someone-else" }, ok: false });
    expect(out.stderr).toContain("is not one sous chef launched");
  });

  it("stale session variable from a spare process is ignored", async () => {
    const first = await t.spawn("general", "first");
    const second = await t.spawn("general", "second");
    await t.sc(["report", "done", "second finished"],
      { env: { SC_SESSION_ID: first, CLAUDE_CODE_SESSION_ID: `fake-${second}` } });
    expect(t.events(second).at(-1).text).toBe("second finished");
    expect(t.events(first).at(-1).state).toBe("launched");
  });

  it("needs decision gets a key and wakes chef", async () => {
    await t.registerChef();
    const sid = await t.spawn();
    const out = await t.asSession(sid, ["report", "needs-decision", "red or blue?"]);
    expect(out.stdout).toContain("key q2");
    expect(t.fakeState().wakes).toContainEqual(["chef", `sous chef: session ${sid} reported needs-decision. Run \`sc events\`.`]);
  });

  it("working and note do not wake chef", async () => {
    await t.registerChef();
    const sid = await t.spawn();
    await t.asSession(sid, ["report", "working", "building now"]);
    await t.asSession(sid, ["report", "note", "fyi"]);
    expect((t.fakeState().wakes as string[][]).filter((w) => w[0] === "chef")).toEqual([]);
  });

  it("unknown state and resolved without key are refused", async () => {
    const sid = await t.spawn();
    expect((await t.asSession(sid, ["report", "finished", "x"], { ok: false })).stderr).toContain("unknown state");
    expect((await t.asSession(sid, ["report", "resolved"], { ok: false })).stderr).toContain("needs --key");
  });

  it("a question reported as a note is refused and writes nothing", async () => {
    const sid = await t.spawn();
    const out = await t.asSession(sid, ["report", "note",
      "needs-decision raised: red or blue? sent sous chef my recommendation"],
    { ok: false });
    expect(out.stderr).toContain("reads like a question");
    expect(out.stderr).toContain("sc report needs-decision");
    expect(t.events(sid).map((e) => e.state)).toEqual(["launched"]);
  });

  it("the note refusal matches the spaced spelling and ignores case", async () => {
    const sid = await t.spawn();
    for (const text of ["Needs Decision: which database?", "NEEDS-DECISION on the schema"]) {
      expect((await t.asSession(sid, ["report", "note", text], { ok: false })).stderr).toContain("reads like a question");
    }
  });

  it("an ordinary note is still accepted", async () => {
    const sid = await t.spawn();
    await t.asSession(sid, ["report", "note", "the staging deploy finished while I was reading"]);
    expect(t.events(sid).at(-1).state).toBe("note");
  });

  // A done report may legitimately recount the questions it raised.
  it("only notes are checked for questions", async () => {
    const sid = await t.spawn();
    await t.asSession(sid, ["report", "done", "finished; raised one needs-decision on the way"]);
    expect(t.events(sid).at(-1).state).toBe("done");
  });
});

describe("EventsAndQuestionsTests", () => {
  beforeEach(() => { t = new ScTest(); });
  afterEach(() => t.cleanup());

  it("unread events repeat until acked", async () => {
    const sid = await t.spawn();
    await t.asSession(sid, ["report", "done", "PR https://example/pr/1"]);
    const first = (await t.sc(["events"])).stdout;
    expect(first).toContain("done");
    expect((await t.sc(["events"])).stdout).toContain("PR https://example/pr/1");
    const token = ackToken(first);
    await t.sc(["events", "ack", token]);
    expect((await t.sc(["events"])).stdout).toContain("No unread events.");
  });

  it("events written by sous chef are not shown as unread", async () => {
    await t.spawn();
    expect((await t.sc(["events"])).stdout).toContain("No unread events.");
  });

  it("open question stays listed after ack until resolved", async () => {
    const sid = await t.spawn();
    await t.asSession(sid, ["report", "needs-decision", "red or blue?"]);
    let out = (await t.sc(["events"])).stdout;
    await t.sc(["events", "ack", ackToken(out)]);
    out = (await t.sc(["events"])).stdout;
    expect(out).toContain("OPEN QUESTIONS");
    expect(out).toContain("red or blue?");
    await t.sc(["send", sid, "--resolves", "q2", "blue"]);
    expect((await t.sc(["events"])).stdout).not.toContain("OPEN QUESTIONS");
    expect((await t.sc(["sessions"])).stdout).toContain("waiting on: agent");
  });

  it("resolving an unknown key is refused and writes nothing", async () => {
    const sid = await t.spawn();
    const out = await t.sc(["send", sid, "--resolves", "nope", "answer"], { ok: false });
    expect(out.stderr).toContain("no open question with key 'nope'");
    expect(fs.existsSync(path.join(t.home, "state", "sessions", sid, "inbox"))).toBe(false);
  });

  it("session can resolve its own question", async () => {
    const sid = await t.spawn();
    await t.asSession(sid, ["report", "blocked", "need a token", "--key", "token"]);
    await t.asSession(sid, ["report", "resolved", "--key", "token"]);
    expect((await t.sc(["events"])).stdout).not.toContain("OPEN QUESTIONS");
  });

  it("resolved accepts its text after the key", async () => {
    // The brief tells sessions to run exactly this form.
    const sid = await t.spawn();
    await t.asSession(sid, ["report", "blocked", "need a token", "--key", "token"]);
    await t.asSession(sid, ["report", "resolved", "--key", "token", "Alex", "answered", "here"]);
    expect(t.events(sid).at(-1).text).toBe("Alex answered here");
    expect((await t.sc(["events"])).stdout).not.toContain("OPEN QUESTIONS");
  });

  it("positionals may come after options in every subcommand", async () => {
    const sid = await t.spawn();
    await t.asSession(sid, ["report", "--key", "k", "blocked", "need a token"]);
    await t.sc(["send", "--resolves", "k", sid, "here it is"]);
    await t.sc(["mark", sid, "alex", "told Alex"]);
    await t.sc(["cron", "add", "--at", "09:00", "--target", "chef", "email-check"], { stdin: "read the email" });
    const file = path.join(t.home, "cron", "email-check.md");
    expect(fs.existsSync(file) && fs.statSync(file).isFile()).toBe(true);
  });

  it("waiting on follows the latest state", async () => {
    const sid = await t.spawn();
    for (const [state, expected] of [["working", "agent"], ["needs-decision", "sc"], ["waiting", "alex"],
      ["paused", "external"], ["done", "nobody"]] as const) {
      await t.asSession(sid, ["report", state, "x"]);
      expect((await t.sc(["sessions"])).stdout, state).toContain(`waiting on: ${expected}`);
    }
    await t.sc(["mark", sid, "alex", "told Alex"]);
    expect((await t.sc(["sessions"])).stdout).toContain("waiting on: alex");
  });
});

describe("InboxTests", () => {
  beforeEach(() => { t = new ScTest(); });
  afterEach(() => t.cleanup());

  it("send writes inbox and wakes running session", async () => {
    const sid = await t.spawn();
    const out = await t.sc(["send", sid, "please also update the docs"]);
    expect(out.stdout).toContain("session was woken");
    expect((await t.asSession(sid, ["inbox"])).stdout).toContain("please also update the docs");
    expect((t.fakeState().wakes as string[][]).some((w) => w[0] === sid)).toBe(true);
  });

  it("send to stopped session is kept for later", async () => {
    const sid = await t.spawn();
    await t.sc(["stop", sid]);
    const out = await t.sc(["send", sid, "later"]);
    expect(out.stdout).toContain("not running");
    expect((await t.asSession(sid, ["inbox"])).stdout).toContain("later");
  });

  it("ack moves message and sequence numbers are not reused", async () => {
    const sid = await t.spawn();
    await t.sc(["send", sid, "one"]);
    await t.asSession(sid, ["inbox", "ack", "1"]);
    expect((await t.asSession(sid, ["inbox"])).stdout).toContain("Inbox is empty.");
    await t.sc(["send", sid, "two"]);
    expect((await t.asSession(sid, ["inbox"])).stdout).toContain("message 2");
  });
});

describe("AckResolutionTests", () => {
  beforeEach(() => { t = new ScTest(); });
  afterEach(() => t.cleanup());

  it("ack accepts an id prefix and really marks it read", async () => {
    const sid = await t.spawn("general", "prefix task");
    await t.asSession(sid, ["report", "done", "finished"]);
    await t.sc(["events", "ack", `${sid.slice(0, 12)}:2`]);
    expect((await t.sc(["events"])).stdout).toContain("No unread events.");
    expect(readJson(path.join(t.home, "state", "cursors.json"))).toEqual({ [sid]: 2 });
  });

  it("ack refuses an id that matches nothing", async () => {
    await t.spawn();
    const out = await t.sc(["events", "ack", "no-such-session:3"], { ok: false });
    expect(out.stderr).toContain("no session matches");
    expect(fs.existsSync(path.join(t.home, "state", "cursors.json"))).toBe(false);
  });
});

describe("ReportFeedbackTests", () => {
  beforeEach(() => { t = new ScTest(); });
  afterEach(() => t.cleanup());

  it("resolved refuses a key that is not open", async () => {
    const sid = await t.spawn();
    const out = await t.asSession(sid, ["report", "resolved", "--key", "nope"], { ok: false });
    expect(out.stderr).toContain("no open question with key 'nope'");
    expect(t.events(sid).length).toBe(1);
  });

  it("report says when sous chef could not be woken", async () => {
    await t.registerChef();
    const sid = await t.spawn();
    const data = t.fakeState();
    data.chef_alive = false;
    fs.writeFileSync(path.join(t.home, "state", "fake-runtime.json"), JSON.stringify(data));
    const out = await t.asSession(sid, ["report", "done", "finished"]);
    expect(out.stdout).toContain("could not be woken");
    expect(t.events(sid).at(-1).state).toBe("done");
  });

  it("send says why a session was not woken", async () => {
    const sid = await t.spawn();
    t.setFake(sid, { alive: false });
    const out = await t.sc(["send", sid, "hello"]);
    expect(out.stdout).toContain("was not woken");
    expect(out.stdout).toContain("is not running");
  });
});

describe("ResolvedWakesSousChefTests", () => {
  beforeEach(() => { t = new ScTest(); });
  afterEach(() => t.cleanup());

  it("a session closing its own question wakes sous chef", async () => {
    await t.registerChef();
    const sid = await t.spawn();
    await t.asSession(sid, ["report", "blocked", "need a token", "--key", "tok"]);
    await t.asSession(sid, ["report", "resolved", "Alex answered here", "--key", "tok"]);
    const wakes = (t.fakeState().wakes as string[][]).filter((w) => w[0] === "chef").map((w) => w[1]!);
    expect(wakes.some((w) => w.includes("reported resolved")), JSON.stringify(wakes)).toBe(true);
    expect((await t.sc(["events"])).stdout).toContain("resolved");
  });
});
