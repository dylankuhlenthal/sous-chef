// The Claude runtime on Porch (src/runtimes/claude-bg.ts). Never touches a real session:
// every test has its own PORCH_HOME, HOME and CLAUDE_CONFIG_DIR, and Claude Code is either
// canned (an injected `io` for Porch's Claude adapter), Porch's fake adapter, or a stub
// `claude` first on PATH (tests/claude-stub.ts).
//
// Several tests replace the Python-only ClaudeRuntimeParsingTests (tests/test_sc.py), which
// retire with the Python code; each says which behaviour it carries over.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createFakeAdapter, fake, type HarnessIO, Porch, RecordStore, sessionsDir,
} from "@dylankuhlenthal/porch";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workerSettings } from "../src/ops.js";
import {
  createClaudeRuntime, launchArgs, namedArgs, parseShortId, PERMISSION_MODES, SELF_STATUS, statusOf,
} from "../src/runtimes/claude-bg.js";
import { WakeError } from "../src/runtimes/types.js";
import { SCError } from "../src/util.js";
import { installStub, type Stub } from "./claude-stub.js";

const instant = async () => undefined;
const SAVED_ENV = { ...process.env };
let tmp: string;
let env: Record<string, string>;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-runtime-")));
  env = {
    HOME: tmp, CLAUDE_CONFIG_DIR: path.join(tmp, "claude"), PORCH_HOME: path.join(tmp, "porch"),
    PATH: process.env.PATH ?? "",
  };
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR!, { recursive: true });
});

afterEach(() => {
  process.env = { ...SAVED_ENV };
  fs.rmSync(tmp, { recursive: true, force: true });
});

const T1 = "2026-10-01T10:00:00.000Z";
const T2 = "2026-10-01T10:05:30.500Z";
const secs = (iso: string) => Date.parse(iso) / 1000;

// --- 1. Porch's fake adapter: the harness-neutral parts ---------------------------------

describe("on Porch's fake adapter", () => {
  function setup(extraEnv: Record<string, string> = {}) {
    const e = { ...env, ...extraEnv };
    const rt = createClaudeRuntime({ harness: "fake", porch: { env: e, adapters: [createFakeAdapter()] }, wait: instant });
    const ctx = new Porch({ env: e, adapters: [createFakeAdapter()] }).ctx;
    return { rt, ctx };
  }
  const rec = { id: "general-x-1234", handle: { short_id: null, session_id: "s1" } };

  it("reads alive, busy, pid and the prompt", async () => {
    const { rt, ctx } = setup();
    await fake.startSession(ctx, "s1", { pid: 42, status: "idle" });
    expect(await rt.status(rec)).toMatchObject({ alive: true, busy: false, pid: 42, prompt: null });
    await fake.setInsideStatus(ctx, "s1", "busy");
    expect(await rt.status(rec)).toMatchObject({ alive: true, busy: true });
    await fake.setInsideStatus(ctx, "s1", "idle");
    await fake.setPrompt(ctx, "s1", "permission prompt");
    // Held at a prompt is busy, as the runtime contract says.
    expect(await rt.status(rec)).toMatchObject({ alive: true, busy: true, prompt: "permission prompt" });
  });

  it("reads a killed session as gone and an ended one with its reason, neither alive", async () => {
    const { rt, ctx } = setup();
    await fake.startSession(ctx, "s1", { pid: 42, status: "idle" });
    await fake.killSession(ctx, "s1");
    expect(await rt.status(rec)).toMatchObject({ alive: false, busy: null, pid: null, stopped: { status: "gone", reason: null } });
    await fake.startSession(ctx, "s2", { pid: 43, status: "idle" });
    await fake.endSession(ctx, "s2", { reason: "logout" });
    const ended = await rt.status({ id: "y", handle: { session_id: "s2" } });
    expect(ended).toMatchObject({ alive: false, stopped: { status: "ended", reason: "logout" } });
  });

  it("gives turn times in epoch seconds when Porch has the session's record, and none without", async () => {
    const { rt, ctx } = setup();
    await fake.startSession(ctx, "s1", { pid: 42, status: "idle" });
    await fake.setInsideStatus(ctx, "s1", "idle", { lastTurnStart: T1, lastTurnEnd: T2 });
    expect((await rt.status(rec)).turns).toEqual({ last_prompt_at: secs(T1), last_stop_at: secs(T2) });
    await fake.startSession(ctx, "s3", { pid: 44, inside: false });
    const old = await rt.status({ id: "z", handle: { session_id: "s3" } });
    expect(old.alive).toBe(true);
    expect(old.busy).toBeNull(); // unknown: never idle
    expect(old.turns).toBeUndefined();
  });

  it("wakes through deliver, labelled from sous chef, and says why it could not", async () => {
    const { rt, ctx } = setup();
    await fake.startSession(ctx, "s1", { pid: 42, status: "idle" });
    await rt.wake(rec, "sous chef: new message 1");
    expect((await fake.readDeliveries(ctx, "s1")).map((d) => d.text)).toEqual(["[from sous chef] sous chef: new message 1"]);
    await fake.setFailDeliver(ctx, "s1", "socket refused");
    await expect(rt.wake(rec, "again")).rejects.toThrow(new WakeError("socket refused"));
    await fake.killSession(ctx, "s1");
    await expect(rt.wake(rec, "again")).rejects.toThrow(/^general-x-1234 is not running \(fake session s1 is not running\)$/);
    await expect(rt.wakeSessionId("s1-chef-session", "x")).rejects.toThrow(new WakeError("Claude session s1-chef- is not running"));
  });

  it("sets Porch's self status for each report state, and nothing for note and resolved", async () => {
    const { rt, ctx } = setup({ PORCH_FAKE_SESSION_ID: "s1" });
    await fake.startSession(ctx, "s1", { pid: 42, status: "busy" });
    const store = new RecordStore(sessionsDir(env));
    const expected: Record<string, string | null> = {
      "needs-decision": "needs-input", "waiting": "needs-input", "blocked": "blocked", "paused": "blocked",
      "working": "working", "done": "done", "nothing-new": "done", "failed": "failed", "note": null, "resolved": null,
    };
    expect(Object.keys(SELF_STATUS).sort()).toEqual(Object.keys(expected).sort());
    for (const [state, mapped] of Object.entries(expected)) {
      const before = (await store.read("fake", "s1"))?.self ?? null;
      await rt.reportStatus!(rec, state, `text for ${state}`);
      const self = (await store.read("fake", "s1"))?.self ?? null;
      if (mapped === null) expect(self).toEqual(before);
      else expect(self).toMatchObject({ status: mapped, text: `text for ${state}` });
    }
  });
});

// --- 2. Porch's Claude adapter with canned Claude Code output ----------------------------

const SID = "11111111-2222-3333-4444-555555555555";
const SHORT = "ab12cd34";

function row(fields: Record<string, unknown> = {}) {
  return { id: SHORT, sessionId: SID, name: "sc-general-x-1234", kind: "background", cwd: "/w", pid: 4242, status: "idle", ...fields };
}

describe("on Porch's Claude adapter, with canned listings", () => {
  function setup(rows: unknown[] | { code: number | null; stderr: string }, jobs: Record<string, unknown> = {}) {
    const io: HarnessIO = {
      async run(_cmd, args) {
        if (args[0] !== "agents") return { code: 1, stdout: "", stderr: "unexpected" };
        if (!Array.isArray(rows)) return { code: rows.code, stdout: "", stderr: rows.stderr };
        return { code: 0, stdout: JSON.stringify(rows), stderr: "" };
      },
      async readFile(file) {
        const m = /jobs\/([0-9a-f]+)\/state\.json$/.exec(file);
        return m && Object.hasOwn(jobs, m[1]!) ? JSON.stringify(jobs[m[1]!]) : null;
      },
    };
    return createClaudeRuntime({ porch: { env, io }, wait: instant });
  }
  const rec = { id: "general-x-1234", handle: { short_id: SHORT, session_id: SID } };

  // Replaces ClaudeRuntimeParsingTests' prompt tests.
  it("builds the prompt text from waitingFor and the job file's needs", async () => {
    const rt = setup([row({ status: "waiting", waitingFor: "permission prompt" })],
      { [SHORT]: { sessionId: SID, tempo: "blocked", needs: "approve Bash: touch x" } });
    expect(await rt.status(rec)).toMatchObject({ alive: true, busy: true, prompt: "permission prompt (approve Bash: touch x)" });
  });

  it("calls a prompt with neither waitingFor nor needs a dialog", async () => {
    const rt = setup([row({ status: "waiting" })]);
    expect(await rt.status(rec)).toMatchObject({ alive: true, busy: true, prompt: "a dialog" });
  });

  // Replaces ClaudeRuntimeParsingTests' activity tests.
  it("reads activity: subagents named subagent, start times in epoch seconds, in-flight count", async () => {
    const rt = setup([row({ status: "busy" })], {
      [SHORT]: { sessionId: SID, detail: "Reviewing the diff", inFlight: { tasks: 2 },
        fan: [{ kind: "agent", label: "Explore the code", startedAt: 1_759_312_800_000 },
          { kind: "bash", label: "npm test", startedAt: 1_759_312_801_500 },
          { kind: "agent", label: "finished", startedAt: 1, doneAt: 2 }] },
    });
    const st = await rt.status(rec);
    expect(st.busy).toBe(true);
    expect(st.activity).toEqual({ detail: "Reviewing the diff", in_flight: 2, running: [
      { kind: "subagent", label: "Explore the code", since: 1_759_312_800 },
      { kind: "bash", label: "npm test", since: 1_759_312_801.5 }] });
  });

  // Replaces ClaudeRuntimeParsingTests' "unknown busy state" test.
  it("never reports a listing status it does not know as idle", async () => {
    const rt = setup([row({ status: "compacting" })]);
    expect(await rt.status(rec)).toMatchObject({ alive: true, busy: null });
    const none = setup([row({ status: null })]);
    expect((await none.status(rec)).busy).toBeNull();
  });

  it("keys listing rows by short id and session id, with the listing's kind", async () => {
    const rt = setup([row(), row({ id: null, sessionId: "99999999-0000-0000-0000-000000000000", kind: "interactive", pid: 7, name: null })]);
    const rows = await rt.listing();
    expect(rows[SHORT]).toBe(rows[SID]);
    expect(rows[SID]).toMatchObject({ id: SHORT, sessionId: SID, name: "sc-general-x-1234", kind: "background", pid: 4242, alive: true });
    expect(rows["99999999-0000-0000-0000-000000000000"]).toMatchObject({ id: null, kind: "interactive", pid: 7 });
    expect(await rt.status(rec, rows)).toMatchObject({ alive: true, busy: false, pid: 4242 });
    expect(await rt.status({ id: "x", handle: { short_id: SHORT } }, rows)).toMatchObject({ alive: true });
  });

  it("reads a session Porch does not know as not running, not found", async () => {
    const rt = setup([]);
    expect(await rt.status(rec)).toEqual({ alive: false, busy: null, pid: null, prompt: null, activity: null,
      stopped: { status: "not found", reason: null } });
    expect(await rt.statusSessionId(SID, await rt.listing())).toMatchObject({ alive: false });
  });

  it("refuses a failed listing, so the watcher skips its cycle instead of reading every session as stopped", async () => {
    const rt = setup({ code: 1, stderr: "Error: daemon not running" });
    await expect(rt.listing()).rejects.toThrow(SCError);
    await expect(rt.listing()).rejects.toThrow(/claude agents --json` failed \(exit 1\): Error: daemon not running/);
    await expect(rt.status(rec)).rejects.toThrow(SCError);
    await expect(rt.statusSessionId(SID)).rejects.toThrow(SCError);
  });

  it("refuses when claude is not on PATH, which Porch alone would read as nothing running", async () => {
    const rt = setup({ code: null, stderr: "spawn claude ENOENT" });
    await expect(rt.listing()).rejects.toThrow(new SCError("'claude' is not on PATH"));
    await expect(rt.status(rec)).rejects.toThrow(new SCError("'claude' is not on PATH"));
    await expect(rt.wake(rec, "x")).rejects.toThrow(new WakeError("'claude' is not on PATH"));
  });

  it("keeps a running session's row under its short id when Porch also remembers a stopped one with it", async () => {
    // A stopped session Porch still has a record of, sorted after the running one.
    const old = "ffffffff-0000-0000-0000-000000000000";
    const store = new RecordStore(sessionsDir(env));
    await store.updateInside("claude", old, { pid: 1, status: "idle", data: { shortId: SHORT } });
    await store.updateInside("claude", old, { status: "ended", endedAt: T1, endReason: "other" });
    const rows = await setup([row()]).listing();
    expect(rows[SHORT]).toMatchObject({ sessionId: SID, alive: true });
    expect(rows[old]).toMatchObject({ alive: false });
  });

  it("lists normally when only one session record cannot be read", async () => {
    const rt = setup([row()]);
    fs.mkdirSync(sessionsDir(env), { recursive: true });
    fs.writeFileSync(path.join(sessionsDir(env), "claude-0000.json"), "not json");
    const rows = await rt.listing();
    expect(rows[SID]).toMatchObject({ alive: true });
  });

  it("takes turn times from Porch's record for a session with Porch's hooks, and none for one without", async () => {
    const store = new RecordStore(sessionsDir(env));
    await store.updateInside("claude", SID, { pid: 4242, status: "idle", lastTurnStart: T1, lastTurnEnd: T2 });
    const rt = setup([row()]);
    expect((await rt.status(rec)).turns).toEqual({ last_prompt_at: secs(T1), last_stop_at: secs(T2) });
    expect((await rt.status(rec, await rt.listing())).turns).toEqual({ last_prompt_at: secs(T1), last_stop_at: secs(T2) });
    // A session from before the switch-over: only `sc report` wrote a record, so no inside part.
    fs.rmSync(store.recordPath("claude", SID));
    await store.setSelf("claude", SID, { status: "working", text: "x", since: T1 });
    expect((await rt.status(rec)).turns).toBeUndefined();
  });

  // 4. Pinned on purpose: looks wrong, is right.
  it("reads an ended session, whatever the reason, as not alive and nothing more", async () => {
    // `ended` also covers Claude Code stopping an idle session (endReason idle) and a SIGTERM
    // during a turn. Only rec.stopped_by_sc says sous chef stopped a session; the status
    // carries the word and the reason for event text, and nothing that decides.
    const store = new RecordStore(sessionsDir(env));
    for (const reason of ["other", "idle"]) {
      await store.updateInside("claude", SID, { pid: 4242, status: "idle" });
      await store.updateInside("claude", SID, { status: "ended", endedAt: T2, endReason: reason });
      const st = await setup([row({ pid: null })]).status(rec);
      expect(st).toEqual({ alive: false, busy: null, pid: null, prompt: null, activity: null,
        turns: { last_prompt_at: null, last_stop_at: null }, stopped: { status: "ended", reason } });
      fs.rmSync(store.recordPath("claude", SID));
    }
  });

  it("reads a session held at a prompt as busy", () => {
    // Porch's waiting-on-prompt maps to busy: the turn has not ended, so the watcher must
    // neither ring inbox wake-ups into it nor let a scheduled job wake sous chef while it is held.
    const obs = { schema: 2 as const, harness: "claude", session: SID, attached: true, status: "waiting-on-prompt" as const,
      since: null, endReason: null, detail: { pid: 1, prompt: "permission prompt", promptNeeds: null }, raw: null, self: null };
    expect(statusOf(obs)).toMatchObject({ alive: true, busy: true, prompt: "permission prompt" });
  });
});

// --- 3. Running Claude Code: launch, resume, stop, sous chef's own session ----------------

describe("running Claude Code (a stub claude on PATH)", () => {
  let stub: Stub;
  beforeEach(() => {
    stub = installStub(path.join(tmp, "bin"));
    Object.assign(process.env, env, { PATH: `${stub.dir}:${env.PATH}` });
  });
  const runtime = () => createClaudeRuntime({ wait: instant });
  const rec = (fields: Record<string, unknown> = {}) => ({
    id: "general-x-1234", kind: "general", title: "x", cwd: tmp, runtime: "claude-bg",
    handle_name: "sc-general-x-1234", permissions: "bypass", ...fields,
  });

  // Replaces ClaudeRuntimeParsingTests' short id tests.
  it("reads the short id from `backgrounded · <id> ·`, colour codes and all", () => {
    expect(parseShortId("\u001b[2mbackgrounded\u001b[0m · ab12cd34 · sc-x\n")).toBe("ab12cd34");
    expect(parseShortId("backgrounded · 0f9e · name")).toBe("0f9e");
    expect(parseShortId("Error: not logged in")).toBeNull();
  });

  // Replaces ClaudeRuntimeParsingTests' permission mapping test.
  it("maps each permission value to Claude Code's mode, refusing one it does not know", () => {
    expect(PERMISSION_MODES).toEqual({ "auto": "auto", "accept-edits": "acceptEdits", "bypass": "bypassPermissions", "ask": "manual" });
    expect(launchArgs({ handle_name: "n" }, "p", {})).toContain("auto"); // no recorded value: auto
    expect(() => launchArgs({ handle_name: "n", permissions: "yolo" }, "p", {})).toThrow(
      new SCError("the Claude runtime has no permission mode for 'yolo' (known: auto, accept-edits, bypass, ask)"));
  });

  it("launches through Porch: one --settings with sous chef's hooks and Porch's, and no old turn hooks", async () => {
    const r = rec({ own_worktree: true });
    const row = { id: SHORT, sessionId: SID, name: r.handle_name, kind: "background", cwd: tmp, pid: 4242, status: "busy" };
    stub.write({ launchOutput: `backgrounded · ${SHORT} · ${r.handle_name}`, launchRow: row });
    const handle = await runtime().launch(r, "Read your brief", { PATH: process.env.PATH! }, workerSettings(r));
    expect(handle).toEqual({ short_id: SHORT, session_id: SID });
    const launch = stub.read().calls.find((c) => c.includes("-n"))!;
    expect(launch.filter((a) => a === "--settings")).toHaveLength(1);
    expect(launch.slice(2)).toEqual(["--bg", "-n", r.handle_name, "--permission-mode", "bypassPermissions", "Read your brief"]);
    const settings = JSON.parse(launch[launch.indexOf("--settings") + 1]!) as { hooks: Record<string, { hooks: { command: string }[] }[]>; [k: string]: unknown };
    const commands = Object.fromEntries(Object.entries(settings.hooks).map(([ev, entries]) =>
      [ev, entries.flatMap((e) => e.hooks.map((h) => h.command))]));
    expect(Object.keys(commands).sort()).toEqual(["PermissionRequest", "PreToolUse", "SessionEnd", "SessionStart", "Stop",
      "StopFailure", "UserPromptSubmit"]);
    expect(commands.SessionStart![0]).toMatch(/ hook worker-start --session '?general-x-1234'?$/);
    expect(commands.PreToolUse![0]).toMatch(/ hook guard-edit --session '?general-x-1234'?$/);
    for (const ev of ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "PermissionRequest", "SessionEnd"]) {
      expect(commands[ev]!.at(-1)).toMatch(new RegExp(` hooks claude on ${ev}$`));
    }
    const all = Object.values(commands).flat().join("\n");
    expect(all).not.toMatch(/worker-prompt|worker-stop/);
    expect(settings.crossSessionInbound).toBe("accept");
    expect(settings.worktree).toEqual({ bgIsolation: "none" });
    // Node by absolute path in Porch's hooks, as in sous chef's own.
    expect(commands.Stop![0]).toContain(`'${process.execPath}' `);
  });

  // Replaces ClaudeRuntimeParsingTests' --model/--effort test.
  it("passes --model and --effort on launch", async () => {
    stub.write({ launchOutput: `backgrounded · ${SHORT} · n`,
      launchRow: { id: SHORT, sessionId: SID, name: "n", pid: 1, status: "idle" } });
    await runtime().launch(rec({ model: "haiku", effort: "low" }), "go", {}, {});
    const launch = stub.read().calls.find((c) => c.includes("-n"))!;
    expect(launch.slice(launch.indexOf("--model"), launch.indexOf("--model") + 4)).toEqual(["--model", "haiku", "--effort", "low"]);
  });

  // Replaces ClaudeRuntimeParsingTests' listing fallback test.
  it("falls back to the listing by name when the output has no short id", async () => {
    stub.write({ launchOutput: "something unexpected",
      launchRow: { id: SHORT, sessionId: SID, name: "sc-general-x-1234", pid: 1, status: "idle" } });
    expect(await runtime().launch(rec(), "go", {}, {})).toEqual({ short_id: SHORT, session_id: SID });
    stub.write({ launchOutput: "Error: not logged in" });
    await expect(runtime().launch(rec(), "go", {}, {})).rejects.toThrow(
      new SCError("claude --bg did not start the session (exit 0): Error: not logged in"));
  });

  it("takes the session id only from the listing, never from a stopped session Porch remembers by the same short id", async () => {
    const store = new RecordStore(sessionsDir(env));
    await store.updateInside("claude", "ffffffff-0000-0000-0000-000000000000", { pid: 1, status: "idle", data: { shortId: SHORT } });
    stub.write({ launchOutput: `backgrounded · ${SHORT} · n` });
    expect(await runtime().launch(rec(), "go", {}, {})).toEqual({ short_id: SHORT, session_id: null });
  });

  it("returns no session id when the session never appears", async () => {
    stub.write({ launchOutput: `backgrounded · ${SHORT} · n` });
    expect(await runtime().launch(rec(), "go", {}, {})).toEqual({ short_id: SHORT, session_id: null });
  });

  // Replaces ClaudeRuntimeParsingTests' resume test.
  it("resumes with --resume and the session id, and no other flags", async () => {
    stub.write({ resumable: { [SID]: { id: SHORT, sessionId: SID, name: "n", status: "idle" } } });
    await runtime().resume(rec({ handle: { short_id: SHORT, session_id: SID } }), {}, workerSettings(rec()));
    expect(stub.read().calls[0]).toEqual(["--bg", "--resume", SID]);
  });

  it("stops a copy a resume started instead of the session, and says so", async () => {
    stub.write({ resumeAs: { [SID]: { id: "ffff0000", sessionId: "copy-session-id", name: "n", status: "idle" } } });
    await expect(runtime().resume(rec({ handle: { short_id: SHORT, session_id: SID } }), {}, {})).rejects.toThrow(
      new SCError("resume did not bring back general-x-1234 (Claude Code started ffff0000 instead, now stopped)"));
    expect(stub.read().calls.at(-1)).toEqual(["stop", "ffff0000"]);
  });

  it("stops with claude stop and checks it stopped", async () => {
    stub.write({ agents: [{ id: SHORT, sessionId: SID, name: "n", pid: 4242, status: "idle" }] });
    await runtime().stop(rec({ handle: { short_id: SHORT, session_id: SID } }));
    expect(stub.read().calls.filter((c) => c[0] === "stop")).toEqual([["stop", SHORT]]);
  });

  // Mega-shape obligation 3: souschef starts sous chef in bypass mode, through Porch's launch plan.
  it("starts sous chef's own session in bypass mode through Porch, with only Porch's settings", async () => {
    stub.write({ launchOutput: `backgrounded · ${SHORT} · sous-chef` });
    expect(namedArgs("sous-chef", "Started", "bypass")).toEqual(["--bg", "-n", "sous-chef", "--permission-mode",
      "bypassPermissions", "Started"]);
    expect(await runtime().startNamed("sous-chef", "Started by the souschef command.", tmp, { ...process.env } as Record<string, string>,
      "bypass")).toBe(SHORT);
    const call = stub.read().calls[0]!;
    expect(call.slice(2)).toEqual(["--bg", "-n", "sous-chef", "--permission-mode", "bypassPermissions",
      "Started by the souschef command."]);
    const settings = JSON.parse(call[1]!) as { hooks: Record<string, { hooks: { command: string }[] }[]>; crossSessionInbound: string };
    expect(Object.keys(settings.hooks).sort()).toEqual(["PermissionRequest", "SessionEnd", "SessionStart", "Stop",
      "StopFailure", "UserPromptSubmit"]);
    expect(Object.values(settings.hooks).flat().flatMap((e) => e.hooks).every((h) => / hooks claude on /.test(h.command))).toBe(true);
    expect(settings.crossSessionInbound).toBe("accept");
  });

  it("resumes sous chef's own session by id with no other flags, and returns its short id once listed", async () => {
    stub.write({ resumable: { [SID]: { id: SHORT, sessionId: SID, name: "sous-chef", kind: "background", status: "idle" } } });
    expect(await runtime().resumeSessionId(SID, tmp, { ...process.env } as Record<string, string>)).toBe(SHORT);
    expect(stub.read().calls[0]).toEqual(["--bg", "--resume", SID]);
    // Not found by Porch: the resume failed, nothing to stop.
    stub.write({});
    expect(await runtime().resumeSessionId(SID, tmp, { ...process.env } as Record<string, string>)).toBeNull();
    // A copy came back instead: it is stopped.
    stub.write({ resumeAs: { [SID]: { id: "ffff0000", sessionId: "copy-session-id", name: "sous-chef", status: "idle" } } });
    expect(await runtime().resumeSessionId(SID, tmp, { ...process.env } as Record<string, string>)).toBeNull();
    expect(stub.read().calls.at(-1)).toEqual(["stop", "ffff0000"]);
  });

  it("reads a stopped sous chef as not running in the listing (souschef then resumes it)", async () => {
    stub.write({ agents: [{ id: SHORT, sessionId: SID, name: "sous-chef", kind: "background", status: "idle" }] });
    const rows = await runtime().listing();
    expect(rows[SID]).toMatchObject({ pid: null, kind: "background", alive: false });
  });

  it("attaches with claude attach and returns its exit code", async () => {
    const cwd = process.cwd();
    try {
      expect(await runtime().attachExec(SHORT, tmp, { ...process.env } as Record<string, string>)).toBe(0);
    } finally {
      process.chdir(cwd);
    }
    expect(stub.read().calls).toEqual([["attach", SHORT]]);
  });
});
