// The watcher resuming sous chef's own session after Claude Code stops it for being idle
// (docs/domains/watcher.md, "Resuming sous chef itself"), against the fake runtime and a fake
// Slack relay. Sous chef's row in the fake runtime is "chef-1"; "end_reason" says why it stopped.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALEX, FakeRelay, KEY } from "./fake-relay.js";
import { type Env, readJson, ScTest, SOUSCHEF } from "./helpers.js";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("ChefResumeTests", () => {
  let t: ScTest;
  let relay: FakeRelay;

  beforeEach(async () => {
    t = new ScTest();
    t.baseEnv.TZ = "UTC";
    relay = await new FakeRelay().start();
    await t.registerChef();
    chef({ alive: false, end_reason: "idle" }); // Claude Code stopped it for being idle
  });
  afterEach(async () => {
    await t.cleanup();
    await relay.stop();
  });

  function chef(fields: Record<string, unknown>): void {
    const file = path.join(t.home, "state", "fake-runtime.json");
    const data = fs.existsSync(file) ? readJson(file) : { sessions: {}, wakes: [] };
    data.sessions["chef-1"] = { kind: "background", id: "chef-1", ...(data.sessions["chef-1"] ?? {}), ...fields };
    if (fields.alive === false) delete data.sessions["chef-1"].pid;
    fs.writeFileSync(file, JSON.stringify(data));
  }

  const resumes = (): string[] => t.fakeState().chef_resumes ?? [];
  const chefWakes = (): string[] => (t.fakeState().wakes as [string, string][]).filter((w) => w[0] === "chef").map((w) => w[1]);

  async function slackSetup(): Promise<void> {
    const key = path.join(t.tmp, "relay-key.txt");
    fs.writeFileSync(key, `Created key for T1/${ALEX}.\n${KEY}\n`);
    await t.sc(["slack", "setup", "--url", relay.url, "--key-file", key, "--user", ALEX]);
    relay.posts = [];
  }

  async function watch(env: Env = {}): Promise<string> {
    return (await t.sc(["watch", "--once"], { env: { SC_WAKE_RETRY: "120", ...env } })).stdout;
  }

  /** Work for sous chef: a session reports a question, whose own wake-up cannot reach a stopped sous chef. */
  async function question(): Promise<string> {
    const sid = await t.spawn();
    await t.asSession(sid, ["report", "needs-decision", "A or B?"]);
    t.clock += 200; // past SC_WAKE_RETRY, so the watcher wakes sous chef again
    return sid;
  }

  it("resumes sous chef for a new Slack message, then delivers the wake-up saying why", async () => {
    await slackSetup();
    relay.envelope("are you there?");
    const out = await watch();
    expect(out).toContain("sous chef: resumed (chef-1) after Claude Code stopped it for being idle (1 of at most 24 in 24 hours), for: 1 new Slack message(s)");
    expect(resumes()).toEqual(["chef-1"]);
    expect(chefWakes()).toEqual(["sous chef watcher: you were resumed after Claude Code stopped you for being idle, " +
      "because there is work for you; 1 new Slack message(s). Run `sc events`."]);
    expect(out).toContain("woke sous chef: True");
    expect(relay.posts).toEqual([]); // a resume that works is not news for the owner
    expect((await t.sc(["chef"])).stdout).toMatch(/\n {2}last: resumed after an idle stop \(1 of at most 24 in 24 hours\), for: 1 new Slack message\(s\) \(\d+s ago\)\n$/);
  });

  it("resumes sous chef for a session's event it has not read", async () => {
    await question();
    const out = await watch();
    expect(out).toContain("sous chef: resumed (chef-1)");
    expect(out).toContain("for: sessions need attention");
    expect(chefWakes()).toHaveLength(1);
  });

  it("resumes sous chef for a scheduled job that is due, which then fires in the same cycle", async () => {
    chef({ alive: true, busy: false, pid: 1 });
    await t.sc(["cron", "add", "email-check", "--every", "1h", "--target", "chef"], { stdin: "read the email" });
    await watch(); // first seen: waits for its next slot
    chef({ alive: false, end_reason: "idle" });
    t.clock += 3600 + 30;
    const out = await watch();
    expect(out).toContain("for: scheduled job(s) due: email-check");
    expect(out).toContain("cron email-check: wrote due as cron event #1 for sous chef");
    expect(out).not.toContain("sous chef is not running");
    expect(resumes()).toEqual(["chef-1"]);
  });

  it("does nothing while there is no work, however long sous chef has been stopped", async () => {
    t.clock += 86400;
    expect(await watch()).toBe("");
    expect(resumes()).toEqual([]);
  });

  // A deliberate stop (`claude stop`, /exit, Ctrl+C) or a kill is never undone by the watcher.
  for (const [what, fields] of [["claude stop", { end_reason: "other" }], ["/exit", { end_reason: "prompt_input_exit" }],
    ["a kill (no reason)", {}]] as [string, Record<string, unknown>][]) {
    it(`leaves sous chef stopped after ${what}, as before`, async () => {
      chef({ alive: false, end_reason: null, ...fields });
      await question();
      const out = await watch();
      expect(out).not.toContain("resumed");
      expect(out).toContain("woke sous chef: False");
      expect(resumes()).toEqual([]);
    });
  }

  it("never resumes it while switched off; sc chef on, or souschef, switches it back on", async () => {
    let out = (await t.sc(["chef", "off"])).stdout;
    expect(out).toContain("switched off\nthe watcher resumes sous chef after Claude Code stops it for being idle: OFF (sc chef off, 0s ago)");
    expect((await t.sc(["chef", "off"])).stdout).toContain("already off; nothing changed");
    expect((await t.sc(["summary"])).stdout).toContain("being idle: OFF (sc chef off");
    await question();
    out = await watch();
    expect(out).toContain("sous chef: stopped for being idle and there is work, but not resumed: it is switched off");
    t.clock += 200;
    expect(await watch()).not.toContain("not resumed"); // said once, not every cycle
    expect(resumes()).toEqual([]);

    expect((await t.sc(["chef", "on"])).stdout).toContain("switched on\nthe watcher resumes sous chef after Claude Code stops it for being idle, when there is work: on (sc chef on");
    t.clock += 600;
    expect(await watch()).toContain("sous chef: resumed (chef-1)");

    await t.sc(["chef", "off"]);
    out = (await t.runSc(SOUSCHEF, ["--print"])).stdout;
    expect(out).toContain("the watcher resumes sous chef after an idle stop again (it was off");
    expect(readJson(path.join(t.home, "state", "chef-resume.json"))).toMatchObject({ on: true, by: "souschef" });
    expect((await t.runSc(SOUSCHEF, ["--print"])).stdout).not.toContain("it was off");
  });

  // Porch forgets an ended session a day after it ended; the watcher remembers the idle stop it saw.
  it("still resumes it once the runtime has forgotten an idle stop the watcher saw", async () => {
    await watch(); // no work: nothing done, but the idle stop is seen
    chef({ forgotten: true, end_reason: null });
    t.clock += 2 * 86400;
    await question();
    expect(await watch()).toContain("sous chef: resumed (chef-1)");
  });

  it("does not resume a session the runtime has forgotten when it never saw it stopped for being idle", async () => {
    chef({ forgotten: true, end_reason: null });
    await question();
    expect(await watch()).not.toContain("resumed");
    expect(resumes()).toEqual([]);
  });

  it("forgets the idle stop once it sees sous chef running again", async () => {
    await watch();
    chef({ alive: true, busy: false, pid: 1, end_reason: null });
    await watch();
    chef({ alive: false, forgotten: true }); // stopped again, and why is not known
    await question();
    expect(await watch()).not.toContain("resumed");
    expect(resumes()).toEqual([]);
  });

  it("refuses sc chef --take with on or off", async () => {
    const out = await t.sc(["chef", "off", "--take"], { ok: false });
    expect(out.stderr).toContain("--take cannot be combined with on or off");
  });

  it("does not resume again within SC_CHEF_RESUME_GAP of the last try", async () => {
    await question();
    expect(await watch()).toContain("sous chef: resumed");
    chef({ alive: false, end_reason: "idle" }); // stopped again at once: not an hour's idle stop
    t.clock += 300;
    const out = await watch();
    expect(out).toContain("not resumed: it last tried 5m ago; it tries again 10 minutes after that (SC_CHEF_RESUME_GAP)");
    expect(resumes()).toHaveLength(1);
    t.clock += 1000; // past the gap, and when the next re-wake for the unread question is due
    expect(await watch()).toContain("sous chef: resumed (chef-1) after Claude Code stopped it for being idle (2 of at most 24");
  });

  it("stops at SC_CHEF_RESUME_MAX in 24 hours and tells the owner in Slack once", async () => {
    await slackSetup();
    const env = { SC_CHEF_RESUME_MAX: "2" };
    await question();
    for (let i = 0; i < 2; i++) {
      expect(await watch(env)).toContain("sous chef: resumed");
      chef({ alive: false, end_reason: "idle" });
      t.clock += 3600;
    }
    let out = await watch(env);
    expect(out).toContain("not resumed: it has already tried 2 times in the last 24 hours, the most it may (SC_CHEF_RESUME_MAX)");
    expect(out).toContain("sous chef: told Alex in Slack (max)");
    expect(relay.posts.map((p: Json) => p.text)).toEqual(["Claude Code stopped sous chef for being idle, and the watcher has " +
      "not resumed it: it already tried 2 times in the last 24 hours, the most it may. There is work waiting " +
      "(sessions need attention (general-test-task-" + relay.posts[0].text.split("general-test-task-")[1]!.split(")")[0] +
      ")). Open sous chef with `souschef` to look."]);
    t.clock += 3600;
    out = await watch(env);
    expect(out).not.toContain("told Alex");
    expect(relay.posts).toHaveLength(1);
    expect(resumes()).toHaveLength(2);
    // A day after the first resume, it may resume again.
    t.clock += 86400;
    expect(await watch(env)).toContain("sous chef: resumed");
  });

  it("tells the owner in Slack when a resume fails, once until one works, and tries again after the gap", async () => {
    await slackSetup();
    await question();
    const failing = { SC_FAKE_RESUME_FAILS: "1" };
    let out = await watch(failing);
    expect(out).toContain("sous chef: resume after an idle stop failed (1 of at most 24 in 24 hours): the session did not come back");
    expect(out).toContain("woke sous chef: False");
    expect(relay.posts.map((p: Json) => p.text)[0]).toMatch(/^Claude Code stopped sous chef for being idle, and the watcher could not resume it: the session did not come back\. It tries again in 10 minutes while there is work/);
    t.clock += 601;
    out = await watch(failing);
    expect(out).toContain("failed (2 of at most 24");
    expect(relay.posts).toHaveLength(1);
    t.clock += 601;
    expect(await watch()).toContain("sous chef: resumed (chef-1)");
    expect((await t.sc(["chef"])).stdout).toContain("last: resumed after an idle stop (3 of at most 24");
  });

  it("does nothing with SC_CHEF_RESUME_MAX=0", async () => {
    await question();
    expect(await watch({ SC_CHEF_RESUME_MAX: "0" })).toContain("not resumed: SC_CHEF_RESUME_MAX is 0");
    expect(resumes()).toEqual([]);
  });

  it("shows the switch in sc chef, the summary and sc watch --ensure", async () => {
    const line = "the watcher resumes sous chef after Claude Code stops it for being idle, when there is work: on; `sc chef off` turns it off";
    expect((await t.sc(["chef"])).stdout).toContain(line);
    expect((await t.sc(["summary"])).stdout).toContain(`## Watcher\nNOT RUNNING: run \`sc watch --ensure\`\n${line}\n`);
    expect((await t.sc(["watch", "--ensure"], { env: { SC_WATCH_DISABLE_ENSURE: "1" } })).stdout).toBe(`watcher running\n${line}\n`);
  });
});
