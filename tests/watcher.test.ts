// The watcher, one cycle at a time (`sc watch --once`) on the fake clock: silent stops, gone
// sessions and automatic resumes, inbox re-rings, re-waking sous chef, and sessions held at a prompt.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScTest } from "./helpers.js";

let t: ScTest;

describe("WatcherTests", () => {
  beforeEach(() => { t = new ScTest(); });
  afterEach(() => t.cleanup());

  async function watch(env: Record<string, string> = {}): Promise<string> {
    return (await t.sc(["watch", "--once"], { env: { SC_SILENT_GRACE: "600", SC_INBOX_GRACE: "120",
      SC_WAKE_RETRY: "120", ...env } })).stdout;
  }

  function chefWakes(): any[] { // eslint-disable-line @typescript-eslint/no-explicit-any
    return t.fakeState().wakes.filter((w: string[]) => w[0] === "chef");
  }

  it("silent stop flagged once after grace", async () => {
    await t.registerChef();
    const sid = await t.spawn();
    await t.hook("worker-prompt", sid);
    await t.hook("worker-stop", sid);
    t.clock += 300;
    expect(await watch()).not.toContain("silent-stop");
    t.clock += 400;
    expect(await watch()).toContain("silent-stop");
    expect(t.events(sid).at(-1).state).toEqual("silent-stop");
    expect(chefWakes().length).toEqual(1);
    t.clock += 1000;
    expect(await watch()).not.toContain("silent-stop");
  });

  it("no silent stop when session reported why", async () => {
    const sid = await t.spawn();
    await t.hook("worker-prompt", sid);
    await t.asSession(sid, ["report", "needs-decision", "which?"]);
    await t.hook("worker-stop", sid);
    t.clock += 1000;
    expect(await watch()).not.toContain("silent-stop");
  });

  it("no silent stop for session waiting on alex", async () => {
    const sid = await t.spawn(t.ownerKind());
    await t.hook("worker-prompt", sid);
    await t.hook("worker-stop", sid);
    t.clock += 1000;
    expect(await watch()).not.toContain("silent-stop");
  });

  it("unknown busy state is never treated as idle", async () => {
    // No turn has ended, so sc's own record cannot say idle either.
    await t.registerChef();
    const sid = await t.spawn();
    await t.hook("worker-prompt", sid);
    t.setFake(sid, { busy: null });
    await t.sc(["send", sid, "please ack"]);
    t.clock += 1000;
    const out = await watch();
    expect(out).not.toContain("re-rang");
    expect(out).not.toContain("silent-stop");
    t.setFake(sid, { busy: false });
    t.clock += 200;
    expect(await watch()).toContain("re-rang");
  });

  it("a turn that ended long ago counts as idle whatever the runtime says", async () => {
    // Seen live: `claude agents` said busy 15 minutes after the session's last Stop hook.
    await t.registerChef();
    const sid = await t.spawn();
    await t.hook("worker-prompt", sid);
    await t.hook("worker-stop", sid);
    t.setFake(sid, { busy: true });
    await t.sc(["send", sid, "please ack"]);
    t.clock += 200;
    expect(await watch()).not.toContain("re-rang"); // the turn ended only 200s ago: trust busy for now
    t.clock += 200;
    expect(await watch()).toContain("re-rang");
    t.clock += 500;
    expect(await watch()).toContain("silent-stop");
    expect(t.events(sid).at(-1).state).toEqual("silent-stop");
  });

  it("a prompt after the last stop keeps a busy session busy", async () => {
    const sid = await t.spawn();
    await t.hook("worker-stop", sid);
    t.clock += 10;
    await t.hook("worker-prompt", sid);
    t.setFake(sid, { busy: true });
    await t.sc(["send", sid, "please ack"]);
    t.clock += 2000;
    const out = await watch();
    expect(out).not.toContain("re-rang");
    expect(out).not.toContain("silent-stop");
  });

  const SUBAGENTS = { detail: "TRV-1116 building, awaiting builder report", in_flight: 4,
    running: [{ kind: "subagent", label: "Build TRV-1116 web types", since: 1_800_000_000.0 },
      { kind: "subagent", label: "rr2 finder: bugs", since: 1_800_000_000.0 },
      { kind: "subagent", label: "rr2 finder: hostile", since: 1_800_000_000.0 },
      { kind: "shell", label: "npm run typecheck", since: 1_800_000_000.0 }] };

  async function stoppedWaitingOnSubagents(): Promise<string> {
    await t.registerChef();
    const sid = await t.spawn();
    await t.hook("worker-prompt", sid);
    await t.hook("worker-stop", sid);
    t.setFake(sid, { activity: SUBAGENTS });
    return sid;
  }

  it("no silent stop while subagents are in flight", async () => {
    const sid = await stoppedWaitingOnSubagents();
    for (let i = 0; i < 4; i++) {
      t.clock += 1000;
      expect(await watch()).not.toContain("silent-stop");
    }
    expect(t.events(sid).map((e) => e.state)).not.toContain("silent-stop");
  });

  it("silent stop reported once the subagents finish and the grace passes", async () => {
    const sid = await stoppedWaitingOnSubagents();
    t.clock += 2000;
    expect(await watch()).not.toContain("silent-stop");
    t.setFake(sid, { activity: { ...SUBAGENTS, in_flight: 0, running: [] } });
    // The grace counts from the last poll that saw work in flight, so a session about to be
    // woken by its subagent's result is not reported in the seconds before it wakes.
    t.clock += 300;
    expect(await watch()).not.toContain("silent-stop");
    t.clock += 301;
    expect(await watch()).toContain("silent-stop");
    expect(t.events(sid).at(-1).state).toEqual("silent-stop");
    expect(t.events(sid).at(-1).text).not.toContain("still has");
    t.clock += 1000;
    expect(await watch()).not.toContain("silent-stop");
  });

  it("work in flight holds a silent stop back only up to the limit", async () => {
    const sid = await stoppedWaitingOnSubagents();
    t.clock += 3000;
    expect(await watch({ SC_INFLIGHT_MAX: "3600" })).not.toContain("silent-stop");
    t.clock += 700;
    expect(await watch({ SC_INFLIGHT_MAX: "3600" })).toContain("silent-stop");
    expect(t.events(sid).at(-1).text).toContain("still has 4 subagent(s)");
  });

  it("activity the runtime cannot read leaves silent stop as before", async () => {
    // A job file that is missing, malformed or reshaped reaches the watcher as no activity,
    // or as an in-flight count of None; either way the stop is reported after the grace.
    for (const activity of [null, { detail: "something", in_flight: null, running: [] }, "junk", { in_flight: "4" }]) {
      const sid = await t.spawn();
      await t.hook("worker-prompt", sid);
      await t.hook("worker-stop", sid);
      t.setFake(sid, { activity });
      t.clock += 700;
      expect(await watch(), JSON.stringify(activity)).toContain("silent-stop");
      expect(t.events(sid).at(-1).state).toEqual("silent-stop");
    }
  });

  it("a new turn after work in flight is judged on its own stop", async () => {
    const sid = await stoppedWaitingOnSubagents();
    t.clock += 1000;
    await watch();
    t.setFake(sid, { activity: null });
    await t.hook("worker-prompt", sid); // woken by the subagent's result
    t.clock += 60;
    await t.hook("worker-stop", sid);
    t.clock += 599;
    expect(await watch()).not.toContain("silent-stop");
    t.clock += 2;
    expect(await watch()).toContain("silent-stop");
  });

  it("no silent stop while a new turn is running", async () => {
    const sid = await t.spawn();
    await t.hook("worker-stop", sid);
    t.clock += 10;
    await t.hook("worker-prompt", sid);
    t.clock += 1000;
    expect(await watch()).not.toContain("silent-stop");
  });

  it("gone session flagged once but not when stopped by sous chef", async () => {
    await t.registerChef();
    const a = await t.spawn("general", "a");
    const b = await t.spawn("general", "b");
    t.setFake(a, { alive: false });
    await t.sc(["stop", b]);
    expect(await watch({ SC_GONE_GRACE: "60" })).not.toContain("gone"); // one missed poll only starts the clock
    t.clock += 30;
    expect(await watch({ SC_GONE_GRACE: "60" })).not.toContain("gone");
    t.clock += 30;
    const out = await watch({ SC_GONE_GRACE: "60" });
    expect(out).toContain(`${a}: gone`);
    expect(out).not.toContain(`${b}: gone`);
    expect(t.events(a).at(-1).text).toContain(`sc status ${a}`);
    t.clock += 60;
    expect(await watch({ SC_GONE_GRACE: "60" })).not.toContain("gone");
  });

  it("a session that drops out briefly and comes back is never gone", async () => {
    // Seen live: a session restarting left the listing for a few seconds with a new pid.
    await t.registerChef();
    const sid = await t.spawn();
    t.setFake(sid, { alive: false });
    expect(await watch({ SC_GONE_GRACE: "60" })).not.toContain("gone");
    t.clock += 15;
    t.setFake(sid, { alive: true });
    expect(await watch({ SC_GONE_GRACE: "60" })).not.toContain("gone");
    t.clock += 15;
    t.setFake(sid, { alive: false }); // missing again: the clock starts over
    expect(await watch({ SC_GONE_GRACE: "60" })).not.toContain("gone");
    t.clock += 45;
    expect(await watch({ SC_GONE_GRACE: "60" })).not.toContain("gone");
    t.clock += 15;
    expect(await watch({ SC_GONE_GRACE: "60" })).toContain(`${sid}: gone`);
  });

  // The session drops out of the listing and stays out past the gone grace; returns the second poll's output.
  async function stopsForAMinute(sid: string, env: Record<string, string> = {}): Promise<string> {
    t.setFake(sid, { alive: false });
    await watch({ SC_GONE_GRACE: "60", ...env });
    t.clock += 60;
    return watch({ SC_GONE_GRACE: "60", ...env });
  }

  it("a session waiting on alex that stops is resumed not gone", async () => {
    // Seen live: shape sessions waiting on Alex stopped about an hour after their last turn.
    await t.registerChef();
    const sid = await t.spawn(t.ownerKind());
    await t.hook("worker-prompt", sid);
    await t.hook("worker-stop", sid);
    t.clock += 3600;
    const out = await stopsForAMinute(sid);
    expect(out).toContain(`${sid}: auto-resumed`);
    expect(out).not.toContain("gone");
    expect(t.fakeState().sessions[sid].alive).toBe(true);
    expect(t.events(sid).at(-1).state).toEqual("auto-resumed");
    expect(t.events(sid).at(-1).author).toEqual("watcher");
    expect(chefWakes()).toEqual([]); // a resume that worked needs nobody
    const inbox = (await t.asSession(sid, ["inbox"])).stdout;
    expect(inbox).toContain("restart");
    expect(inbox).toContain("local page server");
    expect(t.fakeState().wakes.some((w: string[]) => w[0] === sid && w[1]!.includes("inbox"))).toBe(true);
    // It is still waiting on Alex, so its old stopped turn is not called a silent stop,
    // which is what followed a plain `sc resume` (it records waiting on the agent).
    expect((await t.sc(["status", sid])).stdout).toContain("waiting on: alex");
    t.clock += 1000;
    expect(await watch()).not.toContain("silent-stop");
    expect((await t.sc(["events"])).stdout).toContain("auto-resumed");
  });

  it("a session with an open question or paused is resumed", async () => {
    await t.registerChef();
    const asking = await t.spawn("general", "asking");
    await t.asSession(asking, ["report", "needs-decision", "which database?"]);
    const paused = await t.spawn("general", "paused");
    await t.asSession(paused, ["report", "paused", "waiting for CI, about 20 minutes"]);
    t.setFake(paused, { alive: false });
    const out = await stopsForAMinute(asking);
    expect(out).toContain(`${asking}: auto-resumed`);
    expect(out).toContain(`${paused}: auto-resumed`);
    expect((await t.sc(["status", asking])).stdout).toContain("waiting on: sc");
    expect((await t.sc(["status", paused])).stdout).toContain("waiting on: external");
  });

  it("a working finished or stopped session is not resumed", async () => {
    await t.registerChef();
    const working = await t.spawn("general", "working"); // general starts waiting on the agent
    const finished = await t.spawn("general", "finished");
    await t.asSession(finished, ["report", "done", "all done"]);
    const stopped = await t.spawn(t.ownerKind(), "stopped");
    await t.sc(["stop", stopped]);
    t.setFake(finished, { alive: false });
    const out = await stopsForAMinute(working);
    expect(out).not.toContain("auto-resumed");
    expect(out).toContain(`${working}: gone`);
    expect(out).not.toContain(`${finished}: gone`);
    expect(out).not.toContain(`${stopped}: gone`);
    const state = t.fakeState().sessions;
    expect([working, finished, stopped].some((x) => state[x].alive)).toBe(false);
    expect(t.events(working).at(-1).text).not.toContain("The watcher");
  });

  it("a failed resume is reported as gone", async () => {
    await t.registerChef();
    const sid = await t.spawn(t.ownerKind());
    const out = await stopsForAMinute(sid, { SC_FAKE_RESUME_FAILS: "1" });
    expect(out).toContain(`${sid}: gone`);
    expect(t.events(sid).at(-1).text)
      .toContain("tried to resume it and failed: fake runtime was told to fail the resume");
    expect(chefWakes().length).toEqual(1);
    t.clock += 60;
    expect(await watch({ SC_GONE_GRACE: "60" })).not.toContain(`${sid}:`); // reported once, not retried every poll
  });

  it("a session that stops again soon after a resume is gone", async () => {
    await t.registerChef();
    const sid = await t.spawn(t.ownerKind());
    expect(await stopsForAMinute(sid)).toContain("auto-resumed");
    t.clock += 300; // up for 5 minutes, under SC_AUTO_RESUME_MIN_UP
    const out = await stopsForAMinute(sid);
    expect(out).toContain(`${sid}: gone`);
    expect(t.events(sid).at(-1).text).toContain("stopped again within 10 minutes");
  });

  it("automatic resumes are capped per 24 hours", async () => {
    await t.registerChef();
    const sid = await t.spawn(t.ownerKind());
    for (let i = 0; i < 2; i++) {
      t.clock += 3600;
      expect(await stopsForAMinute(sid, { SC_AUTO_RESUME_MAX: "2" })).toContain("auto-resumed");
    }
    t.clock += 3600;
    const out = await stopsForAMinute(sid, { SC_AUTO_RESUME_MAX: "2" });
    expect(out).toContain(`${sid}: gone`);
    expect(t.events(sid).at(-1).text).toContain("2 times in the last 24 hours");
    // Sous chef resumes it by hand; once the earlier resumes are more than 24 hours old,
    // the watcher resumes it again.
    await t.sc(["resume", sid]);
    await t.sc(["mark", sid, "alex", "back to waiting on Alex"]);
    await watch(); // seen running again
    t.clock += 86400;
    expect(await stopsForAMinute(sid, { SC_AUTO_RESUME_MAX: "2" })).toContain("auto-resumed");
  });

  it("automatic resume can be turned off", async () => {
    await t.registerChef();
    const sid = await t.spawn(t.ownerKind());
    const out = await stopsForAMinute(sid, { SC_AUTO_RESUME_MAX: "0" });
    expect(out).toContain(`${sid}: gone`);
    expect(out).not.toContain("auto-resumed");
  });

  it("inbox rerings then escalates", async () => {
    await t.registerChef();
    const sid = await t.spawn();
    await t.sc(["send", sid, "please ack"]);
    for (let i = 0; i < 3; i++) {
      t.clock += 130;
      expect(await watch()).toContain("re-rang message 1");
    }
    t.clock += 130;
    expect(await watch()).toContain("inbox-unread 1");
    t.clock += 130;
    expect(await watch()).not.toContain("inbox-unread");
  });

  it("acked inbox message is left alone", async () => {
    const sid = await t.spawn();
    await t.sc(["send", sid, "please ack"]);
    await t.asSession(sid, ["inbox", "ack", "1"]);
    t.clock += 1000;
    expect((await watch()).trim()).toEqual("");
  });

  it("unread events rewake chef with backoff until acked", async () => {
    await t.registerChef();
    const sid = await t.spawn();
    await t.asSession(sid, ["report", "done", "finished"]);
    expect(chefWakes().length).toEqual(1);
    t.clock += 60;
    expect(await watch()).not.toContain("re-woke");
    t.clock += 70;
    expect(await watch()).toContain("re-woke");
    t.clock += 130;
    expect(await watch()).not.toContain("re-woke");
    t.clock += 130;
    expect(await watch()).toContain("re-woke");
    const out = (await t.sc(["events"])).stdout;
    await t.sc(["events", "ack", out.trim().split(/\r?\n/).at(-1)!.split("ack ")[1]!]);
    t.clock += 5000;
    expect(await watch()).not.toContain("re-woke");
  });
});

describe("PromptWatcherTests", () => {
  beforeEach(() => { t = new ScTest(); });
  afterEach(() => t.cleanup());

  const PROMPT = "permission prompt (approve Bash: ./scripts/db-reset.sh)";

  async function watch(env: Record<string, string> = {}): Promise<string> {
    return (await t.sc(["watch", "--once"], { env: { SC_SILENT_GRACE: "600", SC_INBOX_GRACE: "120",
      SC_WAKE_RETRY: "120", SC_PROMPT_GRACE: "180", ...env } })).stdout;
  }

  function chefWakes(): any[] { // eslint-disable-line @typescript-eslint/no-explicit-any
    return t.fakeState().wakes.filter((w: string[]) => w[0] === "chef");
  }

  function promptEvents(sid: string): any[] { // eslint-disable-line @typescript-eslint/no-explicit-any
    return t.events(sid).filter((e) => e.state.startsWith("prompt-"));
  }

  it("a held session is reported once after the grace period", async () => {
    await t.registerChef();
    const sid = await t.spawn();
    await t.hook("worker-prompt", sid);
    t.setFake(sid, { prompt: PROMPT });
    expect(await watch()).not.toContain("prompt-waiting"); // the first poll only starts the clock
    t.clock += 170;
    expect(await watch()).not.toContain("prompt-waiting");
    t.clock += 15;
    expect(await watch()).toContain(`${sid}: prompt-waiting`);
    const event = t.events(sid).at(-1);
    expect([event.state, event.author]).toEqual(["prompt-waiting", "watcher"]);
    expect(event.text).toContain("approve Bash: ./scripts/db-reset.sh");
    expect(event.text).toContain(`fake attach ${sid}`);
    expect(chefWakes().at(-1)[1])
      .toEqual(`sous chef watcher: sessions need attention (${sid}). Run \`sc events\`.`);
    expect((await t.sc(["status", sid])).stdout).toContain("waiting on: alex");
    expect((await t.sc(["sessions"])).stdout).toContain("held at a prompt");
    expect((await t.sc(["status", sid])).stdout).toContain(`HELD AT A PROMPT: ${PROMPT}`);
    for (let i = 0; i < 4; i++) { // still held: no second event on later polls
      t.clock += 200;
      expect(await watch()).not.toContain("prompt-waiting");
    }
    expect(promptEvents(sid).map((e) => e.state)).toEqual(["prompt-waiting"]);
  });

  it("a prompt answered within the grace period is never reported", async () => {
    await t.registerChef();
    const sid = await t.spawn();
    t.setFake(sid, { prompt: PROMPT });
    await watch();
    t.clock += 100;
    await watch();
    t.setFake(sid, { prompt: null, busy: true });
    t.clock += 100;
    expect(await watch()).not.toContain("prompt");
    t.clock += 1000;
    expect(await watch()).not.toContain("prompt");
    expect(promptEvents(sid)).toEqual([]);
    expect(chefWakes()).toEqual([]);
  });

  it("a reported prompt that is answered gives back who the session waits on", async () => {
    await t.registerChef();
    const sid = await t.spawn();
    await t.hook("worker-prompt", sid);
    t.setFake(sid, { prompt: PROMPT });
    await watch();
    t.clock += 200;
    await watch();
    const wakes = chefWakes().length;
    t.setFake(sid, { prompt: null, busy: true });
    t.clock += 15;
    await watch();
    expect(promptEvents(sid).map((e) => e.state)).toEqual(["prompt-waiting", "prompt-answered"]);
    expect((await t.sc(["status", sid])).stdout).toContain("waiting on: agent");
    expect(chefWakes().length).toEqual(wakes); // an answered prompt needs nothing, so no wake-up
    // With "waiting on" back to the agent, a later silent stop is still noticed.
    await t.hook("worker-stop", sid);
    t.setFake(sid, { busy: false });
    t.clock += 700;
    expect(await watch()).toContain("silent-stop");
  });

  it("a report made after the prompt is not overwritten when it closes", async () => {
    const sid = await t.spawn();
    t.setFake(sid, { prompt: PROMPT });
    await watch();
    t.clock += 200;
    await watch();
    await t.sc(["mark", sid, "external", "Alex is on it"]);
    t.setFake(sid, { prompt: null });
    t.clock += 15;
    await watch();
    expect(t.events(sid).at(-1).state).toEqual("prompt-answered");
    expect((await t.sc(["status", sid])).stdout).toContain("waiting on: external");
  });

  it("a different prompt is a new occurrence", async () => {
    const sid = await t.spawn();
    t.setFake(sid, { prompt: PROMPT });
    await watch();
    t.clock += 200;
    expect(await watch()).toContain("prompt-waiting");
    t.setFake(sid, { prompt: "permission prompt (approve Bash: git push)" });
    t.clock += 15;
    expect(await watch()).not.toContain("prompt-waiting"); // a new prompt: its own clock starts
    t.clock += 200;
    expect(await watch()).toContain("prompt-waiting");
    expect(promptEvents(sid).map((e) => e.state))
      .toEqual(["prompt-waiting", "prompt-answered", "prompt-waiting"]);
    expect(t.events(sid).at(-1).text).toContain("git push");
  });

  it("a held session is busy so it is not re rung or called silent", async () => {
    await t.registerChef();
    const sid = await t.spawn();
    await t.hook("worker-prompt", sid);
    await t.sc(["send", sid, "please ack"]);
    t.setFake(sid, { prompt: PROMPT, busy: false });
    t.clock += 2000;
    const out = await watch();
    expect(out).not.toContain("re-rang");
    expect(out).not.toContain("silent-stop");
    expect(out).not.toContain("inbox-unread");
  });

  it("a session that dies at a prompt is gone not answered", async () => {
    const sid = await t.spawn();
    t.setFake(sid, { prompt: PROMPT });
    await watch();
    t.clock += 200;
    await watch();
    t.setFake(sid, { alive: false });
    t.clock += 15;
    await watch({ SC_GONE_GRACE: "60", SC_AUTO_RESUME_MAX: "0" });
    t.clock += 60;
    expect(await watch({ SC_GONE_GRACE: "60", SC_AUTO_RESUME_MAX: "0" })).toContain(`${sid}: gone`);
    expect(promptEvents(sid).map((e) => e.state)).toEqual(["prompt-waiting"]);
  });

  it("a session that stops at a prompt is resumed and still waits on alex", async () => {
    const sid = await t.spawn();
    t.setFake(sid, { prompt: PROMPT });
    await watch();
    t.clock += 200;
    await watch(); // prompt-waiting: waiting on Alex
    t.setFake(sid, { alive: false });
    t.clock += 15;
    await watch({ SC_GONE_GRACE: "60" });
    t.clock += 60;
    expect(await watch({ SC_GONE_GRACE: "60" })).toContain(`${sid}: auto-resumed`);
    expect((await t.sc(["status", sid])).stdout).toContain("waiting on: alex");
  });
});
