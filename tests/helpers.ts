// The behaviour suite's fixtures: a temporary home per test, and sc run as a program.
//
// Every test runs the real `bin/sc` of this checkout (ROOT) against the fake runtime
// (SC_CHEF_RUNTIME=fake), with its own temporary data home (SC_TEST_HOME), work folder and
// clock (SC_FAKE_NOW). No test starts a Claude session.
//
// sc is always run asynchronously (child_process.spawn wrapped in a promise), never with
// spawnSync: the fake Slack relay (tests/fake-relay.ts) answers from this process, and a
// synchronous spawn would block the event loop it answers on.
//
// Use: in a describe, `let t: ScTest; beforeEach(() => { t = new ScTest(); }); afterEach(() => t.cleanup());`
import { spawn as spawnChild, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { copyCode } from "./core-paths.js";

/** This checkout: the code under test, and the content the core checks look at. Links resolved,
 * as sc sees its own root, so paths it prints compare equal. */
export const ROOT = fs.realpathSync(path.resolve(import.meta.dirname, ".."));
export const SC = path.join(ROOT, "bin", "sc");
export const SOUSCHEF = path.join(ROOT, "bin", "souschef");

export type Env = Record<string, string>;

export interface Out {
  /** The exit code, or null when the program was killed by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Text for stdin. Without it stdin is empty (not a terminal, at its end at once). */
  stdin?: string;
  env?: Env;
  cwd?: string;
  /** Kill the program after this long (default 60 s) and fail with what it printed. */
  timeoutMs?: number;
}

/** Run a program and collect its output once it exits and its output pipes close. */
export function run(program: string, args: string[], opts: RunOptions = {}): Promise<Out> {
  return new Promise((resolve, reject) => {
    const child = spawnChild(program, args, { env: opts.env ?? (process.env as Env), cwd: opts.cwd });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? 60_000);
    child.stdout.on("data", (b: Buffer) => stdout.push(b));
    child.stderr.on("data", (b: Buffer) => stderr.push(b));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const out = { code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (timedOut) reject(new Error(`${program} ${args.join(" ")} timed out: ${out.stdout}${out.stderr}`));
      else resolve(out);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.stdin ?? "");
  });
}

/** Fail the test unless the program exited 0, naming the command and what it printed. */
export function check(out: Out, what: string): Out {
  if (out.code !== 0) expect.fail(`${what} failed (${out.code}): ${out.stdout}${out.stderr}`);
  return out;
}

/** Git, synchronously (it never needs the relay), with a fixed identity when asked. */
export function git(folder: string, args: string[], opts: { env?: Env; ok?: boolean } = {}): string {
  const r = spawnSync("git", ["-C", folder, ...args], { encoding: "utf8", env: { ...process.env, ...(opts.env ?? {}) } });
  if ((opts.ok ?? true) && r.status !== 0) expect.fail(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** A git identity and no global config, for tests that commit. */
export const GIT_ENV: Env = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null",
};

/** A number as Python's str() writes a float (1800000000.0), the form SC_FAKE_NOW always had. */
export function pyFloat(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

export function readJson<T = any>(file: string): T { // eslint-disable-line @typescript-eslint/no-explicit-any
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

/** Each line of a JSON-lines file, parsed. */
export function readJsonl(file: string): any[] { // eslint-disable-line @typescript-eslint/no-explicit-any
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
}

export function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

export function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

export interface ScOptions {
  stdin?: string;
  env?: Env;
  /** Fail the test when sc exits non-zero (default true). */
  ok?: boolean;
}

/** One test's world: a temporary home and work folder, owner Alex, a fake clock. */
export class ScTest {
  readonly tmp: string;
  readonly home: string;
  readonly work: string;
  clock = 1_800_000_000.0;
  readonly baseEnv: Env;

  constructor() {
    this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sc-test-"));
    this.home = path.join(this.tmp, "home");
    this.work = path.join(this.tmp, "work");
    fs.mkdirSync(this.home);
    fs.mkdirSync(this.work);
    // The owner every test runs as, unless it says otherwise (owner.json, `sc owner set`).
    fs.writeFileSync(path.join(this.home, "owner.json"), JSON.stringify({ name: "Alex", branch_prefix: "alx/" }));
    this.baseEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith("SC_") && !k.startsWith("CLAUDE_CODE_SESSION_ID")) this.baseEnv[k] = v;
    }
    Object.assign(this.baseEnv, { SC_TEST_HOME: this.home, SC_CHEF_RUNTIME: "fake", SC_IDENTITY_WAIT: "0" });
  }

  async cleanup(): Promise<void> {
    fs.rmSync(this.tmp, { recursive: true, force: true });
  }

  /** The environment sc runs with: the base, the clock, then the call's own. */
  env(extra: Env = {}): Env {
    return { ...this.baseEnv, SC_FAKE_NOW: pyFloat(this.clock), ...extra };
  }

  /** Run a program (any sc: this checkout's, a copy's) as the test runs sc. */
  async runSc(program: string, args: string[], opts: ScOptions = {}): Promise<Out> {
    const out = await run(program, args, { stdin: opts.stdin, env: this.env(opts.env) });
    if (opts.ok ?? true) check(out, `sc ${args.join(" ")}`);
    return out;
  }

  sc(args: string[], opts: ScOptions = {}): Promise<Out> {
    return this.runSc(SC, args, opts);
  }

  /** Spawn a session on the fake runtime in the work folder, and return its id. */
  async spawn(kind = "general", title = "Test task", task = "do the thing"): Promise<string> {
    const out = await this.sc(["spawn", "--kind", kind, "--title", title, "--cwd", this.work, "--runtime", "fake"],
      { stdin: task });
    return out.stdout.split(/\s+/).filter(Boolean)[1]!;
  }

  /** Write a kind into the test home's kinds/ (the user kinds folder) and return its name. */
  userKind(name: string, o: { waiting?: string; extra?: string; body?: string; description?: string } = {}): string {
    fs.mkdirSync(path.join(this.home, "kinds"), { recursive: true });
    fs.writeFileSync(path.join(this.home, "kinds", `${name}.md`),
      `---\ndescription: ${o.description ?? name + " kind"}\nstarts_waiting_on: ${o.waiting ?? "agent"}\n` +
      `${o.extra ?? ""}---\n${o.body ?? "Do the task."}\n`);
    return name;
  }

  /** A test kind whose sessions start waiting on the owner in bypass mode, like a shaping kind. */
  ownerKind(): string {
    return this.userKind("pairing", { waiting: "owner", extra: "permissions: bypass\n",
      description: "pair on an idea with {{owner}}" });
  }

  get fakeFile(): string {
    return path.join(this.home, "state", "fake-runtime.json");
  }

  /** Tell the fake runtime which skills are missing (false) or cannot be told (null). */
  fakeSkills(o: { missing?: string[]; unknown?: string[] } = {}): void {
    const data = fs.existsSync(this.fakeFile) ? readJson(this.fakeFile) : { sessions: {}, wakes: [] };
    Object.assign(data, { missing_skills: o.missing ?? [], unknown_skills: o.unknown ?? [] });
    write(this.fakeFile, JSON.stringify(data));
  }

  asSession(sid: string, args: string[], o: { ok?: boolean; claudeSid?: string } = {}): Promise<Out> {
    return this.sc(args, { env: { CLAUDE_CODE_SESSION_ID: o.claudeSid ?? `fake-${sid}` }, ok: o.ok });
  }

  fakeState(): any { // eslint-disable-line @typescript-eslint/no-explicit-any
    return readJson(this.fakeFile);
  }

  setFake(sid: string, fields: Record<string, unknown>): void {
    const data = this.fakeState();
    Object.assign(data.sessions[sid], fields);
    fs.writeFileSync(this.fakeFile, JSON.stringify(data));
  }

  events(sid: string): any[] { // eslint-disable-line @typescript-eslint/no-explicit-any
    return readJsonl(path.join(this.home, "state", "sessions", sid, "events.jsonl"));
  }

  async registerChef(): Promise<void> {
    await this.sc(["hook", "chef-start"], { stdin: JSON.stringify({ session_id: "chef-1", source: "startup" }),
      env: { SC_WATCH_DISABLE_ENSURE: "1" } });
  }

  async hook(name: string, sid: string): Promise<void> {
    await this.sc(["hook", name, "--session", sid], { stdin: "{}" });
  }
}

/** Runs a copy of the core's code (core-paths.ts copyCode) in a temporary code root, so a test
 * can give it its own core kinds without depending on the shipped ones. */
export class CodeCopyTest extends ScTest {
  readonly code: string;

  constructor() {
    super();
    this.code = copyCode(path.join(this.tmp, "code"), ROOT);
  }

  copySc(args: string[], opts: ScOptions = {}): Promise<Out> {
    return this.runSc(path.join(this.code, "bin", "sc"), args, opts);
  }
}

/** Starts real watcher processes (no Claude sessions) from a copy of the code under test, and
 * stops them afterwards. A test never takes the watcher's lock itself (decision 0024, locks
 * through proper-lockfile), so a test that needs a running watcher starts one. */
export class RunningWatcherTest extends ScTest {
  readonly code: string;
  readonly state: string;
  /** A file the watcher counts as code (SC_TEST_CODE_FILE), so a test can change "the code". */
  readonly marker: string;

  constructor() {
    super();
    this.code = copyCode(path.join(this.tmp, "code"), ROOT);
    this.state = path.join(this.home, "state");
    this.marker = path.join(this.code, "code-marker");
    fs.writeFileSync(this.marker, "");
  }

  override async cleanup(): Promise<void> {
    this.stopWatchers(); // before the temporary home (and its watch.pid) is deleted
    await super.cleanup();
  }

  /** Run the copy's sc. Every call passes the marker: sc compares the watcher's code with its
   * own, marker included. Never fails the test by itself: callers check the exit code. */
  copySc(args: string[], o: { poll?: string; stdin?: string; env?: Env } = {}): Promise<Out> {
    return run(path.join(this.code, "bin", "sc"), args, { stdin: o.stdin, timeoutMs: 60_000,
      env: { ...this.baseEnv, SC_WATCH_POLL: o.poll ?? "0.2", SC_TEST_CODE_FILE: this.marker, ...(o.env ?? {}) } });
  }

  /** Every watcher any test started runs from this test's copy of the code, whose temporary
   * path is unique and appears in the command line however the watcher was started. */
  stopWatchers(): void {
    spawnSync("pkill", ["-KILL", "-f", this.code]);
  }

  alive(pid: number): boolean {
    return spawnSync("kill", ["-0", String(pid)]).status === 0;
  }

  /** Poll every 0.1 s, up to `seconds`, until the condition holds; return whether it does. */
  async waitFor(condition: () => boolean, seconds = 10): Promise<boolean> {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      if (condition()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return condition();
  }

  codeRecord(): any { // eslint-disable-line @typescript-eslint/no-explicit-any
    const file = path.join(this.state, "watch.code");
    return fs.existsSync(file) ? readJson(file) : {};
  }

  pid(): number {
    return parseInt(read(path.join(this.state, "watch.pid")), 10);
  }
}

/** Where the captured outputs live: what sous chef prints and writes, word for word. */
export const CAPTURED = path.join(ROOT, "tests", "captured");

/** A test that compares output with a file in tests/captured/. Paths, session ids and the
 * fake relay's port change from run to run, so they become placeholders (<HOME>, <WORK>,
 * <CODE>, <SID1>, <RELAY>) first. With SC_UPDATE_CAPTURED set, the file is rewritten instead:
 * read the diff before committing it. TZ=UTC for every sc call. */
export class CapturedTest extends ScTest {
  readonly sids: string[] = [];

  constructor() {
    super();
    this.baseEnv.TZ = "UTC";
  }

  override async spawn(kind = "general", title = "Test task", task = "do the thing"): Promise<string> {
    const sid = await super.spawn(kind, title, task);
    this.sids.push(sid);
    return sid;
  }

  normalise(text: string): string {
    this.sids.forEach((sid, i) => {
      text = text.split(sid).join(`<SID${i + 1}>`);
    });
    for (const [p, name] of [[this.home, "<HOME>"], [this.work, "<WORK>"], [ROOT, "<CODE>"]] as const) {
      text = text.split(fs.realpathSync(p)).join(name).split(p).join(name);
    }
    return text.replace(/http:\/\/127\.0\.0\.1:\d+/g, "<RELAY>");
  }

  assertCaptured(name: string, raw: string): void {
    const text = this.normalise(raw);
    const file = path.join(CAPTURED, name);
    if (process.env.SC_UPDATE_CAPTURED) {
      write(file, text);
      return;
    }
    expect(fs.existsSync(file), `no captured file ${file}; run with SC_UPDATE_CAPTURED=1 to write it`).toBe(true);
    expect(text, `output differs from tests/captured/${name}`).toBe(read(file));
  }
}
