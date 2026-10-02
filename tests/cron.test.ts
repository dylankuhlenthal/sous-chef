// Scheduled jobs (`sc cron`): definitions, jobs for sous chef and for a worker, and what
// `sc cron run` says about waking sous chef with a real watcher running.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { check, type Env, readJson, RunningWatcherTest, ScTest } from "./helpers.js";

// Scheduled jobs. The clock starts at 08:00 UTC; TZ is UTC so times of day are predictable.
describe("CronTests", () => {
  const HOUR = 3600;
  let t: ScTest;

  beforeEach(async () => {
    t = new ScTest();
    t.baseEnv.TZ = "UTC";
    await t.registerChef();
    chef({ alive: true, busy: false });
  });
  afterEach(() => t.cleanup());

  // Set sous chef's own row in the fake runtime: running or not, idle or mid-turn.
  function chef(fields: Record<string, unknown>): void {
    const file = path.join(t.home, "state", "fake-runtime.json");
    const data = fs.existsSync(file) ? readJson(file) : { sessions: {}, wakes: [] };
    data.sessions["chef-1"] ??= {};
    Object.assign(data.sessions["chef-1"], fields);
    fs.writeFileSync(file, JSON.stringify(data));
  }

  function add(name: string, args: string[], o: { task?: string; ok?: boolean } = {}) {
    return t.sc(["cron", "add", name, ...args], { stdin: o.task ?? "check the inbox", ok: o.ok ?? true });
  }

  function addWorker(name: string, args: string[]) {
    return add(name, ["--target", "worker", "--kind", "general", "--cwd", t.work, "--runtime", "fake", ...args]);
  }

  async function watch(env: Env = {}): Promise<string> {
    return (await t.sc(["watch", "--once"], { env: { SC_SILENT_GRACE: "600", SC_INBOX_GRACE: "120",
      SC_WAKE_RETRY: "120", ...env } })).stdout;
  }

  function chefWakes(): string[] {
    return (t.fakeState().wakes as [string, string][]).filter((w) => w[0] === "chef").map((w) => w[1]);
  }

  function sessionWakes(sid: string): string[] {
    return (t.fakeState().wakes as [string, string][]).filter((w) => w[0] === sid).map((w) => w[1]);
  }

  function cronEvents(): any[] { // eslint-disable-line @typescript-eslint/no-explicit-any
    const file = path.join(t.home, "state", "cron", "events.jsonl");
    return fs.existsSync(file) ? splitlines(fs.readFileSync(file, "utf8")).map((line) => JSON.parse(line)) : [];
  }

  async function workerIds(): Promise<string[]> {
    return splitlines((await t.sc(["sessions"])).stdout).filter((line) => line.startsWith("- "))
      .map((line) => line.split(/\s+/).filter(Boolean)[1]!);
  }

  function inbox(sid: string): any[] { // eslint-disable-line @typescript-eslint/no-explicit-any
    const d = path.join(t.home, "state", "sessions", sid, "inbox");
    if (!(fs.existsSync(d) && fs.statSync(d).isDirectory())) return [];
    return fs.readdirSync(d).filter((f) => f.endsWith(".json")).sort().map((f) => readJson(path.join(d, f)));
  }

  // --- definitions

  it("add writes a definition file and list shows it", async () => {
    await add("email-check", ["--at", "16:00,9:00", "--target", "chef"],
      { task: "read Alex's email and summarise what matters" });
    const text = fs.readFileSync(path.join(t.home, "cron", "email-check.md"), "utf8");
    expect(text).toContain("at: 16:00,9:00");
    expect(text).toContain("read Alex's email");
    expect(text).not.toContain("delivery");
    const out = (await t.sc(["cron", "list"])).stdout;
    expect(out).toContain("email-check: at 09:00, 16:00 | sous chef");
    expect(out).toContain("last fired: never");
    expect((await t.sc(["summary"])).stdout).toContain("email-check: at 09:00, 16:00, done by you");
  });

  it("add refuses bad definitions and writes nothing", async () => {
    const chefT = ["--target", "chef"];
    const worker = ["--target", "worker"];
    const cases: [string[], string][] = [
      [["Email", "--at", "09:00", ...chefT], "kebab-case"],
      [["a", "--at", "9am", ...chefT], "not a time of day"],
      [["a", "--every", "0h", ...chefT], "not an interval"],
      [["a", ...chefT], "exactly one schedule"],
      [["a", "--at", "09:00"], "target must be chef or worker"],
      [["a", "--at", "09:00", "--delivery", "queue", ...chefT], "unrecognized arguments"],
      [["a", "--at", "09:00", ...chefT, "--cwd", t.work], "only apply to a worker job"],
      [["a", "--at", "09:00", ...worker], "needs a kind and a cwd"],
      [["a", "--at", "09:00", ...worker, "--kind", "general", "--cwd", t.home],
        "inside the sous chef data folder"],
      [["a", "--at", "09:00", ...worker, "--kind", "nope", "--cwd", t.work], "unknown kind"],
    ];
    for (const [args, message] of cases) {
      expect((await add(args[0]!, args.slice(1), { ok: false })).stderr, args.join(" ")).toContain(message);
    }
    expect((await add("a", ["--at", "09:00", ...chefT], { task: "", ok: false })).stderr).toContain("task text is empty");
    const cronDir = path.join(t.home, "cron");
    expect(fs.existsSync(cronDir) && fs.readdirSync(cronDir).length > 0).toBe(false);
    await add("a", ["--at", "09:00", ...chefT]);
    expect((await add("a", ["--at", "10:00", ...chefT], { ok: false })).stderr).toContain("already exists");
  });

  it("remove deletes the definition and its run record", async () => {
    await add("email-check", ["--every", "1h", "--target", "chef"]);
    await t.sc(["cron", "remove", "email-check"]);
    expect(fs.existsSync(path.join(t.home, "cron", "email-check.md"))).toBe(false);
    expect(Object.keys(readJson(path.join(t.home, "state", "cron", "runs.json")))).not.toContain("email-check");
    expect((await t.sc(["cron", "list"])).stdout).toContain("No cron jobs");
    expect((await t.sc(["cron", "remove", "email-check"], { ok: false })).stderr).toContain("no cron job");
  });

  it("a hand edited broken definition is shown and never fires", async () => {
    fs.mkdirSync(path.join(t.home, "cron"));
    fs.writeFileSync(path.join(t.home, "cron", "oops.md"), "---\nat: noon\ntarget: chef\n---\ndo it\n");
    expect((await t.sc(["cron", "list"])).stdout).toContain("oops: BROKEN, never fires until fixed");
    expect((await t.sc(["summary"])).stdout).toContain("oops: BROKEN");
    t.clock += 24 * HOUR;
    expect(await watch()).not.toContain("oops");
  });

  // --- jobs for sous chef: wake if idle, queue if mid-turn

  it("a chef job fires at its time and wakes an idle sous chef", async () => {
    await add("email-check", ["--at", "09:00", "--target", "chef"], { task: "read Alex's email" });
    expect(await watch()).not.toContain("email-check");
    t.clock += HOUR + 30;
    let out = await watch();
    expect(out).toContain("cron email-check: wrote due as cron event #1 for sous chef");
    expect(out).toContain("cron: woke sous chef for unread cron events");
    expect(chefWakes()).toEqual(["sous chef watcher: scheduled jobs are waiting for you. Run `sc events`."]);
    out = (await t.sc(["events"])).stdout;
    expect(out).toContain("[cron] scheduled jobs for sous chef itself");
    expect(out).toContain("due (cron");
    expect(out).toContain("cron job email-check: read Alex's email");
    expect(out).toContain("sc events ack cron:1");
    await t.sc(["events", "ack", "cron:1"]);
    expect((await t.sc(["events"])).stdout.trim()).toBe("No unread events.");
  });

  it("a chef job waits while sous chef is mid turn then wakes it once idle", async () => {
    await add("email-check", ["--every", "6h", "--target", "chef"]);
    chef({ busy: true });
    t.clock += 6 * HOUR;
    expect(await watch()).toContain("wrote due as cron event #1 for sous chef");
    for (let i = 0; i < 5; i++) { // the watcher must not wake it either, however long the turn lasts
      t.clock += 20 * 60;
      expect(await watch()).not.toContain("woke");
    }
    expect(chefWakes()).toEqual([]);
    expect((await t.sc(["summary"])).stdout).toContain("Unread events needing attention: 1");
    chef({ busy: false });
    t.clock += 15;
    expect(await watch()).toContain("cron: woke sous chef for unread cron events");
    expect(chefWakes().length).toBe(1);
  });

  it("an unknown busy state is never treated as idle", async () => {
    await add("email-check", ["--every", "1h", "--target", "chef"]);
    chef({ busy: null });
    t.clock += HOUR;
    await watch();
    t.clock += HOUR / 2;
    await watch();
    expect(chefWakes()).toEqual([]);
  });

  it("an unread cron event is woken again with backoff until acked", async () => {
    await add("email-check", ["--every", "6h", "--target", "chef"]);
    t.clock += 6 * HOUR;
    await watch();
    expect(chefWakes().length).toBe(1);
    t.clock += 60;
    expect(await watch()).not.toContain("woke");
    t.clock += 70;
    expect(await watch()).toContain("woke sous chef for unread cron events");
    expect(chefWakes().length).toBe(2);
    await t.sc(["events", "ack", "cron:1"]);
    t.clock += 5000;
    expect(await watch()).not.toContain("woke");
  });

  // Alex: a firing fires. Unread messages stack up; each stays visible.
  it("a chef job fires again while its previous event is unread", async () => {
    await add("email-check", ["--every", "1h", "--target", "chef"]);
    t.clock += HOUR;
    await watch();
    t.clock += HOUR;
    expect(await watch()).toContain("wrote due as cron event #2 for sous chef");
    expect(cronEvents().map((e) => e.state)).toEqual(["due", "due"]);
    const out = (await t.sc(["events"])).stdout;
    expect(out).toContain("#1 due");
    expect(out).toContain("#2 due");
    expect(out).toContain("sc events ack cron:2");
    expect((await t.sc(["cron", "list"])).stdout).not.toContain("skip");
  });

  // --- schedule

  it("missed firings fire once when sous chef is back", async () => {
    await add("email-check", ["--at", "09:00,16:00", "--target", "chef"]);
    chef({ alive: false });
    t.clock += 2 * 24 * HOUR;
    expect(await watch()).toContain("due, but sous chef is not running");
    t.clock += 60;
    expect((await watch()).trim()).toBe(""); // said once, not every cycle
    expect(cronEvents()).toEqual([]);
    chef({ alive: true });
    expect(await watch()).toContain("wrote due as cron event #1 for sous chef");
    t.clock += 60;
    expect(await watch()).not.toContain("email-check");
    expect(cronEvents().length).toBe(1);
  });

  it("a new job waits for its next time rather than firing for a past one", async () => {
    await add("early", ["--at", "07:00", "--target", "chef"]);
    t.clock += 60;
    expect(await watch()).not.toContain("early");
    t.clock += 23 * HOUR;
    expect(await watch()).toContain("cron early: wrote due as cron event #1");
  });

  // A file that arrives without `sc cron add` (git pull on another machine) has no run record here.
  it("a definition synced from elsewhere also waits for its next time", async () => {
    fs.mkdirSync(path.join(t.home, "cron"));
    fs.writeFileSync(path.join(t.home, "cron", "early.md"), "---\nat: 07:00\ntarget: chef\n---\ndo it\n");
    expect(await watch()).not.toContain("early");
    t.clock += 23 * HOUR;
    expect(await watch()).toContain("cron early: wrote due as cron event #1");
  });

  it("list says why an overdue job has not fired instead of a due time", async () => {
    // Seen live: "next due in 0s" for hours while nothing could fire it.
    await add("tidy", ["--every", "30m", "--target", "chef"]);
    await add("email-check", ["--at", "09:00", "--target", "chef"]);
    t.clock += 2 * HOUR; // 10:00: both are due, and no watcher runs in the tests
    const out = (await t.sc(["cron", "list"])).stdout;
    expect(out).toContain("WARNING: the watcher is not running");
    expect(out).toContain("OVERDUE: due since");
    expect(out.split("OVERDUE").length - 1).toBe(2);
    expect(out).not.toContain("in 0s");
  });

  it("list still shows the next due time for a job that is not overdue", async () => {
    await add("email-check", ["--at", "09:00", "--target", "chef"]);
    const out = (await t.sc(["cron", "list"])).stdout;
    expect(out).toContain("next due:");
    expect(out).not.toContain("OVERDUE");
  });

  it("run fires now says who was woken and leaves the schedule alone", async () => {
    await add("email-check", ["--at", "09:00", "--target", "chef"]);
    const env = { SC_WATCH_DISABLE_ENSURE: "1" };
    let out = (await t.sc(["cron", "run", "email-check"], { env })).stdout;
    expect(out).toContain("cron job email-check: wrote due as cron event #1 for sous chef");
    expect(out).toContain("Nobody was woken, and nobody will be: the watcher is not running");
    out = (await t.sc(["cron", "run", "email-check"])).stdout; // fires again: nothing is skipped
    expect(out).toContain("wrote due as cron event #2 for sous chef");
    expect(chefWakes()).toEqual([]);
    t.clock += HOUR;
    expect(await watch()).toContain("wrote due as cron event #3 for sous chef");
  });

  it("run on a worker job says what it launched", async () => {
    await addWorker("inbox-scan", ["--every", "12h"]);
    const out = (await t.sc(["cron", "run", "inbox-scan"])).stdout;
    const ids = await workerIds();
    expect(ids).toHaveLength(1);
    const sid = ids[0]!;
    expect(out).toContain(`cron job inbox-scan: launched ${sid}, which starts on the task now (attach: fake attach ${sid})`);
  });

  // --- jobs for a worker

  it("a worker job launches a session told it is scheduled", async () => {
    await addWorker("inbox-scan", ["--every", "12h", "--title", "Scan the inbox"]);
    t.clock += 12 * HOUR;
    expect(await watch()).toContain("cron inbox-scan: launched general-scan-the-inbox-");
    const ids = await workerIds();
    expect(ids).toHaveLength(1);
    const sid = ids[0]!;
    const rec = readJson(path.join(t.home, "state", "sessions", sid, "record.json"));
    expect(rec.cron).toEqual({ job: "inbox-scan" });
    const brief = fs.readFileSync(path.join(t.home, "state", "sessions", sid, "brief.md"), "utf8");
    expect(brief).toContain("check the inbox");
    expect(brief).toContain("cron job `inbox-scan`");
    expect(brief).toContain("sc report nothing-new");
    expect(chefWakes()).toEqual([]); // a launch alone needs nothing from sous chef
  });

  it("a worker still in flight gets the next firing queued until its turn ends", async () => {
    await addWorker("inbox-scan", ["--every", "1h"]);
    t.clock += HOUR;
    await watch();
    const ids = await workerIds();
    expect(ids).toHaveLength(1);
    const sid = ids[0]!;
    t.setFake(sid, { busy: true });
    t.clock += HOUR;
    expect(await watch()).toContain(`wrote inbox message 1 for ${sid}, which is still on an earlier run; it was not woken`);
    expect(await workerIds()).toEqual([sid]); // no second session
    const msgs = inbox(sid);
    expect(msgs).toHaveLength(1);
    const msg = msgs[0];
    expect(msg.from).toBe("cron job inbox-scan");
    expect(msg.text).toContain("check the inbox");
    for (let i = 0; i < 3; i++) {
      t.clock += 5 * 60;
      await watch();
    }
    expect(sessionWakes(sid)).toEqual([]); // never interrupted mid-turn
    t.setFake(sid, { busy: false });
    t.clock += 15;
    expect(await watch()).toContain(`${sid}: re-rang message 1`);
    expect(sessionWakes(sid).length).toBe(1);
  });

  it("a worker in flight but idle is sent the next firing and woken", async () => {
    await addWorker("inbox-scan", ["--every", "1h"]);
    t.clock += HOUR;
    await watch();
    const ids = await workerIds();
    expect(ids).toHaveLength(1);
    const sid = ids[0]!;
    await t.asSession(sid, ["report", "needs-decision", "reply to the landlord?"]);
    t.clock += HOUR;
    expect(await watch()).toContain(`wrote inbox message 1 for ${sid}, which is still on an earlier run, and woke it`);
    expect(sessionWakes(sid))
      .toEqual(["sous chef: new message 1 in your inbox. Run `sc inbox`, act on it, then run `sc inbox ack 1`."]);
  });

  it("a worker in flight gets every firing in its inbox and no second session", async () => {
    await addWorker("inbox-scan", ["--every", "1h"]);
    t.clock += HOUR;
    await watch();
    const ids = await workerIds();
    expect(ids).toHaveLength(1);
    const sid = ids[0]!;
    t.setFake(sid, { busy: true });
    t.clock += HOUR;
    await watch();
    t.clock += HOUR;
    expect(await watch()).toContain(`wrote inbox message 2 for ${sid}`);
    expect(inbox(sid).map((m) => m.seq)).toEqual([1, 2]);
    expect(await workerIds()).toEqual([sid]);
  });

  it("a finished or dead worker is replaced by a new session", async () => {
    await addWorker("inbox-scan", ["--every", "1h"]);
    t.clock += HOUR;
    await watch();
    const ids = await workerIds();
    expect(ids).toHaveLength(1);
    const first = ids[0]!;
    await t.asSession(first, ["report", "done", "two emails need replies"]);
    t.clock += HOUR;
    expect(await watch()).toContain("cron inbox-scan: launched");
    const second = (await workerIds()).filter((s) => s !== first)[0]!;
    t.setFake(second, { alive: false }); // unfinished, but no longer running: nobody would read a message
    t.clock += HOUR;
    expect(await watch()).toContain("cron inbox-scan: launched");
    expect((await workerIds()).length).toBe(3);
  });

  it("a workers done wakes sous chef as usual", async () => {
    await addWorker("inbox-scan", ["--every", "12h"]);
    t.clock += 12 * HOUR;
    await watch();
    const ids = await workerIds();
    expect(ids).toHaveLength(1);
    const sid = ids[0]!;
    await t.asSession(sid, ["report", "done", "two emails need replies"]);
    expect(chefWakes()).toEqual([`sous chef: session ${sid} reported done. Run \`sc events\`.`]);
    expect((await t.sc(["events"])).stdout).toContain("cron job inbox-scan");
  });

  it("a worker that finds nothing is archived without waking anyone", async () => {
    await addWorker("inbox-scan", ["--every", "12h"]);
    t.clock += 12 * HOUR;
    await watch();
    const ids = await workerIds();
    expect(ids).toHaveLength(1);
    const sid = ids[0]!;
    await t.asSession(sid, ["report", "nothing-new", "checked 14 emails, none need Alex"]);
    expect(await watch()).toContain(`archived ${sid}, which found nothing new`);
    expect(await workerIds()).toEqual([]);
    const archived = path.join(t.home, "state", "archive", sid, "record.json");
    expect(fs.existsSync(archived) && fs.statSync(archived).isFile()).toBe(true);
    expect(chefWakes()).toEqual([]);
    expect((await t.sc(["summary"])).stdout).toContain("Nothing waiting.");
    expect((await t.sc(["cron", "list"])).stdout).toContain("nothing new");
  });

  it("only scheduled sessions may report nothing new", async () => {
    const sid = await t.spawn();
    const out = await t.asSession(sid, ["report", "nothing-new", "nothing"], { ok: false });
    expect(out.stderr).toContain("only for sessions a scheduled job launched");
    expect(t.events(sid).map((e) => e.state)).toEqual(["launched"]);
  });

  it("cron add refuses a worker whose kinds skill is missing", async () => {
    t.userKind("drafting", { extra: "skill: draft-it\n" });
    t.fakeSkills({ missing: ["draft-it"] });
    const out = await add("drafts", ["--every", "1h", "--target", "worker", "--kind", "drafting", "--cwd", t.work,
      "--runtime", "fake"], { ok: false });
    expect(out.stderr).toContain("needs the skill 'draft-it'");
    expect((await t.sc(["cron", "list"])).stdout).not.toContain("drafts");
    t.fakeSkills();
    await add("drafts", ["--every", "1h", "--target", "worker", "--kind", "drafting", "--cwd", t.work,
      "--runtime", "fake"]);
    expect(t.fakeState().skill_checks).toContainEqual(["draft-it", fs.realpathSync(t.work)]);
  });

  it("cron add checks with the jobs own runtime", async () => {
    t.userKind("drafting", { extra: "skill: zz-no-such-skill-for-tests\n" });
    const out = await t.sc(["cron", "add", "drafts", "--every", "1h", "--target", "worker", "--kind", "drafting",
      "--cwd", t.work], { stdin: "t", ok: false,
      env: { CLAUDE_CONFIG_DIR: path.join(t.tmp, "empty-config") } });
    expect(out.stderr).toContain("needs the skill 'zz-no-such-skill-for-tests'");
  });

  it("a worker whose skill goes missing fails when fired and still lists", async () => {
    t.userKind("drafting", { extra: "skill: draft-it\n" });
    await add("drafts", ["--every", "1h", "--target", "worker", "--kind", "drafting", "--cwd", t.work,
      "--runtime", "fake"]);
    t.fakeSkills({ missing: ["draft-it"] });
    expect((await t.sc(["cron", "list"])).stdout).toContain("drafts");
    t.clock += HOUR;
    expect(await watch()).toContain("failed");
    const events = cronEvents();
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.state).toBe("failed");
    expect(event.text).toContain("needs the skill 'draft-it'");
  });

  it("a worker that cannot launch is reported to sous chef", async () => {
    await addWorker("inbox-scan", ["--every", "1h"]);
    t.clock += HOUR;
    expect(await watch({ SC_FAKE_LAUNCH_FAILS: "1" })).toContain("failed");
    const events = cronEvents();
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.state).toBe("failed");
    expect(event.text).toContain("could not launch its session");
    expect(chefWakes().length).toBe(1);
  });
});

// What `sc cron run` says about waking sous chef, with a real watcher running. Whether the
// watcher runs is told by its lock, so the test starts one rather than taking the lock itself.
describe("CronWakeNoteTests", () => {
  let t: RunningWatcherTest;

  beforeEach(() => { t = new RunningWatcherTest(); });
  afterEach(() => t.cleanup());

  function setChef(fields: Record<string, unknown> = {}): void {
    const file = path.join(t.state, "fake-runtime.json");
    const data = fs.existsSync(file) ? readJson(file) : { sessions: {}, wakes: [] };
    data.sessions["chef-1"] = { alive: true, busy: false, ...fields };
    fs.writeFileSync(file, JSON.stringify(data));
  }

  it("run says when sous chef is idle busy or not running", async () => {
    check(await t.copySc(["cron", "add", "tidy", "--every", "30m", "--target", "chef"], { stdin: "tidy up" }),
      "sc cron add");
    check(await t.copySc(["hook", "chef-start"], { stdin: JSON.stringify({ session_id: "chef-1", source: "startup" }),
      env: { SC_WATCH_DISABLE_ENSURE: "1" } }), "sc hook chef-start");
    setChef();
    expect((await t.copySc(["watch", "--ensure"], { poll: "3600" })).stdout).toContain("watcher running");
    // Its first cycle is over, so it will not write fake-runtime.json while the test does.
    expect(await t.waitFor(() => fs.existsSync(path.join(t.state, "watch.beat")))).toBe(true);
    for (const [fields, note] of [[{}, "it is idle, so the watcher wakes it within one cycle"],
      [{ busy: true }, "it is mid-turn"],
      [{ alive: false }, "sous chef is not running"]] as [Record<string, unknown>, string][]) {
      setChef(fields);
      const out = await t.copySc(["cron", "run", "tidy"], { poll: "3600" });
      expect(out.code, out.stderr).toBe(0);
      expect(out.stdout).toContain(note);
    }
  });
});

/** Lines as Python's str.splitlines() splits them. */
const LINE_BREAKS = new Set(["\n", "\r", "\v", "\f", "\x1c", "\x1d", "\x1e", "\x85", " ", " "]);
function splitlines(text: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!LINE_BREAKS.has(ch)) {
      line += ch;
      continue;
    }
    if (ch === "\r" && text[i + 1] === "\n") i++;
    lines.push(line);
    line = "";
  }
  if (line !== "") lines.push(line);
  return lines;
}
