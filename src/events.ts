// The per-session event log, sous chef's read positions, and open questions.
//
// Each session has state/sessions/<id>/events.jsonl. Every line is one event:
//   {"author": "session", "key": "db-choice", "seq": 3, "state": "needs-decision",
//    "text": "...", "ts": 1789657159.1}
//
// Authors:
//   session  written by the session itself through `sc report`
//   sc       written by sous chef's own commands (spawn, send --resolves, mark, stop)
//   watcher  written by the watcher when something needs sous chef's attention
//   cron     written when a scheduled job fires (cron.ts), only in the cron log
//   context  written by sous chef's Stop hook (context.ts), only in the context log
//   slack    written by the watcher for a message collected from the relay (slack.ts),
//            only in the slack log
//   sync     written by the watcher when syncing the data folder stops or starts again
//            (sync.ts), only in the sync log
//
// Besides one log per session there are four more, for sous chef itself, which has no
// inbox of its own. Each is named wherever a session id would go, and is read and
// acknowledged exactly like a session's log:
//   the cron log, state/cron/events.jsonl (CRON_LOG): what scheduled jobs deliver to
//     sous chef; the watcher wakes sous chef for these once it is idle;
//   the context log, state/context/events.jsonl (CONTEXT_LOG): warnings that sous
//     chef's context is filling (context.ts); nothing wakes sous chef for these;
//   the slack log, state/slack/events.jsonl (SLACK_LOG): messages from Slack (slack.ts);
//     the watcher wakes sous chef as soon as it writes one, idle or mid-turn;
//   the sync log, state/sync/events.jsonl (SYNC_LOG): syncing the data folder stopped
//     (`sync-stopped`, which wakes sous chef) or started again (`sync-resumed`, which does not).
//
// The log is append-only. What a session is doing *now* is derived from it
// (waitingOn, openQuestions), never stored separately.

import fs from "node:fs";
import path from "node:path";
import { withLock } from "./lock.js";
import { dumps, loads } from "./pyjson.js";
import { Dict, isFile, or, readText, rpartition, strip } from "./py.js";
import * as records from "./records.js";
import { now, owner, Owner, readJson, SCError, stateDir, writeJson } from "./util.js";

export interface Event extends Dict {
  seq: number;
  ts: number;
  author: string;
  state: string;
  text: string;
  key?: string;
  waiting_on?: string;
}

export const SESSION_STATES: Record<string, string> = {
  "working": "a material phase started; not a progress ping",
  "needs-decision": "sous chef must decide (or ask the owner) before work continues",
  "blocked": "cannot continue without something from sous chef or the owner",
  "waiting": "waiting for the owner to reply inside this session's own terminal",
  "paused": "waiting on something outside (CI, a deploy, another person)",
  "done": "the task is finished; text says what came out of it",
  "failed": "the task cannot be finished; text says why",
  "resolved": "closes an earlier needs-decision or blocked with the same key",
  "note": "information sous chef should read, needing no action",
  "nothing-new": "(sessions launched by a scheduled job only) the job ran and found nothing worth reporting",
};

// States that mean sous chef should look soon. Reporting one wakes sous chef;
// the watcher retries the wake-up for these if sous chef has not read them.
// `resolved` is here because a session reports it when the owner answered a question
// inside the session: sous chef would otherwise never learn the question closed.
// `due` is a scheduled job for sous chef itself (cron.ts). The watcher wakes sous chef
// for it only once sous chef is idle, so a firing never interrupts a turn.
// `prompt-waiting` (watcher) is a session held at a prompt only a person can answer;
// its `prompt-answered` follow-up needs no action, so it does not wake. Nor does
// `auto-resumed` (watcher): the watcher resumed a session that stopped while idle,
// and only a failed resume, reported as `gone`, needs sous chef.
// The four Slack labels (slack.ts) are messages from Slack, in the slack log only.
// `sync-stopped` (sync.ts) means the data folder is no longer being pushed.
export const SLACK_STATES = new Set(["message", "reply", "mention", "thread-reply"]);
export const WAKE_STATES = new Set(["needs-decision", "blocked", "waiting", "paused", "done", "failed", "resolved",
  "silent-stop", "gone", "inbox-unread", "prompt-waiting", "due", "sync-stopped", ...SLACK_STATES]);

// Who the session is waiting on after an event with this state. States not
// listed here leave the previous value unchanged. `owner` is the person sous chef
// works for (util.owner); it is shown as their name in lower case (showWaiting).
export const WAITING_ON: Record<string, string> = {
  "working": "agent",
  "needs-decision": "sc",
  "blocked": "sc",
  "waiting": "owner",
  "paused": "external",
  "done": "nobody",
  "nothing-new": "nobody",
  "failed": "nobody",
  "resolved": "agent",
  "resumed": "agent",
  "stopped": "nobody",
  "silent-stop": "sc",
  "gone": "sc",
  "inbox-unread": "sc",
  "prompt-waiting": "owner",
};

export const KEYED_STATES = new Set(["needs-decision", "blocked"]);

// A `note` never wakes sous chef and never becomes an open question, so a question
// reported as one is invisible: nothing records that the session is waiting. This
// matches the literal state names only. Keep it narrow -- a note legitimately
// mentioning a decision in passing should not be rejected, and the startup summary
// now counts unread notes, which catches whatever this misses.
export const READS_AS_QUESTION = /\bneeds[- ]decision\b/i;

export const CRON_LOG = "cron"; // never a session id: those always have a kind, a slug and a suffix
// Warnings from sous chef's own Stop hook about how full its context is (context.ts).
// Unlike the cron log, nothing wakes sous chef for it: it is read at the next `sc events`.
export const CONTEXT_LOG = "context";
// Messages from Slack, collected from the relay by the watcher (slack.ts).
export const SLACK_LOG = "slack";
// Syncing the data folder stopping and starting again, written by the watcher (sync.ts).
export const SYNC_LOG = "sync";
export const CHEF_LOGS = [CRON_LOG, CONTEXT_LOG, SLACK_LOG, SYNC_LOG];

export function logDir(sid: string): string {
  if (CHEF_LOGS.includes(sid)) return path.join(stateDir(), sid);
  return records.sessionDir(sid);
}

export function logPath(sid: string): string {
  return path.join(logDir(sid), "events.jsonl");
}

export function readAll(sid: string): Event[] {
  const p = logPath(sid);
  if (!isFile(p)) return [];
  const out: Event[] = [];
  // Python reads the file line by line, splitting on "\n" only.
  for (const raw of readText(p).split(/(?<=\n)/)) {
    const line = strip(raw);
    if (line) out.push(loads(line) as Event);
  }
  return out;
}

/** Append one event. `extra` adds fields of the log's own (the slack log's `slack`, a cron event's `job`). */
export async function append(sid: string, author: string, state: string, text = "", key: string | null = null,
                             waitingOn: string | null = null, extra: Dict | null = null): Promise<Event> {
  return withLock(path.join(logDir(sid), ".events.lock"), () => {
    const existing = readAll(sid);
    const seq = existing.length ? existing[existing.length - 1]!.seq + 1 : 1;
    if (KEYED_STATES.has(state) && !key) key = `q${seq}`;
    const event: Event = { seq, ts: now(), author, state, text };
    if (key) event.key = key;
    if (waitingOn) event.waiting_on = waitingOn;
    for (const [k, v] of Object.entries(extra ?? {})) {
      if (!(k in event)) event[k] = v;
    }
    fs.appendFileSync(logPath(sid), dumps(event, { sortKeys: true }) + "\n");
    return event;
  });
}

// The value logs written before the owner was a setting store `owner` as.
export const LEGACY_OWNER = "dylan";

/** Who the session waits on now: one of WAITING_ON's values, with LEGACY_OWNER read as `owner`. */
export function waitingOn(events: Event[]): string {
  let current = "agent";
  for (const e of events) {
    if (e.waiting_on) current = e.waiting_on;
    else if (Object.hasOwn(WAITING_ON, e.state)) current = WAITING_ON[e.state]!;
  }
  return current === LEGACY_OWNER ? "owner" : current;
}

/**
 * A waiting-on value as people read it: `owner` becomes the owner's name in lower case.
 *
 * Without a usable owner.json it stays `owner`, so read-only views never refuse.
 */
export function showWaiting(value: string): string {
  if (value !== "owner") return value;
  let o: Owner | null;
  try {
    o = owner();
  } catch (e) {
    if (!(e instanceof SCError)) throw e;
    o = null;
  }
  return o ? o.lower : value;
}

/** needs-decision and blocked events whose key has no later resolved event. */
export function openQuestions(events: Event[]): Event[] {
  const open = new Map<string, Event>();
  for (const e of events) {
    if (KEYED_STATES.has(e.state)) {
      open.delete(e.key!);
      open.set(e.key!, e);
    } else if (e.state === "resolved" && e.key) {
      open.delete(e.key);
    }
  }
  return [...open.values()].sort((a, b) => a.seq - b.seq);
}

export function lastSessionEvent(events: Event[]): Event | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.author !== "sc") return events[i]!;
  }
  return null;
}

// --- sous chef's read positions -------------------------------------------

function cursorPath(): string {
  return path.join(stateDir(), "cursors.json");
}

export function cursors(): Record<string, number> {
  return or(readJson<Record<string, number>>(cursorPath(), {}), {}) as Record<string, number>;
}

/** Events sous chef has not acknowledged, excluding ones it wrote itself. */
export function unread(sid: string, events?: Event[]): Event[] {
  const evs = events ?? readAll(sid);
  const pos = cursors()[sid] ?? 0;
  return evs.filter((e) => e.seq > pos && e.author !== "sc");
}

/**
 * Advance read positions to the ones named in a token from `sc events`.
 *
 * Token format: "<id>:<seq>,<id>:<seq>". Positions only ever move forward.
 */
export async function ack(token: string): Promise<string[]> {
  const moved: string[] = [];
  const pairs: [string, number][] = [];
  for (const part of token.split(",").filter(Boolean)) {
    const [key, , seq] = rpartition(part, ":");
    if (!key || !/^[0-9]+$/.test(seq)) throw new SCError(`bad ack token part '${part}'`);
    // Resolve prefixes before writing, so an acknowledgement cannot land under
    // an id that does not exist and leave the events unread forever.
    pairs.push([CHEF_LOGS.includes(key) ? key : records.resolve(key).id, Number(seq)]);
  }
  await withLock(path.join(stateDir(), ".cursors.lock"), () => {
    const data = cursors();
    for (const [sid, seq] of pairs) {
      if (seq > (data[sid] ?? 0)) {
        data[sid] = seq;
        moved.push(sid);
      }
    }
    writeJson(cursorPath(), data);
  });
  return moved;
}

export async function forget(sid: string): Promise<void> {
  await withLock(path.join(stateDir(), ".cursors.lock"), () => {
    const data = cursors();
    if (!Object.hasOwn(data, sid)) return;
    const was = data[sid];
    delete data[sid];
    if (was !== null && was !== undefined) writeJson(cursorPath(), data);
  });
}
