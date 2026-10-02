// Behaviour tests for sous chef's context check, run against the real command line with the fake runtime.
//
// sous chef's Stop hook: how full its context is, read from its transcript (src/context.ts).
//
// The fixtures copy the shape of real transcript lines: one JSON object per line,
// assistant lines carrying message.usage.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Out, read, readJson, ScTest, write } from "./helpers.js";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** json.dumps with Python's default separators (", " and ": "), so transcript lines have the size they had. */
function pyDumps(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(pyDumps).join(", ")}]`;
  if (typeof v === "object") {
    return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${JSON.stringify(k)}: ${pyDumps(x)}`).join(", ")}}`;
  }
  return JSON.stringify(v);
}

describe("ContextCheckTests", () => {
  let t: ScTest;
  let transcript: string;

  beforeEach(async () => {
    t = new ScTest();
    await t.registerChef();
    chef({ alive: true, busy: false });
    transcript = path.join(t.tmp, "chef-1.jsonl");
    fs.writeFileSync(transcript, line("user", { text: "hello" }));
  });
  afterEach(() => t.cleanup());

  function chef(fields: Record<string, unknown>): void {
    const file = path.join(t.home, "state", "fake-runtime.json");
    const data = fs.existsSync(file) ? readJson(file) : { sessions: {}, wakes: [] };
    data.sessions["chef-1"] = { ...(data.sessions["chef-1"] ?? {}), ...fields };
    write(file, JSON.stringify(data));
  }

  function line(kind = "assistant", o: { tokens?: number; model?: string; usage?: Json; [k: string]: unknown } = {}): string {
    const { tokens, model = "claude-opus-5", usage, ...extra } = o;
    const d: Json = { type: kind, uuid: "u", timestamp: "2026-09-21T10:00:00.000Z", ...extra };
    if (kind === "assistant") {
      const u = usage !== undefined && usage !== null ? usage : { input_tokens: 2, cache_creation_input_tokens: 100,
        cache_read_input_tokens: tokens! - 102, output_tokens: 50 };
      d.message = { model, role: "assistant", usage: u };
    } else if (kind === "user") {
      const text = "text" in extra ? extra.text : "hi";
      delete extra.text;
      d.message = { role: "user", content: text };
    }
    return pyDumps(d) + "\n";
  }

  /** Append an assistant line, then run the Stop hook as Claude Code would. */
  async function turn(tokens?: number, kw: { model?: string; usage?: Json } = {}): Promise<Out> {
    fs.appendFileSync(transcript, line("assistant", { tokens, ...kw }));
    return stop();
  }

  async function stop(payload?: Json): Promise<Out> {
    payload = payload || { session_id: "chef-1", transcript_path: transcript, hook_event_name: "Stop" };
    const out = await t.sc(["hook", "chef-stop"], { stdin: pyDumps(payload) });
    expect(out.stdout, "a Stop hook's output can keep the turn going; it must print nothing").toBe("");
    return out;
  }

  async function turnOn(...extra: string[]): Promise<void> {
    await t.sc(["context", "set", "--warn-at", "70", "--window", "claude-opus-5=1000", ...extra]);
  }

  function log(): Json[] {
    const file = path.join(t.home, "state", "context", "events.jsonl");
    return fs.existsSync(file) ? read(file).split("\n").filter((x, i, a) => !(i === a.length - 1 && x === "")).map((x) => JSON.parse(x)) : [];
  }

  function chefWakes(): string[] {
    return (t.fakeState().wakes as Json[]).filter((w) => w[0] === "chef").map((w) => w[1]);
  }

  it("over the threshold leaves one warning with numbers and what to do", async () => {
    await turnOn();
    await turn(712);
    const entries = log();
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.state).toBe("context-high");
    expect(e.text).toContain("71.2%");
    expect(e.text).toContain("712 of 1,000 tokens");
    expect(e.text).toContain("memory/focus.md");
    const out = (await t.sc(["events"])).stdout;
    expect(out).toContain("[context]");
    expect(out).toContain("context:1");
    expect((await t.sc(["summary"])).stdout).toContain("Unread events needing attention: 1");
  });

  it("a warning does not wake sous chef now or from the watcher", async () => {
    await turnOn();
    await turn(800);
    await t.sc(["watch", "--once"]);
    t.clock += 7200;
    await t.sc(["watch", "--once"]);
    expect(chefWakes()).toEqual([]);
    expect(log().length).toBe(1);
  });

  it("under the threshold says nothing but records the reading", async () => {
    await turnOn();
    await turn(650);
    expect(log()).toEqual([]);
    const out = (await t.sc(["context"])).stdout;
    expect(out).toContain("Last reading: 65.0% (650 of 1,000 tokens");
    expect(out).toContain("ON: warns at 70.0%");
  });

  it("crossing then staying over warns once until it falls back", async () => {
    await turnOn();
    for (const tokens of [690, 720, 760, 690, 740, 900]) { // 690 is above the re-arm level of 60%
      await turn(tokens);
    }
    expect(log().map((e) => e.state)).toEqual(["context-high"]);
    await turn(300); // compacted
    await turn(710);
    expect(log().map((e) => e.state)).toEqual(["context-high", "context-high"]);
  });

  it("a compaction rearms the warning", async () => {
    await turnOn();
    await turn(750);
    fs.appendFileSync(transcript, pyDumps({ type: "system", subtype: "compact_boundary",
      compactMetadata: { trigger: "auto", preTokens: 750 } }) + "\n");
    await stop();
    expect((await t.sc(["context"])).stdout).toContain("compacted");
    await turn(720);
    expect(log().length).toBe(2);
  });

  it("a missing transcript is reported once and its recovery once", async () => {
    await turnOn();
    const missing = { session_id: "chef-1", transcript_path: transcript + ".gone" };
    await stop(missing);
    await stop(missing);
    const entries = log();
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.state).toBe("context-unreadable");
    expect(e.text).toContain("transcript not found");
    expect(e.text).toContain("nothing warns you");
    const out = (await t.sc(["context"])).stdout;
    expect(out).toContain("FAILING");
    expect(out).toContain("2 check(s) in a row");
    expect((await t.sc(["summary"])).stdout).toContain("FAILING");
    await turn(500);
    expect(log().map((x) => x.state)).toEqual(["context-unreadable", "context-readable"]);
    expect((await t.sc(["context"])).stdout).not.toContain("FAILING");
  });

  it("last lines without usage are a failure not a quiet reading", async () => {
    await turnOn();
    fs.appendFileSync(transcript, line("user", { text: "more" }).repeat(20));
    await stop();
    const entries = log();
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.state).toBe("context-unreadable");
    expect(e.text).toContain("no assistant turn with usage");
  });

  it("a changed usage shape is a failure and an older reading is not used", async () => {
    await turnOn();
    await turn(900); // warned; an older, readable line is now in the file
    await turn(undefined, { usage: { prompt_tokens: 950, completion_tokens: 10 } });
    const states = log().map((e) => e.state);
    expect(states).toEqual(["context-high", "context-unreadable"]);
    expect(log().at(-1).text).toContain("lacks input_tokens, cache_creation_input_tokens, cache_read_input_tokens");
    fs.appendFileSync(transcript, pyDumps({ type: "assistant", message: { model: "claude-opus-5" } }) + "\n");
    await stop();
    expect((await t.sc(["context"])).stdout).toContain("no `usage` block");
  });

  it("synthetic subagent and half written lines are skipped", async () => {
    await turnOn();
    fs.appendFileSync(transcript, line("assistant", { tokens: 750 }));
    fs.appendFileSync(transcript, line("assistant", { model: "<synthetic>",
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } }));
    fs.appendFileSync(transcript, line("assistant", { tokens: 10, isSidechain: true }));
    fs.appendFileSync(transcript, '{"type": "assistant", "message": {"usa');
    await stop();
    expect(log().map((e) => e.state)).toEqual(["context-high"]);
    expect(log()[0].text).toContain("75.0%");
  });

  it("the reader finds a line across chunk boundaries in a large file", async () => {
    let text = line("assistant", { tokens: 640 });
    for (let i = 0; i < 60; i++) { // about 3 MB of tool output after it, as a long turn writes
      text += line("user", { text: "x".repeat(50_000) });
    }
    fs.appendFileSync(transcript, text);
    const out = (await t.sc(["context", "check", "--transcript", transcript])).stdout;
    expect(out).toContain("context: 640 tokens");
  });

  it("a model with no window set is a failure", async () => {
    await turnOn();
    await turn(500, { model: "claude-sonnet-5" });
    const entries = log();
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toContain("no window size is set for model claude-sonnet-5");
  });

  it("off by default records readings but writes no events", async () => {
    expect((await t.sc(["context"])).stdout).toContain("OFF");
    expect((await t.sc(["context"])).stdout).toContain("Last check: never");
    await stop({ session_id: "chef-1", transcript_path: transcript + ".gone" });
    await t.sc(["context", "set", "--window", "claude-opus-5=1k"]);
    await turn(990);
    expect(log()).toEqual([]);
    expect((await t.sc(["context"])).stdout).toContain("Last reading: 99.0%");
    await t.sc(["context", "set", "--warn-at", "70"]);
    await t.sc(["context", "off"]);
    expect((await t.sc(["context"])).stdout).toContain("OFF");
    expect(readJson(path.join(t.home, "context.json"))).toEqual({ windows: { "claude-opus-5": 1000 } });
  });

  it("only the registered sous chef is checked", async () => {
    await turnOn();
    fs.appendFileSync(transcript, line("assistant", { tokens: 900 }));
    await stop({ session_id: "someone-else", transcript_path: transcript });
    expect(log()).toEqual([]);
    expect(fs.existsSync(path.join(t.home, "state", "context", "state.json"))).toBe(false);
  });

  it("the transcript is found by session id without a path", async () => {
    await turnOn();
    const fakeHome = path.join(t.tmp, "userhome");
    const proj = path.join(fakeHome, ".claude", "projects", "-some-project");
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, "chef-1.jsonl"), line("assistant", { tokens: 720 }));
    await t.sc(["hook", "chef-stop"], { stdin: pyDumps({ session_id: "chef-1" }), env: { HOME: fakeHome } });
    expect(log().map((e) => e.state)).toEqual(["context-high"]);
  });

  it("a broken config is reported not ignored", async () => {
    fs.writeFileSync(path.join(t.home, "context.json"), "{not json");
    await turn(500);
    const entries = log();
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.state).toBe("context-unreadable");
    expect(e.text).toContain("not valid JSON");
  });

  it("bad settings are refused", async () => {
    expect((await t.sc(["context", "set", "--warn-at", "120"], { ok: false })).stderr).toContain("between 0 and 100");
    expect((await t.sc(["context", "set", "--warn-at", "70", "--rearm-below", "80"],
      { ok: false })).stderr).toContain("must be below");
    expect((await t.sc(["context", "set", "--window", "nope"], { ok: false })).stderr).toContain("MODEL=TOKENS");
    expect(fs.existsSync(path.join(t.home, "context.json"))).toBe(false);
  });

  it("acknowledging the context log", async () => {
    await turnOn();
    await turn(800);
    expect((await t.sc(["events", "ack", "context:1"])).stdout).toContain("acknowledged: context");
    expect((await t.sc(["events"])).stdout).toContain("No unread events");
  });
});
