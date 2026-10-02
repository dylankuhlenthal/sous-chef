// Behaviour tests for sc, run against the real command line with the fake runtime: cleaning up,
// resuming and listing sessions, the hooks and the state guard, worktrees, and `souschef --print`.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyCode } from "./core-paths.js";
import { type Env, git, read, readJson, ROOT, run, ScTest, SOUSCHEF, write } from "./helpers.js";

let t: ScTest;

/** Python's str.splitlines(): no trailing empty line. */
function splitlines(s: string): string[] {
  const lines = s.split(/\r\n|\n|\r/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function words(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

/** A command that must succeed, like subprocess.run(..., check=True). */
function runOk(args: string[], cwd?: string): void {
  const r = spawnSync(args[0]!, args.slice(1), { cwd, encoding: "utf8" });
  if (r.status !== 0) expect.fail(`${args.join(" ")}: ${r.stderr}`);
}

// An origin with one commit, and a repo root in Alex's layout: .bare/, a .git file, .local/.env.
// (WorktreeTests.make_repo, also used by ResumeAndReleaseTests.)
function makeRepo(t: ScTest): string {
  const origin = path.join(t.tmp, "origin.git");
  const seed = path.join(t.tmp, "seed");
  runOk(["git", "init", "-q", "--bare", "-b", "main", origin]);
  runOk(["git", "init", "-q", "-b", "main", seed]);
  fs.writeFileSync(path.join(seed, ".gitignore"), ".env\n");
  runOk(["git", "-C", seed, "add", ".gitignore"]);
  runOk(["git", "-C", seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "first"]);
  runOk(["git", "-C", seed, "push", "-q", origin, "main"]);
  const root = path.join(t.work, "repo");
  runOk(["git", "init", "-q", "--bare", path.join(root, ".bare")]);
  fs.writeFileSync(path.join(root, ".git"), "gitdir: ./.bare\n");
  runOk(["git", "-C", path.join(root, ".bare"), "remote", "add", "origin", origin]);
  runOk(["git", "-C", path.join(root, ".bare"), "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  fs.mkdirSync(path.join(root, ".local"));
  fs.writeFileSync(path.join(root, ".local", ".env"), "SECRET=1\n");
  return root;
}

function isFile(p: string): boolean {
  return fs.existsSync(p) && fs.statSync(p).isFile();
}

describe("CleanupTests", () => {
  beforeEach(() => { t = new ScTest(); });
  afterEach(() => t.cleanup());

  it("cleanup refuses uncommitted changes then force archives", async () => {
    git(t.work, ["init", "-q"]);
    fs.writeFileSync(path.join(t.work, "file.txt"), "changed");
    const sid = await t.spawn();
    const out = await t.sc(["cleanup", sid], { ok: false });
    expect(out.stderr).toContain("uncommitted changes");
    await t.sc(["cleanup", sid, "--force"]);
    expect(isFile(path.join(t.home, "state", "archive", sid, "record.json"))).toBe(true);
    expect((await t.sc(["sessions"])).stdout).not.toContain(sid);
  });

  it("cleanup refuses commits no remote has", async () => {
    git(t.work, ["init", "-q"]);
    git(t.work, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "local"]);
    const sid = await t.spawn();
    expect((await t.sc(["cleanup", sid], { ok: false })).stderr).toContain("no remote has");
  });
});

describe("ResumeAndReleaseTests", () => {
  beforeEach(() => { t = new ScTest(); });
  afterEach(() => t.cleanup());

  it("resume clears the stopped flag and records it", async () => {
    const sid = await t.spawn();
    await t.sc(["stop", sid]);
    let rec = readJson(path.join(t.home, "state", "sessions", sid, "record.json"));
    expect(rec.stopped_by_sc).toBe(true);
    expect(t.events(sid).at(-1).state).toBe("stopped");
    await t.sc(["resume", sid]);
    rec = readJson(path.join(t.home, "state", "sessions", sid, "record.json"));
    expect(rec.stopped_by_sc).toBe(false);
    expect(t.events(sid).at(-1).state).toBe("resumed");
    expect((await t.sc(["sessions"])).stdout).toContain("waiting on: agent");
    expect(t.fakeState().sessions[sid].alive).toBe(true);
  });

  it("resume refuses a session that is still running", async () => {
    const sid = await t.spawn();
    const out = await t.sc(["resume", sid], { ok: false });
    expect(out.stderr).toContain("already running");
    expect(out.stderr).toContain(`sc send ${sid}`);
    expect(t.events(sid).map((e) => e.state)).not.toContain("resumed");
  });

  it("resumed session is reachable again", async () => {
    const sid = await t.spawn();
    await t.sc(["stop", sid]);
    expect((await t.sc(["send", sid, "while stopped"])).stdout).toContain("not running");
    await t.sc(["resume", sid]);
    expect((await t.sc(["send", sid, "after resume"])).stdout).toContain("session was woken");
  });

  it("a failed launch does not keep holding the worktree", async () => {
    const root = makeRepo(t);
    await t.sc(["worktree", "--repo", root, "--branch", "alx/z", "--dir", "z", "--base", "main"]);
    const wt = path.join(root, "z");
    const failed = await t.sc(["spawn", "--kind", "general", "--title", "doomed", "--cwd", wt,
      "--runtime", "fake"], { stdin: "t", env: { SC_FAKE_LAUNCH_FAILS: "1" }, ok: false });
    expect(failed.stderr).toContain("fake runtime was told to fail");
    const reg = readJson(path.join(t.home, "state", "worktrees.json"));
    expect(reg[fs.realpathSync(wt)].session).toBeNull();
    await t.sc(["spawn", "--kind", "general", "--title", "next", "--cwd", wt, "--runtime", "fake"], { stdin: "t" });
  });

  it("cleanup frees the worktree registry entry", async () => {
    const root = makeRepo(t);
    await t.sc(["worktree", "--repo", root, "--branch", "alx/w", "--dir", "w", "--base", "main"]);
    const wt = path.join(root, "w");
    const sid = words((await t.sc(["spawn", "--kind", "general", "--title", "first", "--cwd", wt,
      "--runtime", "fake"], { stdin: "t" })).stdout)[1]!;
    await t.sc(["cleanup", sid]);
    const reg = readJson(path.join(t.home, "state", "worktrees.json"));
    expect(reg[fs.realpathSync(wt)].session).toBeNull();
  });

  it("entries whose folder is gone are dropped unless an active session holds them", async () => {
    const root = makeRepo(t);
    for (const name of ["kept", "held", "gone"]) {
      await t.sc(["worktree", "--repo", root, "--branch", `alx/${name}`, "--dir", name, "--base", "main"]);
    }
    const [kept, held, gone] = ["kept", "held", "gone"].map((n) => fs.realpathSync(path.join(root, n))) as [string, string, string];
    const sid = words((await t.sc(["spawn", "--kind", "general", "--title", "holds it", "--cwd", held,
      "--runtime", "fake"], { stdin: "t" })).stdout)[1]!;
    fs.rmSync(held, { recursive: true, force: true });
    fs.rmSync(gone, { recursive: true, force: true });
    await t.sc(["worktree", "--repo", root, "--branch", "alx/new", "--dir", "new", "--base", "main"]);
    let reg = readJson(path.join(t.home, "state", "worktrees.json"));
    expect(Object.keys(reg).sort()).toEqual([kept, held, fs.realpathSync(path.join(root, "new"))].sort());
    expect(reg[held].session).toBe(sid);
    await t.sc(["cleanup", sid]);
    reg = readJson(path.join(t.home, "state", "worktrees.json"));
    expect(Object.keys(reg).sort()).toEqual([kept, fs.realpathSync(path.join(root, "new"))].sort());
  });
});

describe("ActivityListingTests", () => {
  const RUNNING = [{ kind: "subagent", label: "Build TRV-1116 web types", since: 1_799_999_400.0 },
    { kind: "subagent", label: "rr2 finder: bugs", since: 1_799_999_900.0 },
    { kind: "subagent", label: "rr2 finder: hostile", since: 1_799_999_900.0 },
    { kind: "shell", label: "npm run typecheck", since: 1_799_999_950.0 }];

  beforeEach(() => { t = new ScTest(); });
  afterEach(() => t.cleanup());

  it("sessions shows what a session is doing on one extra line", async () => {
    const sid = await t.spawn("general", "Orchestrate TRV-1114");
    const other = await t.spawn("general", "Quiet one");
    t.setFake(sid, { activity: { detail: "TRV-1116 building, awaiting builder report", in_flight: 4,
      running: RUNNING } });
    const out = (await t.sc(["sessions"])).stdout;
    const lines = splitlines(out);
    const row = lines.findIndex((line) => line.includes(sid));
    expect(lines[row]).toContain("idle, 4 in flight");
    expect(lines[row + 1]).toBe(
      "    doing: TRV-1116 building, awaiting builder report | " +
      "subagents: Build TRV-1116 web types, rr2 finder: bugs, +1 more");
    expect(out).not.toContain("npm run typecheck");
    expect(lines.length).toBe(3); // one line for the quiet session, two for the busy one
    expect(lines[2]).toContain(other);
    expect((await t.sc(["summary"])).stdout).toContain("doing: TRV-1116");
  });

  it("status lists everything in flight", async () => {
    const sid = await t.spawn();
    t.setFake(sid, { activity: { detail: "reviewing", in_flight: 4, running: RUNNING } });
    const out = (await t.sc(["status", sid])).stdout;
    expect(out).toContain("doing: reviewing");
    expect(out).toContain("subagents and background commands in flight: 4");
    expect(out).toContain("subagent: Build TRV-1116 web types, started 10m ago");
    expect(out).toContain("shell: npm run typecheck, started 50s ago");
  });

  it("no activity changes nothing and a stopped session shows none", async () => {
    const sid = await t.spawn();
    const before = (await t.sc(["sessions"])).stdout;
    expect(splitlines(before).length).toBe(1);
    expect(before).not.toContain("in flight");
    t.setFake(sid, { activity: { detail: "old news", in_flight: 2, running: RUNNING }, alive: false });
    const out = (await t.sc(["sessions"])).stdout;
    expect(out).not.toContain("old news");
    expect(out).not.toContain("in flight");
    expect((await t.sc(["status", sid])).stdout).not.toContain("doing:");
  });
});

describe("HookTests", () => {
  beforeEach(() => { t = new ScTest(); });
  afterEach(() => t.cleanup());

  async function chefStart(sessionId: string, source = "startup"): Promise<string> {
    return (await t.sc(["hook", "chef-start"],
      { stdin: JSON.stringify({ session_id: sessionId, source }),
        env: { SC_WATCH_DISABLE_ENSURE: "1" } })).stdout;
  }

  // Put a row in the fake runtime's listing so a chef looks running (or not).
  function fakeAlive(sessionId: string, alive = true): void {
    const file = path.join(t.home, "state", "fake-runtime.json");
    const data = fs.existsSync(file) ? readJson(file) : { sessions: {}, wakes: [] };
    data.sessions ??= {};
    data.sessions[sessionId] = { alive, busy: false };
    write(file, JSON.stringify(data));
  }

  function registered(): string {
    return readJson(path.join(t.home, "state", "chef.json")).session_id;
  }

  // A copy of the core's code, committed in a git repo of its own.
  function codeRepo(name: string): string {
    const repo = copyCode(path.join(t.tmp, name), ROOT);
    for (const args of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"],
      ["add", "-A"], ["commit", "-qm", "init"]]) {
      git(repo, args);
    }
    return repo;
  }

  async function copyChefStart(code: string, sessionId: string, env: Env = {}): Promise<string> {
    const e = { ...t.baseEnv, SC_TEST_WORKTREE_CHECK: "1", SC_WATCH_DISABLE_ENSURE: "1", ...env };
    return (await run(path.join(code, "bin", "sc"), ["hook", "chef-start"],
      { stdin: JSON.stringify({ session_id: sessionId, source: "startup" }), env: e })).stdout;
  }

  it("guard denies edits under state only", async () => {
    const inside = JSON.stringify({ tool_input: { file_path: path.join(t.home, "state", "cursors.json") } });
    const out = (await t.sc(["hook", "guard-edit"], { stdin: inside })).stdout;
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("deny");
    const outside = JSON.stringify({ tool_input: { file_path: path.join(t.home, "memory", "ideas.md") } });
    expect((await t.sc(["hook", "guard-edit"], { stdin: outside })).stdout.trim()).toBe("");
  });

  it("worker start mentions unhandled messages", async () => {
    const sid = await t.spawn();
    await t.sc(["send", sid, "hello"]);
    const out = (await t.sc(["hook", "worker-start", "--session", sid], { stdin: JSON.stringify({ source: "compact" }) })).stdout;
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    expect(ctx).toContain("1 unhandled message");
    expect(ctx).toContain("source=compact");
  });

  it("a second session does not take a running chefs registration", async () => {
    await chefStart("chef-1");
    fakeAlive("chef-1");
    const out = await chefStart("chef-2");
    expect(out).toContain("You are NOT sous chef");
    expect(out).toContain("chef-1");
    expect(out).not.toContain("SOUS CHEF STARTUP SUMMARY");
    expect(registered()).toBe("chef-1");
  });

  // The hook fires again on resume and compaction: the summary must not be skipped.
  it("the chef still gets its summary on its own restart", async () => {
    await chefStart("chef-1");
    fakeAlive("chef-1");
    const out = await chefStart("chef-1", "compact");
    expect(out).toContain("SOUS CHEF STARTUP SUMMARY");
    expect(out).not.toContain("You are NOT sous chef");
    expect(registered()).toBe("chef-1");
  });

  it("a dead chefs registration is taken over", async () => {
    await chefStart("chef-1");
    fakeAlive("chef-1", false);
    const out = await chefStart("chef-2");
    expect(out).toContain("SOUS CHEF STARTUP SUMMARY");
    expect(out).toContain("it is not running, so this session took over");
    expect(registered()).toBe("chef-2");
  });

  // No row at all in the runtime listing means the session is not there.
  it("an unknown chef is treated as gone", async () => {
    await chefStart("chef-1");
    expect(registered()).toBe("chef-1");
    await chefStart("chef-2");
    expect(registered()).toBe("chef-2");
  });

  it("chef take hands the role over deliberately", async () => {
    await chefStart("chef-1");
    fakeAlive("chef-1");
    const out = (await t.sc(["chef", "--take"], { env: { CLAUDE_CODE_SESSION_ID: "chef-2" } })).stdout;
    expect(out).toContain("is now sous chef");
    expect(out).toContain("taken from chef-1");
    expect(registered()).toBe("chef-2");
  });

  // A worktree of the core has no data folder of its own, and must not become sous chef.
  it("a session in a worktree of the repo is not sous chef", async () => {
    const repo = codeRepo("repo");
    const wt = path.join(t.tmp, "wt");
    git(repo, ["worktree", "add", "-q", wt]);
    for (const env of [{}, { SC_TEST_HOME: "" }] as Env[]) { // with a test data folder, and with none at all (no my link)
      const out = await copyChefStart(wt, "wt-session", env);
      expect(out).toContain("You are NOT sous chef");
      expect(out).toContain("git worktree");
      expect(out).toContain(fs.realpathSync(repo));
      expect(out).not.toContain("SOUS CHEF STARTUP SUMMARY");
    }
    expect(fs.existsSync(path.join(t.home, "state", "chef.json"))).toBe(false);
    expect(fs.existsSync(path.join(wt, "state"))).toBe(false);
  });

  it("the ordinary checkout is not mistaken for a worktree", async () => {
    const repo = codeRepo("plain");
    const out = await copyChefStart(repo, "plain-session");
    expect(out).toContain("SOUS CHEF STARTUP SUMMARY");
    expect(readJson(path.join(t.home, "state", "chef.json")).session_id).toBe("plain-session");
  });

  it("chef take needs to run inside a claude session", async () => {
    const out = await t.sc(["chef", "--take"], { ok: false });
    expect(out.stderr).toContain("CLAUDE_CODE_SESSION_ID is not set");
  });

  it("chef start registers and injects summary", async () => {
    fs.mkdirSync(path.join(t.home, "memory"));
    fs.writeFileSync(path.join(t.home, "memory", "focus.md"), "Working on sous chef docs");
    await t.spawn("general", "Visible task");
    const out = (await t.sc(["hook", "chef-start"], { stdin: JSON.stringify({ session_id: "chef-9", source: "compact" }),
      env: { SC_WATCH_DISABLE_ENSURE: "1" } })).stdout;
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    expect(ctx).toContain("source=compact");
    expect(ctx).toContain("Working on sous chef docs");
    expect(ctx).toContain("Visible task");
    expect((await t.sc(["chef"])).stdout).toContain("chef-9");
  });

  it("hook errors never fail and are logged", async () => {
    const out = await t.sc(["hook", "worker-stop", "--session", "missing-session"], { stdin: "{}" });
    expect(out.code).toBe(0);
    expect(read(path.join(t.home, "state", "hook-errors.log"))).toContain("worker-stop");
  });
});

describe("GuardTests", () => {
  beforeEach(() => { t = new ScTest(); });
  afterEach(() => t.cleanup());

  async function guard(target: string, session?: string): Promise<string> {
    const args = ["hook", "guard-edit", ...(session ? ["--session", session] : [])];
    const out = await t.sc(args, { stdin: JSON.stringify({ tool_input: { file_path: target } }) });
    return out.stdout.trim() ? JSON.parse(out.stdout).hookSpecificOutput.permissionDecision : "allow";
  }

  it("sessions are guarded too but may write their own report", async () => {
    const a = await t.spawn("general", "a");
    const b = await t.spawn("general", "b");
    const sdir = path.join(t.home, "state", "sessions");
    expect(await guard(path.join(sdir, b, "events.jsonl"), a)).toBe("deny");
    expect(await guard(path.join(sdir, a, "report.md"), a)).toBe("allow");
    expect(await guard(path.join(sdir, b, "report.md"), a)).toBe("deny");
    expect(await guard(path.join(sdir, a, "report.md"))).toBe("deny"); // sous chef itself: no exception
  });

  it("spawned sessions get the guard hook", async () => {
    const sid = await t.spawn();
    const hooks = t.fakeState().sessions[sid].settings.hooks.PreToolUse;
    expect(hooks[0].matcher).toBe("Edit|Write|MultiEdit|NotebookEdit");
    expect(hooks[0].hooks[0].command).toContain(`guard-edit --session ${sid}`);
  });
});

describe("WorktreeTests", () => {
  beforeEach(() => { t = new ScTest(); });
  afterEach(() => t.cleanup());

  it("worktree created from origin with env linked and recorded", async () => {
    const root = makeRepo(t);
    const out = await t.sc(["worktree", "--repo", root, "--branch", "alx/TRV-1-thing", "--dir", "thing", "--base", "main"]);
    expect(out.stdout).toContain("linked env files from .local/: .env");
    const wt = path.join(root, "thing");
    expect(fs.readlinkSync(path.join(wt, ".env"))).toBe("../.local/.env");
    const branch = spawnSync("git", ["-C", wt, "branch", "--show-current"], { encoding: "utf8" });
    expect(branch.stdout.trim()).toBe("alx/TRV-1-thing");
    const upstream = spawnSync("git", ["-C", wt, "rev-parse", "--abbrev-ref", "@{u}"], { encoding: "utf8" });
    expect(upstream.status).not.toBe(0);
    const reg = readJson(path.join(t.home, "state", "worktrees.json"));
    expect(reg[fs.realpathSync(wt)].session).toBeNull();
  });

  it("worktree refuses existing dir or branch and bad names", async () => {
    const root = makeRepo(t);
    await t.sc(["worktree", "--repo", root, "--branch", "alx/a", "--dir", "a", "--base", "main"]);
    expect((await t.sc(["worktree", "--repo", root, "--branch", "alx/b", "--dir", "a",
      "--base", "main"], { ok: false })).stderr).toContain("already exists");
    expect((await t.sc(["worktree", "--repo", root, "--branch", "alx/a",
      "--dir", "b", "--base", "main"], { ok: false })).stderr).toContain("branch alx/a already exists");
    expect((await t.sc(["worktree", "--repo", root, "--branch", "alx/c", "--dir", "Bad Name",
      "--base", "main"], { ok: false })).stderr).toContain("kebab-case");
  });

  it("session in its own worktree turns off isolation only for itself", async () => {
    const root = makeRepo(t);
    await t.sc(["worktree", "--repo", root, "--branch", "alx/x", "--dir", "x", "--base", "main"]);
    const wt = path.join(root, "x");
    const out = await t.sc(["spawn", "--kind", "general", "--title", "Build x", "--cwd", wt, "--runtime", "fake"],
      { stdin: "build it" });
    const sid = words(out.stdout)[1]!;
    const launched = t.fakeState().sessions[sid];
    expect(launched.settings.worktree).toEqual({ bgIsolation: "none" });
    expect(read(path.join(t.home, "state", "sessions", sid, "brief.md"))).toContain("worktree sous chef created for this task");
    expect((await t.sc(["spawn", "--kind", "general", "--title", "again", "--cwd", wt,
      "--runtime", "fake"], { stdin: "again", ok: false })).stderr).toContain("used by active session");
    const other = await t.spawn("general", "elsewhere");
    expect(Object.keys(t.fakeState().sessions[other].settings)).not.toContain("worktree");
    expect(read(path.join(t.home, "state", "sessions", other, "brief.md"))).toContain("may require you to enter a worktree");
  });

  it("worktree can be reused after its session is cleaned up", async () => {
    const root = makeRepo(t);
    await t.sc(["worktree", "--repo", root, "--branch", "alx/y", "--dir", "y", "--base", "main"]);
    const wt = path.join(root, "y");
    const sid = words((await t.sc(["spawn", "--kind", "general", "--title", "first", "--cwd", wt, "--runtime", "fake"],
      { stdin: "t" })).stdout)[1]!;
    await t.sc(["cleanup", sid]);
    const again = words((await t.sc(["spawn", "--kind", "general", "--title", "second", "--cwd", wt, "--runtime", "fake"],
      { stdin: "t" })).stdout)[1]!;
    expect(t.fakeState().sessions[again].settings.worktree).toEqual({ bgIsolation: "none" });
  });
});

// `souschef --print` against the fake runtime (SC_CHEF_RUNTIME=fake): what it decides from the
// registered sous chef and the runtime's listing. Never run without --print, which would attach.
describe("SouschefTests", () => {
  beforeEach(() => { t = new ScTest(); });
  afterEach(() => t.cleanup());

  async function souschef(args: string[] = [], o: { env?: Env; ok?: boolean } = {}) {
    const out = await run(SOUSCHEF, ["--print", ...args], { env: t.env(o.env) });
    if ((o.ok ?? true) && out.code !== 0) {
      expect.fail(`souschef ${args.join(" ")} failed (${out.code}): ${out.stdout}${out.stderr}`);
    }
    return out;
  }

  // Replace the fake runtime's sessions with these rows.
  function fakeRows(rows: Record<string, unknown>): void {
    write(path.join(t.home, "state", "fake-runtime.json"), JSON.stringify({ sessions: rows, wakes: [] }));
  }

  // The rows of sous chef sessions souschef started (the fake runtime keys them fake-chef-<n>).
  function started(): Record<string, any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    return Object.fromEntries(Object.entries(t.fakeState().sessions as Record<string, unknown>)
      .filter(([k]) => k.startsWith("fake-chef-")));
  }

  it("with nothing registered a new sous chef is started in bypass mode", async () => {
    const out = (await souschef()).stdout;
    expect(out).toBe("started sous chef (chef-1) with permissions: bypass\nfake attach chef-1\n");
    const row = started()["fake-chef-1"];
    expect([row.name, row.permissions, row.cwd]).toEqual(["sous-chef", "bypass", ROOT]);
  });

  it("a running background sous chef is attached not started", async () => {
    await t.registerChef();
    fakeRows({ "chef-1": { alive: true, pid: 1, kind: "background", id: "abcd1234" } });
    expect((await souschef()).stdout).toBe("fake attach abcd1234\n");
    expect(started()).toEqual({});
  });

  it("a sous chef open in a terminal is reported and left alone", async () => {
    await t.registerChef();
    fakeRows({ "chef-1": { alive: true, pid: 1, kind: "interactive", id: "abcd1234" } });
    const out = await souschef([], { ok: false });
    expect(out.code).toBe(1);
    expect(out.stdout).toContain("already open in another terminal");
    expect(out.stdout).not.toContain("fake attach");
    expect(started()).toEqual({});
  });

  it("a stopped or unlisted sous chef is resumed", async () => {
    await t.registerChef();
    for (const rows of [{ "chef-1": { alive: false, kind: "background", id: "abcd1234" } }, {}]) {
      fakeRows(rows);
      const out = (await souschef()).stdout;
      const short = Object.keys(rows).length ? "abcd1234" : "chef-1";
      expect(out).toBe(`resumed sous chef (${short})\nfake attach ${short}\n`);
      expect(t.fakeState().sessions["chef-1"].pid).toBe(1);
      expect(started()).toEqual({});
    }
  });

  it("a sous chef that does not come back is replaced by a new one", async () => {
    await t.registerChef();
    fakeRows({ "chef-1": { alive: false, kind: "background", id: "abcd1234" } });
    const out = (await souschef([], { env: { SC_FAKE_RESUME_FAILS: "1" } })).stdout;
    expect(out).toBe("could not resume the previous sous chef session; starting a new one\n" +
      "started sous chef (chef-1) with permissions: bypass\nfake attach chef-1\n");
    expect(Object.keys(started())).toEqual(["fake-chef-1"]);
  });

  it("new stops the background sous chef and starts a fresh one", async () => {
    await t.registerChef();
    fakeRows({ "chef-1": { alive: true, pid: 1, kind: "background", id: "abcd1234" } });
    const out = (await souschef(["--new"])).stdout;
    expect(out).toBe("stopped the previous sous chef (abcd1234); its conversation is kept\n" +
      "started sous chef (chef-1) with permissions: bypass\nfake attach chef-1\n");
    const old = t.fakeState().sessions["chef-1"];
    expect(old.alive).toBe(false);
    expect(Object.keys(old)).not.toContain("pid");
    expect(started()["fake-chef-1"].permissions).toBe("bypass");
  });
});
