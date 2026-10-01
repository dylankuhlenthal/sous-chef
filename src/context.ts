// How full sous chef's context is, and a warning before compaction.
//
// Claude Code compacts a long conversation on its own, and nothing outside the
// conversation can trigger or delay that. What sous chef can do is make sure its
// working state is in memory/ first. So sous chef's Stop hook (`sc hook chef-stop`)
// reads how full the context is at the end of every turn and, past a configured
// level, leaves a warning in the context log for sous chef to act on.
//
// Where the number comes from: Claude Code's session transcript
// (~/.claude/projects/<project>/<session id>.jsonl). Every assistant line carries
// the API `usage` of the call that produced it, and the prompt that call sent is
// the context: input_tokens + cache_creation_input_tokens + cache_read_input_tokens.
// The format is undocumented, so every way reading it can go wrong is reported as a
// failure (ReadError) and never as a low reading.
//
// Files:
//   context.json                 configuration (tracked in git), written by `sc context set`
//   state/context/state.json     the last reading, whether a warning is armed, a failure streak
//   state/context/events.jsonl   the context log (events.CONTEXT_LOG), read with `sc events`
//
// Percentages set with `sc context set` are floats, as Python's argparse made them, and
// are printed that way ("70.0%").

import fs from "node:fs";
import path from "node:path";
import * as chef from "./chef.js";
import * as events from "./events.js";
import { withLock } from "./lock.js";
import { JSONDecodeError, loads } from "./pyjson.js";
import {
  commas, Dict, expanduser, fixed, floatRepr, get, isDict, isFile, listDir, or, parseFloatPy, pathStr, rpartition,
  sorted, strip, truthy,
} from "./py.js";
import { age, home, now, readJson, SCError, stateDir, writeJson } from "./util.js";

const USAGE_FIELDS = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];
const CHUNK = 1 << 20; // read the transcript backwards a megabyte at a time
const MAX_SCAN = 32 << 20; // and give up, loudly, after this much without a usable line
const REARM_GAP = 10; // default: warn again only after usage fell this many points below warn_at

/** The transcript could not tell us how full the context is. The message says why. */
export class ReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadError";
  }
}

export interface Reading extends Dict {
  compacted?: boolean;
  tokens?: number;
  model?: string;
  parts?: Record<string, number>;
  timestamp?: unknown;
  pre_tokens?: unknown;
  window?: number;
  percent?: number;
}

// --- reading the transcript --------------------------------------------------

/** bytes.strip() leaves nothing: only ASCII whitespace. */
function blank(buf: Buffer): boolean {
  return buf.every((b) => b === 0x20 || (b >= 0x09 && b <= 0x0d));
}

/** [line, bytes scanned] from the end of the file backwards, without reading all of it. */
function* linesFromEnd(p: string, maxScan: number): Generator<[Buffer, number]> {
  const fd = fs.openSync(p, "r");
  try {
    let pos = fs.fstatSync(fd).size;
    let tail = Buffer.alloc(0);
    let scanned = 0;
    while (pos > 0 && scanned < maxScan) {
      const step = Math.min(CHUNK, pos);
      pos -= step;
      const chunk = Buffer.alloc(step);
      fs.readSync(fd, chunk, 0, step, pos);
      const buf = Buffer.concat([chunk, tail]);
      scanned += step;
      const lines: Buffer[] = [];
      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a) {
          lines.push(buf.subarray(start, i));
          start = i + 1;
        }
      }
      lines.push(buf.subarray(start));
      tail = Buffer.from(lines[0]!); // may be the second half of a line that starts in the next chunk back
      for (let i = lines.length - 1; i >= 1; i--) {
        if (!blank(lines[i]!)) yield [lines[i]!, scanned];
      }
    }
    if (pos === 0 && !blank(tail)) yield [tail, scanned];
  } finally {
    fs.closeSync(fd);
  }
}

function isInt(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v);
}

/**
 * The context size at sous chef's most recent assistant turn, read from the end of its transcript.
 *
 * Returns {tokens, model, parts: {field: n}, timestamp}, or {compacted: true, ...}
 * when the newest thing in the transcript is a compaction with no turn since. Throws
 * ReadError, naming what was wrong, when it cannot give a number it trusts:
 * - the file is missing or unreadable;
 * - the newest real assistant line has no usage, or usage without the three fields
 *   (the format changed): an older line is not used instead, because its number is stale;
 * - no assistant line at all in the part of the file it read.
 *
 * Skipped, because they are not the main conversation's context: lines that are not
 * JSON (a line being written as we read), subagent lines (isSidechain), and messages
 * Claude Code makes up itself (model "<synthetic>", with all-zero usage), such as API
 * error notices.
 */
export function readUsage(p: string, maxScan = MAX_SCAN): Reading {
  if (!isFile(p)) throw new ReadError(`transcript not found at ${p}`);
  let scanned = 0;
  try {
    for (const [raw, n] of linesFromEnd(p, maxScan)) {
      scanned = n;
      let d: unknown;
      try {
        d = loads(raw.toString("utf8"));
      } catch (e) {
        if (e instanceof JSONDecodeError) continue;
        throw e;
      }
      if (!isDict(d)) continue;
      if (d.type === "system" && d.subtype === "compact_boundary") {
        return { compacted: true, timestamp: get(d, "timestamp", null),
          pre_tokens: get(or(d.compactMetadata, {}), "preTokens", null) };
      }
      if (d.type !== "assistant" || truthy(d.isSidechain)) continue;
      const msg = d.message;
      if (!isDict(msg)) {
        throw new ReadError("the newest assistant line has no `message` object; the transcript " +
          "format may have changed");
      }
      if (msg.model === "<synthetic>") continue;
      const usage = msg.usage;
      if (!isDict(usage)) {
        throw new ReadError("the newest assistant message has no `usage` block; the transcript " +
          "format may have changed");
      }
      const missing = USAGE_FIELDS.filter((f) => !isInt(usage[f]));
      if (missing.length) {
        throw new ReadError(`the newest assistant usage block lacks ${missing.join(", ")}; the ` +
          `transcript format may have changed (fields present: ${sorted(Object.keys(usage)).join(", ") || "none"})`);
      }
      const parts: Record<string, number> = {};
      for (const f of USAGE_FIELDS) parts[f] = usage[f] as number;
      return { tokens: Object.values(parts).reduce((a, b) => a + b, 0), model: get(msg, "model", null) as unknown as string,
        parts, timestamp: get(d, "timestamp", null) };
    }
  } catch (e) {
    if (e instanceof ReadError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    if (code) throw new ReadError(`could not read the transcript at ${p}: ${(e as Error).message}`);
    throw e;
  }
  throw new ReadError(`no assistant turn with usage in the last ${commas(scanned)} bytes of ${p}`);
}

/**
 * The transcript for a Claude session: the path the hook payload gives, else found by session id.
 *
 * Claude Code documents `transcript_path` in hook payloads. Without it, the file is
 * looked for as ~/.claude/projects/STAR/<session id>.jsonl, which avoids depending on
 * how Claude Code turns a folder into a project name.
 */
export function findTranscript(sessionId: string, hinted: string | null = null): string {
  if (hinted) return pathStr(expanduser(hinted));
  const projects = path.join(expanduser("~"), ".claude", "projects");
  const found = listDir(projects).map((d) => path.join(projects, d, `${sessionId}.jsonl`)).filter((p) => {
    try {
      fs.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  });
  if (!found.length) {
    throw new ReadError(`no transcript for session ${sessionId} under ~/.claude/projects, and the ` +
      "hook payload gave no transcript_path");
  }
  return found[0]!;
}

// --- configuration -------------------------------------------------------------

export function configPath(): string {
  return path.join(home(), "context.json");
}

export function config(): Dict {
  let data: unknown;
  try {
    data = or(readJson(configPath(), {}), {});
  } catch (e) {
    if (e instanceof JSONDecodeError) throw new SCError(`${configPath()} is not valid JSON: ${e.message}`);
    throw e;
  }
  return isDict(data) ? data : {};
}

/** A percentage from context.json, printed as Python printed the float argparse made. */
function pct(n: unknown): string {
  return typeof n === "number" ? floatRepr(n) : String(n);
}

export function rearmBelow(cfg: Dict): number | null {
  const warnAt = get<number | null>(cfg, "warn_at", null);
  if (warnAt === null) return null;
  return get<number>(cfg, "rearm_below", Math.max(0, warnAt - REARM_GAP));
}

/** Change context.json. Percentages are of the window; windows map a model to its size in tokens. */
export function setConfig(warnAt: number | null, rearm: number | null, windows: Record<string, number>,
                          off = false): Dict {
  const cfg = config();
  if (off) {
    delete cfg.warn_at;
    delete cfg.rearm_below;
  }
  if (warnAt !== null) cfg.warn_at = warnAt;
  if (rearm !== null) cfg.rearm_below = rearm;
  for (const [model, size] of Object.entries(windows)) {
    if (!isDict(cfg.windows)) cfg.windows = {};
    (cfg.windows as Dict)[model] = size;
  }
  const w = get<number | null>(cfg, "warn_at", null);
  if (w !== null && !(0 < w && w < 100)) {
    throw new SCError("--warn-at is a percentage of the window, between 0 and 100");
  }
  if (w !== null && !(0 <= rearmBelow(cfg)! && rearmBelow(cfg)! < w)) {
    throw new SCError(`--rearm-below must be below --warn-at (${pct(w)}%)`);
  }
  if (w === null && Object.hasOwn(cfg, "rearm_below")) throw new SCError("--rearm-below needs --warn-at");
  writeJson(configPath(), cfg);
  return cfg;
}

export function parseWindow(text: string): [string, number] {
  const [model, , rawSize] = rpartition(text, "=");
  const size = strip(rawSize).toLowerCase().replace(/,/g, "").replace(/_/g, "");
  const mults: Record<string, number> = { k: 1_000, m: 1_000_000 };
  const mult = mults[size.slice(-1)] ?? 1;
  const f = parseFloatPy(mult > 1 ? size.slice(0, -1) : size);
  const n = f === null || !Number.isFinite(f) ? 0 : Math.trunc(f * mult);
  if (!model || n <= 0) {
    throw new SCError(`'${text}' is not MODEL=TOKENS, e.g. claude-opus-5=1000000 or claude-opus-5=1m`);
  }
  return [strip(model), n];
}

// --- the hook ------------------------------------------------------------------

function statePath(): string {
  return path.join(stateDir(), "context", "state.json");
}

export function state(): Dict {
  return or(readJson<Dict>(statePath(), {}), {}) as Dict;
}

function percentText(n: number): string {
  return `${fixed(n, 1)}%`;
}

/**
 * Read how full the context is and turn that into at most one event. Returns the reading.
 *
 * Throws ReadError when the number cannot be trusted; `onStop` records that.
 */
export function check(_sessionId: string, transcript: string): Reading {
  const cfg = config();
  const reading = readUsage(transcript);
  if (reading.compacted) return reading;
  const size = get<number | null>(or(cfg.windows, {}), reading.model as string, null);
  if (!truthy(size)) {
    throw new ReadError(`no window size is set for model ${reading.model} ` +
      `(\`sc context set --window ${reading.model}=TOKENS\`)`);
  }
  if (reading.tokens! > size!) {
    throw new ReadError(`${commas(reading.tokens!)} tokens is more than the ${commas(size!)}-token window set for ` +
      `${reading.model}, so that window is wrong`);
  }
  reading.window = size!;
  reading.percent = (100.0 * reading.tokens!) / size!;
  return reading;
}

/**
 * sous chef's Stop hook. Never throws for anything expected: failures are recorded, loudly.
 *
 * Hysteresis: one warning per crossing. After a warning nothing more is said until
 * usage falls below `rearm_below` (by default 10 points under `warn_at`), which in
 * practice is the compaction itself, or a new sous chef session starts.
 *
 * A failure to read is reported once per streak (a `context-unreadable` event), and
 * its end once (`context-readable`), so a broken reader cannot pass for a quiet one.
 * With no `warn_at` set the check is off: it still records its reading for
 * `sc context`, but writes no events.
 */
export async function onStop(data: Dict): Promise<void> {
  const sessionId = get<string | null>(data, "session_id", null);
  const held = get<string | null>(or(chef.current(), {}), "session_id", null);
  if (!held) return;
  if (sessionId && sessionId !== held) return; // not sous chef: a session the owner opened here by hand, say
  await withLock(path.join(stateDir(), "context", ".state.lock"), async () => {
    let st = state();
    if (st.session_id !== held) st = { session_id: held, armed: true };
    st.checked_at = now();
    let cfg: Dict;
    try {
      cfg = config();
    } catch (e) {
      if (!(e instanceof SCError)) throw e;
      // Someone set it up, so it is meant to be on: say so rather than go quiet.
      await failed(st, e.message, { warn_at: 0 });
      writeJson(statePath(), st);
      return;
    }
    try {
      if (!sessionId) throw new ReadError("the Stop hook payload has no session_id");
      const reading = check(sessionId, findTranscript(sessionId, get<string | null>(data, "transcript_path", null)));
      await read(st, reading, cfg);
    } catch (e) {
      if (e instanceof ReadError) await failed(st, e.message, cfg);
      else await failed(st, `the check itself failed (${(e as Error).name ?? "Error"}: ${(e as Error).message ?? e})`,
        cfg);
    }
    writeJson(statePath(), st);
  });
}

async function failed(st: Dict, reason: string, cfg: Dict): Promise<void> {
  const fail = (or(st.failing, { since: now(), count: 0 })) as Dict;
  fail.count = (fail.count as number) + 1;
  fail.reason = reason;
  if (get(cfg, "warn_at", null) !== null && !truthy(fail.reported)) {
    await events.append(events.CONTEXT_LOG, "context", "context-unreadable",
      `The context check could not read how full your context is: ${reason}. Until this is ` +
      "fixed nothing warns you before compaction, so keep memory/ current as you go. " +
      "`sc context` shows the details. This is not repeated until a read works again.");
    fail.reported = true;
  }
  st.failing = fail;
}

async function read(st: Dict, reading: Reading, cfg: Dict): Promise<void> {
  const fail = st.failing as Dict | undefined;
  delete st.failing;
  if (reading.compacted) {
    st.armed = true;
    st.last = { ...reading, at: now() };
    return;
  }
  st.last = { ...reading, at: now() };
  const warnAt = get<number | null>(cfg, "warn_at", null);
  if (warnAt === null) return;
  const p = reading.percent!;
  if (fail && truthy(fail.reported)) {
    await events.append(events.CONTEXT_LOG, "context", "context-readable",
      `The context check can read usage again (${percentText(p)} of the window); warnings are back on.`);
  }
  if (p >= warnAt && truthy(get(st, "armed", true))) {
    await events.append(events.CONTEXT_LOG, "context", "context-high",
      `Your context is at ${percentText(p)} (${commas(reading.tokens!)} of ${commas(reading.window!)} tokens ` +
      `for ${reading.model}), past the warning level of ${pct(warnAt)}%. Claude Code will ` +
      "compact this conversation before long. Before it does: write anything you are " +
      "holding that is not in memory/ yet (decisions, findings, what sessions are doing " +
      "and why) into the right memory file, and bring memory/focus.md up to date. Then " +
      "acknowledge this event. No further warning until usage falls below " +
      `${pct(rearmBelow(cfg))}%, which normally means after the compaction.`);
    st.armed = false;
  } else if (p < rearmBelow(cfg)!) {
    st.armed = true;
  }
}

// --- what `sc context` and the summary show ------------------------------------

/** What the check is set to and what it last saw, for `sc context` and the startup summary. */
export function statusLines(): string[] {
  let cfg: Dict;
  try {
    cfg = config();
  } catch (e) {
    if (e instanceof SCError) return [`BROKEN: ${e.message}`];
    throw e;
  }
  const st = state();
  const windowsDict = or(cfg.windows, {}) as Record<string, number>;
  const windows = sorted(Object.keys(windowsDict)).map((m) => `${m} = ${commas(windowsDict[m]!)} tokens`).join(", ")
    || "none set";
  const lines = get(cfg, "warn_at", null) === null
    ? ["OFF: no warning level set (`sc context set --warn-at N`)."]
    : [`ON: warns at ${pct(cfg.warn_at)}% of the window, again only after falling below ${pct(rearmBelow(cfg))}%.`];
  lines.push(`Windows: ${windows}.`);
  const fail = st.failing as Dict | undefined;
  if (truthy(fail)) {
    lines.push(`FAILING since ${age(fail!.since as number)} ago (${String(fail!.count)} check(s) in a row): ` +
      `${String(fail!.reason)}`);
  }
  const last = st.last as Dict | undefined;
  if (truthy(last) && truthy(last!.compacted)) {
    lines.push(`Last reading: compacted, no turn since (checked ${age(last!.at as number)} ago).`);
  } else if (truthy(last)) {
    lines.push(`Last reading: ${percentText(last!.percent as number)} (${commas(last!.tokens as number)} of ` +
      `${commas(last!.window as number)} tokens, ${String(last!.model)}), ${age(last!.at as number)} ago; ` +
      `${truthy(get(st, "armed", true)) ? "armed" : "already warned for this crossing"}.`);
  }
  if (truthy(st.checked_at)) {
    lines.push(`Last check: ${age(st.checked_at as number)} ago.`);
  } else {
    lines.push("Last check: never. The Stop hook has not run for sous chef " +
      "(is `sc hook chef-stop` registered in .agents/settings.json?).");
  }
  return lines;
}
