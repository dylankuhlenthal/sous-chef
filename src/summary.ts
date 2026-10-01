// The startup summary sous chef reads on every start, resume and compaction.
//
// It has to stay small, because it is loaded into a session that may run for a
// very long time. Each memory file is capped, and the summary names the file to
// read when something was cut.
//
// Right after the owner line come the owner's own instructions (instructions.md in
// the data folder), in full up to INSTRUCTIONS_CAP: the rules that are theirs rather
// than sous chef's, so the core's AGENTS.md can stay free of them. The summary is
// cut from the end, so TOTAL_CAP leaves room for them before the memory sections.
// Paths in headings are written as sous chef reaches them from its folder: my/...
// Caps count characters (code points), as Python did.

import path from "node:path";
import * as context from "./context.js";
import * as cron from "./cron.js";
import * as events from "./events.js";
import * as inbox from "./inbox.js";
import { Dict, isDict, isFile, len, readText, slice, strip } from "./py.js";
import * as records from "./records.js";
import * as runtimes from "./runtimes/index.js";
import { Listing } from "./runtimes/index.js";
import * as slack from "./slack.js";
import { age, home, memoryDir, owner, ownerText, SCError } from "./util.js";
import * as watch from "./watch.js";

const FILE_CAP = 6000; // characters per memory file
const INSTRUCTIONS_CAP = 12000; // characters of the owner's instructions
const TOTAL_CAP = 42000; // characters for the whole summary (roughly 10,500 tokens)
const INSTRUCTIONS = "instructions.md";

const MEMORY_FILES: [string, string][] = [
  ["Current focus", "focus.md"],
  ["Threads index", "threads/index.md"],
  ["Ideas", "ideas.md"],
  ["PoCs", "pocs.md"],
  ["Repos", "repos.md"],
];

export async function sessionsTable(recsIn?: records.Rec[]): Promise<string> {
  const recs = recsIn ?? records.allRecords();
  if (!recs.length) return "No active sessions.";
  const listings = new Map<string, Listing | null>();
  const lines: string[] = [];
  for (const rec of recs) {
    const rt = runtimes.get(rec.runtime);
    if (!listings.has(rec.runtime)) {
      try {
        listings.set(rec.runtime, await rt.listing());
      } catch (e) {
        if (!(e instanceof SCError)) throw e;
        listings.set(rec.runtime, null);
      }
    }
    const rows = listings.get(rec.runtime) ?? null;
    let activity: Dict | null = null;
    let running: string;
    if (rows === null) {
      running = "unknown";
    } else {
      const st = await rt.status(rec, rows);
      if (!st.alive) running = "stopped";
      else if (st.prompt) running = "held at a prompt";
      // busy is null when the runtime cannot tell; never call that idle.
      else running = st.busy === true ? "busy" : st.busy === false ? "idle" : "running";
      if (st.alive) {
        activity = isDict(st.activity) ? st.activity : null;
        const n = activity ? activity.in_flight : null;
        if (n) running += `, ${String(n)} in flight`;
      }
    }
    const log = events.readAll(rec.id);
    const last = events.lastSessionEvent(log);
    const lastTxt = last ? `${last.state} ${age(last.ts)} ago` : "-";
    const extras: string[] = [];
    if (events.openQuestions(log).length) extras.push(`${events.openQuestions(log).length} open question(s)`);
    if (inbox.unhandled(rec.id).length) extras.push(`${inbox.unhandled(rec.id).length} unhandled message(s)`);
    const waiting = events.showWaiting(events.waitingOn(log));
    lines.push(`- ${rec.id} | ${rec.kind} | ${running} | waiting on: ${waiting} | last: ${lastTxt} | ${rec.title}` +
      (extras.length ? ` | ${extras.join(", ")}` : ""));
    const doing = activityLine(activity);
    if (doing) lines.push(`    ${doing}`);
  }
  return lines.join("\n");
}

/**
 * One line on what a running session says it is doing and which subagents it has running, or "".
 *
 * At most `most` subagent labels are named; `sc status` lists everything running.
 */
export function activityLine(activity: Dict | null, most = 2): string {
  if (!activity || !Object.keys(activity).length) return "";
  const parts: string[] = [];
  if (activity.detail) parts.push(`doing: ${String(activity.detail)}`);
  const running = Array.isArray(activity.running) ? (activity.running as Dict[]) : [];
  const agents = running.filter((r) => r.kind === "subagent").map((r) => String(r.label));
  if (agents.length) {
    const named = agents.slice(0, most).join(", ") + (agents.length > most ? `, +${agents.length - most} more` : "");
    parts.push(`subagents: ${named}`);
  }
  return parts.join(" | ");
}

export function cronLines(): string {
  const [jobs, broken] = cron.allJobs();
  if (!jobs.length && !Object.keys(broken).length) return "None.";
  const lines = jobs.map((j) => `- ${j.name}: ${cron.scheduleText(j)}, done by ${j.target === "worker" ? "a worker" : "you"}`);
  lines.push(...Object.keys(broken).map((name) => `- ${name}: BROKEN, see \`sc cron list\``));
  return lines.join("\n");
}

async function watcherLine(): Promise<string> {
  const h = await watch.health();
  if (!h.running) return "NOT RUNNING: run `sc watch --ensure`";
  return h.current ? "running" : `running, but NOT ON CURRENT CODE: ${h.problem}`;
}

/** One file in full under a heading naming it as `shown`, cut at `cap` characters saying where the rest is. */
function fileSection(title: string, p: string, shown: string, cap: number,
                     read: (p: string) => string = (x) => strip(readText(x))): string {
  if (!isFile(p)) return `## ${title} (${shown})\nABSENT`;
  let text = read(p);
  if (len(text) > cap) text = slice(text, 0, cap) + `\n[... cut at ${cap} characters; read ${shown} for the rest]`;
  return `## ${title} (${shown})\n${text || "(empty)"}`;
}

function memorySection(title: string, rel: string): string {
  return fileSection(title, path.join(memoryDir(), rel), `my/memory/${rel}`, FILE_CAP);
}

/** The owner's instructions, with their <!-- comments --> left out. */
export function instructionsSection(): string {
  return fileSection("Your owner's instructions: follow them as you follow AGENTS.md",
    path.join(home(), INSTRUCTIONS), `my/${INSTRUCTIONS}`, INSTRUCTIONS_CAP, ownerText);
}

/** The summary's first line: who sous chef works for, or how to set it. Never refuses. */
export function ownerLine(): string {
  let o;
  try {
    o = owner();
  } catch (e) {
    if (e instanceof SCError) return `No usable owner: ${e.message}.`;
    throw e;
  }
  if (!o) return "No owner set: run `sc owner set --name <name> --branch-prefix <prefix>`.";
  return `Owner: ${o.name}. Branch prefix: ${o.branch_prefix || "(none)"}.`;
}

export async function build(): Promise<string> {
  const recs = records.allRecords();
  const unread = new Map<string, events.Event[]>(recs.map((r) => [r.id, events.unread(r.id)]));
  unread.set(events.CRON_LOG, events.unread(events.CRON_LOG));
  unread.set(events.SLACK_LOG, events.unread(events.SLACK_LOG));
  unread.set(events.SYNC_LOG, events.unread(events.SYNC_LOG));
  let unreadCount = [...unread.values()].reduce((n, es) => n + es.filter((e) => events.WAKE_STATES.has(e.state)).length, 0);
  // Context warnings never wake anyone (context.ts), but each one asks for action.
  unreadCount += events.unread(events.CONTEXT_LOG).length;
  // Notes stay out of WAKE_STATES on purpose: they need no action, so they must not
  // interrupt. But nothing else surfaced them either, so a note sat unread until
  // someone happened to run `sc events`. Counting them here means they are picked up
  // at the next start, resume or compaction without waking anyone.
  const noteCount = [...unread.values()].reduce((n, es) => n + es.filter((e) => e.state === "note").length, 0);
  const openQ = recs.reduce((n, r) => n + events.openQuestions(events.readAll(r.id)).length, 0);
  let attention = `Unread events needing attention: ${unreadCount}. Open questions: ${openQ}.`;
  if (noteCount) attention += ` Unread notes (no action needed): ${noteCount}.`;
  attention += unreadCount || openQ || noteCount ? " Run `sc events` now." : " Nothing waiting.";
  const parts = [
    ownerLine(),
    instructionsSection(),
    "## Sessions\n" + (await sessionsTable(recs)),
    "## Attention\n" + attention,
    "## Watcher\n" + (await watcherLine()),
    "## Cron jobs\n" + cronLines(),
    "## Context check (`sc context`)\n" + context.statusLines().join("\n"),
    "## Slack (`sc slack status`)\n" + (await slack.statusLines()).join("\n"),
    ...MEMORY_FILES.map(([t, rel]) => memorySection(t, rel)),
  ];
  let text = parts.join("\n\n");
  if (len(text) > TOTAL_CAP) text = slice(text, 0, TOTAL_CAP) + "\n[... summary cut; run `sc summary` in full or read the memory files]";
  return text;
}
