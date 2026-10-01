// The watcher with the Claude runtime on Porch: one watcher cycle (watch.cycle) run in this
// process, against a stub `claude` (tests/claude-stub.ts) and Porch records in a temporary
// PORCH_HOME. Never touches a real session.
//
// Pinned on purpose (looks wrong, is right): Porch shows a session that ended cleanly as
// `ended`, which is also what a session sous chef stopped looks like. The watcher never
// reads `ended` as "sous chef stopped it": only the record's stopped_by_sc says that, so
// an ended session sous chef did not stop is resumed or reported like a `gone` one
// (auto-resume keeps decision 0017's rule; narrowing it to idle stops is a later change).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RecordStore, sessionsDir } from "@dylankuhlenthal/porch";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { main as cli } from "../src/cli.js";
import * as events from "../src/events.js";
import * as ops from "../src/ops.js";
import * as records from "../src/records.js";
import { now, writeJson } from "../src/util.js";
import { cycle } from "../src/watch.js";
import { installStub, type Stub } from "./claude-stub.js";

const SID = "11111111-2222-3333-4444-555555555555";
const SHORT = "ab12cd34";
const T = "2026-10-01T10:00:00.000Z";
const SAVED_ENV = { ...process.env };
let tmp: string;
let stub: Stub;
let store: RecordStore;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "watch-porch-")));
  stub = installStub(path.join(tmp, "bin"));
  // Set once: the runtime makes its one Porch from this environment on first use.
  Object.assign(process.env, {
    HOME: tmp, CLAUDE_CONFIG_DIR: path.join(tmp, "claude"), PORCH_HOME: path.join(tmp, "porch"),
    PATH: `${stub.dir}:${process.env.PATH ?? ""}`, SC_TEST_HOME: path.join(tmp, "home"),
    SC_GONE_GRACE: "0", SC_WATCH_DISABLE_ENSURE: "1",
  });
  // Never a real claude: the stub must be the one found.
  expect(execFileSync("/bin/sh", ["-c", "command -v claude"], { encoding: "utf8" }).trim()).toBe(path.join(stub.dir, "claude"));
  store = new RecordStore(sessionsDir(process.env));
});

afterAll(() => {
  process.env = { ...SAVED_ENV };
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  for (const dir of ["home", "porch"]) fs.rmSync(path.join(tmp, dir), { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, "home", "state", "sessions"), { recursive: true });
  stub.write({ resumable: { [SID]: { id: SHORT, sessionId: SID, name: "sc-general-x", kind: "background", status: "idle" } } });
});

async function session(fields: Record<string, unknown>, waitingOn: string | null) {
  const rec = { id: "general-x-1234", kind: "general", title: "x", cwd: tmp, runtime: "claude-bg",
    handle_name: "sc-general-x", handle: { short_id: SHORT, session_id: SID }, ...fields } as records.Rec;
  records.save(rec);
  await events.append(rec.id, "sc", "launched", "launched");
  if (waitingOn) await events.append(rec.id, "sc", "marked", "waiting", null, waitingOn);
}

/** Porch's record for a session that ended (SessionEnd ran, or Porch read an idle stop). */
async function ended(reason: string) {
  // pid 999: the resumed process (the stub gives 4242) is a later one, as after a real resume.
  await store.updateInside("claude", SID, { pid: 999, status: "idle", lastTurnEnd: T, data: { shortId: SHORT } });
  await store.updateInside("claude", SID, { status: "ended", endedAt: T, endReason: reason });
}

const states = () => events.readAll("general-x-1234").map((e) => e.state);
const resumed = () => stub.read().calls.some((c) => c.includes("--resume"));

describe("the watcher on Porch", () => {
  it("resumes an ended session sous chef did not stop, as it does a gone one", async () => {
    await session({}, "owner");
    await ended("idle");
    await cycle();
    expect(resumed()).toBe(true);
    expect(states()).toContain("auto-resumed");
    expect(states()).not.toContain("gone");
  });

  it("treats ended with reason other (claude stop run by someone else) the same way", async () => {
    await session({}, "owner");
    await ended("other");
    await cycle();
    expect(states()).toContain("auto-resumed");
  });

  it("leaves alone an ended session sous chef stopped (stopped_by_sc), and only for that reason", async () => {
    await session({ stopped_by_sc: true }, "owner");
    await ended("other");
    await cycle();
    expect(resumed()).toBe(false);
    expect(states()).toEqual(["launched", "marked"]);
  });

  it("says what Porch reported in the gone event of a session it does not resume", async () => {
    await session({}, null); // waiting on the agent: not resumed, reported
    await ended("idle");
    await cycle();
    expect(resumed()).toBe(false);
    const gone = events.readAll("general-x-1234").find((e) => e.state === "gone")!;
    expect(gone.text).toMatch(/^the session has not been running for \d+s, and sous chef did not stop it\. Porch reports it as ended \(idle\)\. Check `sc status general-x-1234` first/);
  });

  it("says not found for a session Porch does not know (started before the switch-over and long stopped)", async () => {
    await session({}, null);
    await cycle();
    const gone = events.readAll("general-x-1234").find((e) => e.state === "gone")!;
    expect(gone.text).toContain("did not stop it. Porch reports it as not found. Check");
  });
});

// Turn times: a session launched through Porch has them in Porch's record and no
// turns.json; one launched before has only turns.json. The watcher and `sc status` use
// the runtime's when it has them (decision 10 of the TypeScript rewrite).
describe("turn times on Porch", () => {
  const iso = (secondsAgo: number) => new Date((now() - secondsAgo) * 1000).toISOString();

  async function idleWithPorchTurns() {
    await session({}, null); // waiting on the agent
    stub.write({ agents: [{ id: SHORT, sessionId: SID, name: "sc-general-x", kind: "background", pid: 4242, status: "idle" }] });
    await store.updateInside("claude", SID, { pid: 4242, status: "idle", lastTurnStart: iso(3 * 3600), lastTurnEnd: iso(3 * 3600 - 5),
      data: { shortId: SHORT } });
    // A turns.json that would say a turn has just started, so it must not be the one read.
    writeJson(path.join(records.sessionDir("general-x-1234"), "turns.json"), { last_prompt_at: now() });
  }

  it("reports a silent stop from Porch's turn times, not turns.json", async () => {
    await idleWithPorchTurns();
    await cycle();
    expect(states()).toContain("silent-stop");
  });

  it("shows Porch's turn times in sc status", async () => {
    await idleWithPorchTurns();
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (out.push(String(chunk)), true));
    try {
      expect(await cli(["status", "general-x-1234"])).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const text = out.join("");
    expect(text).toContain("  last prompt at: 3h ago\n");
    expect(text).toContain("  last stop at: 2h ago\n");
  });
});

describe("sc report on Porch", () => {
  it("sets the session's Porch self status after writing the event", async () => {
    await session({}, null);
    process.env.CLAUDE_CODE_SESSION_ID = SID;
    try {
      await ops.report("needs-decision", "A or B?");
    } finally {
      delete process.env.CLAUDE_CODE_SESSION_ID;
    }
    expect(states()).toContain("needs-decision");
    expect((await store.read("claude", SID))?.self).toMatchObject({ status: "needs-input", text: "A or B?" });
  });

  it("prints one line and changes nothing else when Porch cannot set it", async () => {
    await session({}, null);
    // Two harnesses claim the process, so Porch refuses to guess which session it is.
    Object.assign(process.env, { CLAUDE_CODE_SESSION_ID: SID, PI_SESSION_ID: "pi-session" });
    const err: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (err.push(String(chunk)), true));
    try {
      const event = await ops.report("working", "busy with it");
      expect(event.state).toBe("working");
    } finally {
      spy.mockRestore();
      delete process.env.CLAUDE_CODE_SESSION_ID;
      delete process.env.PI_SESSION_ID;
    }
    expect(states()).toContain("working");
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^porch status not updated: this process looks like it runs in more than one session/);
    expect(await store.read("claude", SID)).toBeNull();
  });
});
