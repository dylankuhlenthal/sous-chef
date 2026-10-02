// The watcher: a plain Node loop that uses no tokens and wakes sous chef only when needed.
//
// Each cycle (every SC_WATCH_POLL seconds) it looks at every active session and:
//
// 1. Gone: the session has not been seen running for SC_GONE_GRACE seconds, sous
//    chef did not stop it, and it was not finished. A single missed poll is normal
//    (a session restarting drops out of the listing for a few seconds), so the first
//    miss only starts the clock. A session waiting on the owner, sous chef or something
//    external (AUTO_RESUME_WAITING) most likely stopped because Claude Code stops
//    background sessions that sit idle, so the watcher resumes it itself, sends it a
//    message saying why, and appends `auto-resumed`, which does not wake sous chef
//    (`autoResume`, with limits against a session that keeps stopping). Otherwise,
//    or when the resume fails or a limit is reached, it appends a `gone` event once
//    until the session is seen running again.
// 2. Held at a prompt: the runtime has said for SC_PROMPT_GRACE seconds that the
//    session is held mid-turn by something only a person can answer (for Claude, a
//    permission prompt). Appends one `prompt-waiting` event per prompt, and a
//    `prompt-answered` event when a prompt it reported goes away.
// 3. Silent stop: the session ended a turn more than SC_SILENT_GRACE seconds ago,
//    is idle (see `idle`), and its log still says it is waiting on the agent (it
//    stopped without reporting why). Appends one `silent-stop` event per stopped turn.
//    While the runtime says the session has subagents or background commands still
//    running, it is waiting on them, not stopped: the event is held back, and the
//    grace counts from the last time work was seen in flight (`quietSince`). After
//    SC_INFLIGHT_MAX seconds since the turn ended, it is reported anyway.
// 4. Unread inbox: a message older than SC_INBOX_GRACE is still unhandled. Re-sends
//    the wake-up to an idle session up to SC_INBOX_RINGS times, then appends one
//    `inbox-unread` event.
// 5. Unread events: sous chef has not acknowledged an event that needs attention.
//    Re-sends sous chef's wake-up, backing off (SC_WAKE_RETRY, doubling, max 1h).
//
// Then, once per cycle, it runs the scheduled jobs (cron.tick), and wakes sous
// chef for unread cron events, but only while sous chef is idle: a job's message
// waits for the end of a busy turn rather than interrupting it.
//
// Then, when Slack is set up (slack.ts), it collects the owner's messages from the relay
// (slack.poll) into the slack log and wakes sous chef in the same cycle, idle or
// mid-turn, retrying with the usual back-off until they are acknowledged.
//
// Last, when the data folder is a git repo with an upstream, it commits and pushes it
// (sync.tick), and wakes sous chef if syncing stopped.
//
// All wake-ups for sous chef in one cycle go out as a single message. Everything
// the watcher finds is written to the session's event log first, so a failed
// wake-up delays attention but never loses it.
//
// One watcher runs at a time: it holds state/watch.lock (through proper-lockfile, see
// lock.ts) for its whole life. Nothing in a cycle blocks the event loop, so the lock
// stays fresh; git and the relay are called asynchronously.
//
// The watcher runs whatever code it loaded when it started. So that a change to
// sc reaches it, it restarts between cycles when its code on disk changes
// (`restartIfCodeChanged`): it starts a new watcher on the new code and exits (Node
// cannot replace its own process). `ensure` restarts a running watcher whose code it
// cannot vouch for, such as one started before this check existed.
//
// Shortcut (PoC): the watcher is started by sous chef's SessionStart hook
// (ensure) rather than by a system service, so it does not come back after
// a reboot until sous chef starts again.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as chef from "./chef.js";
import * as cron from "./cron.js";
import * as events from "./events.js";
import * as inbox from "./inbox.js";
import { holdLock, isHeld } from "./lock.js";
import * as ops from "./ops.js";
import { run } from "./proc.js";
import { Dict, get, isDict, or, readText, slice, sorted, strip, truthy, walkFiles } from "./py.js";
import * as records from "./records.js";
import * as runtimes from "./runtimes/index.js";
import { Listing, Status, WakeError } from "./runtimes/index.js";
import * as slack from "./slack.js";
import * as sync from "./sync.js";
import {
  age, CODE_ROOT, envFloat, iso, mkdirs, now, ownerName, readJson, realNow, SCError, scBin, sleep, stateDir, writeJson,
} from "./util.js";

function statePath(): string {
  return path.join(stateDir(), "watch.json");
}

function lockPath(): string {
  return path.join(stateDir(), "watch.lock");
}

/** What the running watcher loaded: {pid, code, poll, started_at}, written at its start. */
function codePath(): string {
  return path.join(stateDir(), "watch.code");
}

function errorText(e: unknown): string {
  return e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : String(e);
}

/**
 * A hash of the code a watcher runs: bin/sc and every file under dist/ (the build).
 *
 * Kinds and templates are left out: they are read fresh each time they are used.
 * dist/.build-stamp records only content (scripts/build-stamp.js), so an identical rebuild gives the same hash.
 * Tests only: SC_TEST_CODE_FILE names one more file to count as code, so a test can
 * change the code without editing a language's own source files.
 */
export function codeFingerprint(): string {
  const root = CODE_ROOT;
  const h = createHash("sha1");
  const paths: [string, string][] = [[path.join(root, "bin", "sc"), "bin/sc"],
    ...walkFiles(path.join(root, "dist")).map((rel) => [path.join(root, "dist", rel), `dist/${rel}`] as [string, string])];
  const extra = process.env.SC_TEST_CODE_FILE;
  if (extra) paths.push([extra, extra]);
  for (const [p, name] of paths) {
    h.update(Buffer.concat([Buffer.from(name, "utf8"), Buffer.from([0])]));
    try {
      h.update(fs.readFileSync(p));
    } catch {
      h.update("(unreadable)");
    }
  }
  return h.digest("hex").slice(0, 12);
}

type WState = Record<string, Dict>;

function setdefault(d: Dict, key: string, value: unknown): Dict {
  if (!Object.hasOwn(d, key)) d[key] = value;
  return d[key] as Dict;
}

export async function cycle(): Promise<{ actions: string[] }> {
  const pollNow = now();
  const silentGrace = envFloat("SC_SILENT_GRACE", 600);
  const inboxGrace = envFloat("SC_INBOX_GRACE", 120);
  const inboxRings = Math.trunc(envFloat("SC_INBOX_RINGS", 3));
  const wakeRetry = envFloat("SC_WAKE_RETRY", 120);
  const goneGrace = envFloat("SC_GONE_GRACE", 60);
  const staleBusy = envFloat("SC_STALE_BUSY", 300);
  const promptGrace = envFloat("SC_PROMPT_GRACE", 180);
  const inflightMax = envFloat("SC_INFLIGHT_MAX", 7200);
  const autoResumeMax = Math.trunc(envFloat("SC_AUTO_RESUME_MAX", 24));
  const autoResumeMinUp = envFloat("SC_AUTO_RESUME_MIN_UP", 600);

  let wstate = (or(readJson<WState>(statePath(), {}), {}) as WState);
  const listings = new Map<string, Listing | null>();
  const chefNeeded: string[] = [];
  const actions: string[] = [];

  for (const rec of records.allRecords()) {
    const sid = rec.id;
    const rt = runtimes.get(rec.runtime);
    if (!listings.has(rec.runtime)) {
      try {
        listings.set(rec.runtime, await rt.listing());
      } catch (e) {
        if (!(e instanceof SCError)) throw e;
        actions.push(`listing failed for ${rec.runtime}: ${e.message}`);
        listings.set(rec.runtime, null);
      }
    }
    const rows = listings.get(rec.runtime) ?? null;
    if (rows === null || !truthy(rec.handle)) continue;
    let st = await rt.status(rec, rows);
    const s = setdefault(wstate, sid, {});
    const log = events.readAll(sid);
    const waiting = events.waitingOn(log);

    // 1. gone, only once the session has stayed missing for the grace period; a session
    // waiting on someone else is resumed by the watcher itself, within limits
    if (st.alive) {
      s.gone_flagged = false;
      delete s.missing_since;
    } else {
      if (!Object.hasOwn(s, "missing_since")) s.missing_since = pollNow;
      const missingSince = s.missing_since as number;
      if (pollNow - missingSince >= goneGrace && !truthy(rec.stopped_by_sc) && waiting !== "nobody"
          && !truthy(s.gone_flagged)) {
        const whyNot = await autoResume(rec, log, waiting, missingSince, pollNow, autoResumeMax, autoResumeMinUp);
        if (whyNot === null) {
          delete s.missing_since;
          st = await rt.status(rec);
          actions.push(`${sid}: auto-resumed`);
        } else {
          await events.append(sid, "watcher", "gone",
            `the session has not been running for ${age(missingSince)}, and sous ` +
            `chef did not stop it.${stoppedSentence(st)}${whyNot} Check \`sc status ${sid}\` first: if it is ` +
            `back, nothing is needed. If not, resume it with \`sc resume ${sid}\` (which ` +
            "refuses a session that is running) or clean it up.");
          s.gone_flagged = true;
          chefNeeded.push(sid);
          actions.push(`${sid}: gone`);
        }
      }
    }

    // 2. held at a prompt, once the same prompt has stayed open for the grace period
    if (await checkPrompt(rec, st, s, log, waiting, pollNow, promptGrace, rt)) {
      chefNeeded.push(sid);
      actions.push(`${sid}: prompt-waiting`);
    }

    // 3. silent stop, held back while the session's own subagents or commands run
    // Turn times from the runtime when it keeps them (Porch's hooks), else sc's turns.json,
    // which sessions launched before the move to Porch still write (worker-prompt/worker-stop).
    const turns = (st.turns ?? records.turns(sid)) as Dict;
    const isIdle = idle(st, turns, pollNow, staleBusy);
    const lastStop = get<number | null>(turns, "last_stop_at", null);
    const lastPrompt = get<number | null>(turns, "last_prompt_at", null);
    const flying = inFlight(st);
    if (flying) s.in_flight_seen_at = pollNow;
    const quiet = quietSince(lastStop, flying, get<number | null>(s, "in_flight_seen_at", null), pollNow, inflightMax);
    if (isIdle && truthy(lastStop) && quiet !== null
        && (!truthy(lastPrompt) || lastStop! >= lastPrompt!)
        && pollNow - quiet >= silentGrace
        && waiting === "agent"
        && get(s, "silent_flagged_stop", null) !== lastStop) {
      const still = flying ? ` It still has ${flying} subagent(s) or background command(s) running, but they have ` +
        "held this report back as long as they may, so one of them may be stuck." : "";
      await events.append(sid, "watcher", "silent-stop",
        `the session ended a turn ${age(lastStop!)} ago without reporting why.${still} ` +
        `Check it with \`sc status ${sid}\` or \`claude logs\`.`);
      s.silent_flagged_stop = lastStop;
      chefNeeded.push(sid);
      actions.push(`${sid}: silent-stop`);
    }

    // 4. unread inbox
    const rings = setdefault(s, "rings", {});
    const escalated = new Set<string>((get<string[]>(s, "inbox_escalated", [])));
    for (const msg of inbox.unhandled(sid)) {
      const key = String(msg.seq);
      if (pollNow - msg.ts < inboxGrace || escalated.has(key)) continue;
      let reason: string;
      if (!st.alive) {
        if (truthy(rec.stopped_by_sc)) continue;
        reason = "the session is not running";
      } else if (!isIdle) {
        continue; // busy, or nobody can tell: leave it alone
      } else {
        const r = setdefault(rings, key, { count: 0, last: 0 });
        if ((r.count as number) < inboxRings) {
          if (pollNow - (r.last as number) >= inboxGrace) {
            try {
              await rt.wake(rec, `sous chef: message ${msg.seq} is still waiting in your inbox. ` +
                `Run \`sc inbox\`, act on it, then \`sc inbox ack ${msg.seq}\`.`, rows);
              actions.push(`${sid}: re-rang message ${key}`);
            } catch (e) {
              if (!(e instanceof WakeError)) throw e;
              actions.push(`${sid}: re-ring failed: ${e.message}`);
            }
            r.count = (r.count as number) + 1;
            r.last = pollNow;
          }
          continue;
        }
        reason = `it was not acknowledged after ${inboxRings} wake-ups`;
      }
      await events.append(sid, "watcher", "inbox-unread", `inbox message ${msg.seq} is unhandled: ${reason}.`);
      escalated.add(key);
      chefNeeded.push(sid);
      actions.push(`${sid}: inbox-unread ${key}`);
    }
    s.inbox_escalated = sorted(escalated);

    // 5. unread events sous chef has not acknowledged
    if (!chefNeeded.includes(sid) && rewakeDue(sid, s, pollNow, wakeRetry, true)) {
      chefNeeded.push(sid);
      actions.push(`${sid}: re-woke sous chef for unread events`);
    }
  }

  // 6. scheduled jobs, then the cron log's unread events, delivered only while sous chef is idle
  try {
    actions.push(...(await cron.tick()).actions);
  } catch (e) { // a broken job must not stop the session checks
    actions.push("cron failed:\n" + errorText(e));
  }
  const cs = setdefault(wstate, events.CRON_LOG, {});
  let cronWake = false;
  if (events.unread(events.CRON_LOG).length && (await chef.status()).busy === false) {
    cronWake = rewakeDue(events.CRON_LOG, cs, pollNow, wakeRetry, false);
    if (cronWake) actions.push("cron: woke sous chef for unread cron events");
  }

  // 8. Slack: collect from the relay, then wake sous chef at once, idle or mid-turn. Claude
  // Code holds a wake-up for a busy session until its next step, so nothing is interrupted.
  // The first wake goes out in the cycle that wrote the messages; retries back off as for
  // a session's report (wokenAtWrite), until the slack log is acknowledged.
  let slackNew = 0;
  try {
    const polled = await slack.poll();
    actions.push(...polled.actions);
    slackNew = polled.written;
  } catch (e) { // Slack must never stop the other checks
    actions.push("slack failed:\n" + errorText(e));
  }
  const ss = setdefault(wstate, events.SLACK_LOG, {});
  const slackWake = rewakeDue(events.SLACK_LOG, ss, pollNow, wakeRetry, true) || slackNew > 0;
  if (slackWake && !slackNew) actions.push("slack: re-woke sous chef for unread Slack messages");

  // 9. Keep the data folder committed and pushed, when it is a git repo with an upstream.
  // Stopping (a conflict, or pushes failing) wakes sous chef at once, then backs off.
  try {
    actions.push(...(await sync.tick()).actions);
  } catch (e) { // syncing must never stop the other checks
    actions.push("sync failed:\n" + errorText(e));
  }
  const syncWake = rewakeDue(events.SYNC_LOG, setdefault(wstate, events.SYNC_LOG, {}), pollNow, wakeRetry, false);

  // Forget watcher state for sessions that were cleaned up.
  const active = new Set([...records.allIds(), events.CRON_LOG, events.SLACK_LOG, events.SYNC_LOG]);
  wstate = Object.fromEntries(Object.entries(wstate).filter(([k]) => active.has(k)));

  if (chefNeeded.length || cronWake || slackWake || syncWake) {
    const parts: string[] = [];
    if (chefNeeded.length) parts.push(`sessions need attention (${[...new Set(chefNeeded)].join(", ")})`);
    if (cronWake) parts.push("scheduled jobs are waiting for you");
    if (slackWake) parts.push(slackNew ? `${slackNew} new Slack message(s)` : "Slack messages are waiting for you");
    if (syncWake) parts.push("syncing your data folder stopped");
    const ok = await chef.wakeChef(`sous chef watcher: ${parts.join("; ")}. Run \`sc events\`.`);
    actions.push(`woke sous chef: ${ok ? "True" : "False"}`);
  }
  writeJson(statePath(), wstate);
  return { actions };
}

// Who a session may be waiting on for the watcher to resume it after it stopped by
// itself: someone other than the session, so it was idle and its work is unfinished.
// `agent` is left out: that session was working (or stopped silently within the last
// SC_SILENT_GRACE), so its stopping is unexplained and sous chef should look.
const AUTO_RESUME_WAITING = ["owner", "sc", "external"];

/**
 * Check 1: resume a session that stopped while waiting on someone else.
 *
 * Returns null when it was resumed. Otherwise returns the reason it was not, as a
 * sentence (with a leading space) for the `gone` event, or "" when this session is
 * not one the watcher resumes. The limits guard against a session that keeps
 * stopping: at most `maxPerDay` automatic resumes in any 24 hours, and none when
 * the session stopped within `minUp` seconds of the last one. Both are counted from
 * the session's own `auto-resumed` events, so nothing else has to agree with the log.
 */
async function autoResume(rec: records.Rec, log: events.Event[], waiting: string, missingSince: number,
                          pollNow: number, maxPerDay: number, minUp: number): Promise<string | null> {
  if (!AUTO_RESUME_WAITING.includes(waiting) || maxPerDay <= 0) return "";
  const shown = events.showWaiting(waiting);
  const recent = log.filter((e) => e.state === "auto-resumed" && pollNow - e.ts < 86400);
  if (recent.length >= maxPerDay) {
    return ` The watcher did not resume it: it has already done so ${recent.length} times in the last 24 ` +
      "hours, the most it may (SC_AUTO_RESUME_MAX).";
  }
  const last = recent[recent.length - 1];
  if (last && missingSince - last.ts < minUp) {
    return ` The watcher did not resume it: it stopped again within ${Math.floor(minUp / 60)} minutes of the ` +
      `watcher resuming it (event ${last.seq}), so something may be stopping it on purpose ` +
      "or it fails as it starts.";
  }
  let event: events.Event;
  try {
    event = await ops.resume(rec, "watcher", "auto-resumed",
      `the session stopped by itself about ${age(missingSince)} ago while waiting on ${shown}, ` +
      "most likely because Claude Code stops a background session that has been idle for about an " +
      `hour. The watcher resumed it with its conversation (automatic resume ${recent.length + 1} of at ` +
      `most ${maxPerDay} in 24 hours) and sent it a message to restart anything tied to its old ` +
      "process. Nothing to do.");
  } catch (e) { // a failed resume is reported as `gone`, never stops the cycle
    return ` The watcher tried to resume it and failed: ${e instanceof Error ? e.message : String(e)}.`;
  }
  await ops.send(rec,
    `You were resumed by sous chef's watcher (event ${event.seq}): this session stopped by itself while it ` +
    "was idle, most likely because Claude Code stops background sessions that stay idle for about an hour. " +
    "Your conversation is intact, but anything tied to your old process has ended: a local server, a " +
    "background command, a monitor. Restart what you still need; for example a local page server " +
    "must be restarted, because it targets your old process. Then carry on as before. Sous chef still has " +
    `you as waiting on ${shown}, so do not report again unless your situation changed.`, { sender: "watcher" });
  return null;
}

/**
 * Check 2: report a session held at a prompt. Returns true when it appended `prompt-waiting`.
 *
 * `s.prompt` tracks the prompt open now: {text, since, flagged_seq, before}.
 * A prompt with different text is a new prompt and starts the clock again. When a
 * reported prompt goes away while the session runs, `prompt-answered` is appended.
 * It gives back the "waiting on" from before the prompt, unless something was
 * recorded since, so that a later silent stop is still noticed.
 */
async function checkPrompt(rec: records.Rec, st: Status, s: Dict, log: events.Event[], waiting: string,
                           pollNow: number, grace: number, rt: runtimes.Runtime): Promise<boolean> {
  const sid = rec.id;
  const prompt = st.alive ? (get<string | null>(st as unknown as Dict, "prompt", null)) : null;
  let held = get<Dict | null>(s, "prompt", null);
  if (truthy(held) && get(held, "text", null) !== prompt) {
    if (truthy(held!.flagged_seq) && st.alive) {
      const latest = log.length ? log[log.length - 1]!.seq : null;
      const restore = latest === held!.flagged_seq ? (held!.before as string | null) : null;
      await events.append(sid, "watcher", "prompt-answered",
        `the prompt reported in event ${String(held!.flagged_seq)} is no longer open ` +
        `(${String(held!.text)}). Nothing to do.`, null, restore);
    }
    delete s.prompt;
    held = null;
  }
  if (!truthy(prompt)) return false;
  if (!truthy(held)) {
    s.prompt = { text: prompt, since: pollNow, flagged_seq: null, before: null };
    held = s.prompt as Dict;
  }
  if (truthy(held!.flagged_seq) || pollNow - (held!.since as number) < grace) return false;
  const owner = ownerName();
  const event = await events.append(sid, "watcher", "prompt-waiting",
    `the session has been held for ${age(held!.since as number)} by a prompt only a person can answer: ` +
    `${prompt}. It cannot continue until someone answers it in the session. Tell ${owner} which session ` +
    `it is and what it asks; ${owner} answers it with \`${rt.attachCommand(rec)}\`. A message sent with ` +
    "`sc send` does not answer it: it waits behind the prompt.");
  held!.flagged_seq = event.seq;
  held!.before = waiting;
  return true;
}

/** How many subagents or background commands the runtime says a running session has going; 0 when it cannot tell. */
function inFlight(st: Status): number {
  const activity = st.alive ? st.activity : null;
  const n = isDict(activity) ? activity.in_flight : null;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * When check 3's grace starts counting, or null while work in flight holds the silent stop back.
 *
 * A session that ended its turn to wait for its own subagents is not stopped. So
 * while work is in flight nothing is reported, and once it ends the grace counts
 * from the last poll that saw it, giving the session time to be woken by the
 * result. Once SC_INFLIGHT_MAX has passed since the turn ended, work in flight is
 * ignored and the grace counts from the stop, so a subagent that never finishes
 * cannot hide the stop for ever. With no activity from the runtime (the job file
 * missing or changed), `inFlight` is 0, `seenAt` is null, and this is the stop time.
 */
function quietSince(lastStop: number | null, flying: number, seenAt: number | null, pollNow: number,
                    inflightMax: number): number | null {
  if (!truthy(lastStop)) return lastStop;
  if (pollNow - lastStop! >= inflightMax) return lastStop;
  if (flying) return null;
  return Math.max(lastStop!, seenAt || 0);
}

/**
 * What the runtime says about a stopped session, as a sentence (with a leading space) for
 * the `gone` event, or "" when it says nothing. The runtime names who says it (the Claude
 * runtime: Porch). Text only: no decision reads it, and an `ended` session is never taken
 * to mean sous chef stopped it (rec.stopped_by_sc says that).
 */
function stoppedSentence(st: Status): string {
  if (!st.stopped) return "";
  const { source, status, reason } = st.stopped;
  return ` ${source} reports it as ${status}${reason ? ` (${reason})` : ""}.`;
}

/**
 * Whether a running session is between turns, from the runtime and from sc's own turn record.
 *
 * The runtime's word (`claude agents` status) is taken when it says idle. It has
 * also been seen reporting `busy` for a session whose last turn had ended 15
 * minutes before, with no prompt since. So when sc's turn record (the session's
 * Stop and UserPromptSubmit hooks) shows the last turn ended at least
 * `staleBusy` seconds ago and nothing started since, the session counts as idle
 * whatever the runtime says. Every turn start seen so far fires the prompt hook,
 * including a session woken by its own background command finishing.
 *
 * With neither (the runtime cannot tell and no turn has ended), it is not idle:
 * an unknown state never counts as idle.
 */
function idle(st: Status, turns: Dict, pollNow: number, staleBusy: number): boolean {
  if (!st.alive) return false;
  if (st.busy === false) return true;
  const lastStop = get<number | null>(turns, "last_stop_at", null);
  const lastPrompt = get<number | null>(turns, "last_prompt_at", null);
  return Boolean(truthy(lastStop) && (!truthy(lastPrompt) || lastStop! >= lastPrompt!)
    && pollNow - lastStop! >= staleBusy);
}

/**
 * Whether to wake sous chef for this log's unread events now, backing off each time.
 *
 * `wokenAtWrite` says whether whoever wrote the events already woke sous chef
 * (a session's report did; a cron firing did not), which decides whether the first
 * wake waits for the retry delay. `s` is this log's watcher bookkeeping, updated in place.
 */
function rewakeDue(logId: string, s: Dict, pollNow: number, wakeRetry: number, wokenAtWrite: boolean): boolean {
  const pending = events.unread(logId, events.readAll(logId)).filter((e) => events.WAKE_STATES.has(e.state));
  if (!pending.length) return false;
  const top = pending[pending.length - 1]!.seq;
  let cw = (or(s.chef_wake, {}) as Dict);
  if (get(cw, "seq", null) !== top) cw = { seq: top, count: 0, last: wokenAtWrite ? pending[0]!.ts : null };
  if (cw.last === null || cw.last === undefined) {
    s.chef_wake = { ...cw, last: pollNow }; // retried after SC_WAKE_RETRY, as for a report
    return true;
  }
  s.chef_wake = cw;
  const backoff = Math.min(3600, wakeRetry * 2 ** (cw.count as number));
  if (pollNow - (cw.last as number) < backoff) return false;
  cw.count = (cw.count as number) + 1;
  cw.last = pollNow;
  return true;
}

function log(msg: string): void {
  fs.appendFileSync(path.join(stateDir(), "watch.log"), `${iso(realNow())} ${msg}\n`);
}

// A SIGTERM (sent by `ensure` to replace this watcher) ends the loop between cycles,
// never inside one, so a cycle's events and its watch.json are always written together.
const loop = { inCycle: false, stop: null as string | null, release: null as (() => Promise<void>) | null };

async function exitBetweenCycles(why: string): Promise<never> {
  log(why);
  if (loop.release) await loop.release().catch(() => undefined);
  process.exit(0);
}

export async function runForever(): Promise<number> {
  mkdirs(stateDir());
  // A watcher killed outright leaves its lock behind; it counts as abandoned once it has
  // not been touched for lock.STALE_MS, so a new watcher waits a little longer than that.
  const release = await holdLock(lockPath(), 12, (err) => {
    log(`the watcher's lock was lost (${err.message}); this watcher stops after its cycle`);
    loop.stop = "lock lost";
    // Asleep between cycles: stop now, so it never runs a cycle beside the watcher that took the lock.
    if (!loop.inCycle) void exitBetweenCycles("watcher stopped between cycles (lock lost)");
  });
  if (!release) {
    process.stdout.write("sc watch: another watcher is already running\n");
    return 0;
  }
  loop.release = release;
  const logPath = path.join(stateDir(), "watch.log");
  try {
    if (fs.statSync(logPath).size > 1_000_000) fs.unlinkSync(logPath);
  } catch {
    // no log yet
  }
  fs.writeFileSync(path.join(stateDir(), "watch.pid"), String(process.pid));
  const poll = envFloat("SC_WATCH_POLL", 15);
  const loaded = codeFingerprint();
  writeJson(codePath(), { pid: process.pid, code: loaded, poll, started_at: realNow() });
  log(`watcher started (pid ${process.pid}, code ${loaded})`);
  process.on("SIGTERM", () => {
    loop.stop ??= "SIGTERM";
    if (!loop.inCycle) void exitBetweenCycles("watcher stopped between cycles (SIGTERM)");
  });
  let refused: string | null = null;
  for (;;) {
    loop.inCycle = true;
    try {
      const result = await cycle();
      for (const a of result.actions) log(a);
    } catch (e) { // keep watching; the log shows what broke
      log("cycle failed:\n" + errorText(e));
    }
    fs.writeFileSync(path.join(stateDir(), "watch.beat"), String(realNow()));
    loop.inCycle = false;
    if (loop.stop) await exitBetweenCycles(`watcher stopped between cycles (${loop.stop})`);
    refused = await restartIfCodeChanged(loaded, refused);
    await sleep(poll);
  }
}

/**
 * Between cycles: hand over to the code now on disk, if it changed and loads.
 *
 * The state of the finished cycle is already written. This watcher releases its lock,
 * starts a new watcher on the new code and exits; the new one takes the lock as any
 * starting watcher does, and if another watcher got it first, the new one exits and that
 * one carries on. Code that does not load (for example a build half written) is refused
 * and logged once, and this watcher keeps running what it has. Returns the fingerprint
 * refused, if any.
 */
async function restartIfCodeChanged(loaded: string, refused: string | null): Promise<string | null> {
  const nowCode = codeFingerprint();
  if (nowCode === loaded || nowCode === refused) return refused;
  const check = await run(process.execPath, [scBin(), "--help"], { timeout: 60 });
  if (check.code !== 0) {
    log(`the code changed (${loaded} -> ${nowCode}) but the new code does not load, so this watcher ` +
      `keeps running ${loaded}:\n${slice(strip(check.stderr), -1500)}`);
    return nowCode;
  }
  log(`the code changed (${loaded} -> ${nowCode}); restarting on the new code`);
  if (loop.release) await loop.release().catch(() => undefined);
  loop.release = null;
  startDetached();
  process.exit(0);
}

/** Start `<node> <core>/bin/sc watch` in the background, with this process's environment. */
function startDetached(): void {
  mkdirs(stateDir());
  const out = fs.openSync(path.join(stateDir(), "watch.log"), "a");
  try {
    const child = spawn(process.execPath, [scBin(), "watch"], {
      detached: true, stdio: ["ignore", out, out], env: { ...process.env },
    });
    child.unref();
  } finally {
    fs.closeSync(out);
  }
}

function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether a watcher runs: its lock is held and fresh, and the pid it recorded is alive.
 * The pid matters because a watcher killed outright leaves its lock looking held until it
 * goes stale (lock.STALE_MS).
 */
export async function isRunning(): Promise<boolean> {
  mkdirs(stateDir());
  return (await isHeld(lockPath())) && pidAlive(pid());
}

export interface Health {
  running: boolean;
  current: boolean;
  problem: string | null;
}

/**
 * Whether a watcher is running, and whether it runs the code on disk.
 *
 * `current` is false for a watcher started before the code changed, and for one that
 * predates watch.code (it records nothing about its code, so it cannot be vouched for).
 */
export async function health(): Promise<Health> {
  if (!(await isRunning())) {
    return { running: false, current: false,
      problem: "the watcher is not running, so nothing fires and nobody is re-woken " +
        "(`sc watch --ensure` starts it)" };
  }
  const info = (or(readJson<Dict>(codePath(), {}), {}) as Dict);
  if (!truthy(info.code) || get(info, "pid", null) !== pid()) {
    return { running: true, current: false,
      problem: "the watcher running now was started by older code that does not record what it " +
        "runs, so it may be missing changes such as scheduled jobs " +
        "(`sc watch --ensure` restarts it)" };
  }
  if (info.code !== codeFingerprint()) {
    return { running: true, current: false,
      problem: "the watcher is running code older than what is on disk (started " +
        `${age((or(info.started_at, 0) as number))} ago); it restarts itself after its ` +
        "current cycle, or `sc watch --ensure` restarts it" };
  }
  return { running: true, current: true, problem: null };
}

function pid(): number | null {
  try {
    const n = Number(strip(readText(path.join(stateDir(), "watch.pid"))));
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function beat(): string | null {
  try {
    return readText(path.join(stateDir(), "watch.beat"));
  } catch {
    return null;
  }
}

async function wait(condition: () => boolean | Promise<boolean>, seconds: number): Promise<boolean> {
  const deadline = realNow() + seconds;
  while (realNow() < deadline) {
    if (await condition()) return true;
    await sleep(0.1);
  }
  return condition();
}

/**
 * Make sure a watcher runs the code on disk: start one, or replace one running older code.
 *
 * Returns {running, note}; the note says what was done or what is wrong, for
 * `sc watch --ensure` and the startup summary.
 *
 * Replacing is careful not to lose state or double up. A watcher that checks its
 * own code gets one cycle to restart itself. Otherwise the old watcher is sent
 * SIGTERM just after it finishes a cycle (its heartbeat changes), when it is
 * asleep with everything written; it stops there, between cycles. Only once its lock
 * is free is a new one started, and the lock guarantees one watcher even if two
 * `ensure`s race. Nothing is ever killed outright: if the old watcher does not finish
 * a cycle or let go of the lock in time, it is left running and the note says so.
 */
export async function ensure(): Promise<{ running: boolean; note: string | null }> {
  if (process.env.SC_WATCH_DISABLE_ENSURE) return { running: true, note: null }; // tests: never start a real watcher
  if (!(await isRunning())) return { running: await start(), note: null };
  const h = await health();
  if (h.current) return { running: true, note: null };
  const info = (or(readJson<Dict>(codePath(), {}), {}) as Dict);
  const poll = Number(or(info.poll, 15));
  const window = poll + 10;
  // All waiting before the SIGTERM fits in 30s, and after it in 10s, so that with
  // starting the new watcher (15s) this stays inside the SessionStart hook's 60s timeout.
  const deadline = realNow() + 30;
  if (truthy(info.code) && get(info, "pid", null) === pid()) {
    if (await wait(async () => (await health()).current, Math.min(window, deadline - realNow()))) {
      return { running: true, note: "the watcher was running older code and restarted itself on the new code" };
    }
  }
  const p = pid();
  if (!p) {
    return { running: true, note: `${h.problem}; it could not be replaced because state/watch.pid is missing` };
  }
  const b = beat();
  if (!(await wait(() => beat() !== b, Math.max(0, Math.min(window, deadline - realNow()))))) {
    return { running: true, note: `${h.problem}. It was not replaced: it did not finish a cycle in ` +
      "time, and it is only stopped between cycles. Run `sc watch --ensure` again, and check state/watch.log" };
  }
  try {
    process.kill(p, "SIGTERM");
  } catch {
    // already gone
  }
  if (!(await wait(async () => !(await isRunning()), 10))) {
    return { running: true, note: `${h.problem}. It was asked to stop (pid ${p}) but still holds the ` +
      "lock after 10s, so no second watcher was started" };
  }
  log(`replaced watcher pid ${p}, which was running older code`);
  const ok = await start();
  return { running: ok, note: ok ? "the watcher was running older code, so it was restarted"
    : "the watcher was running older code and was stopped, but the new one failed to start; see state/watch.log" };
}

async function start(): Promise<boolean> {
  startDetached();
  // Running once it has recorded its code (which it does after taking the lock), so
  // that `health` is right straight away. A watcher killed outright leaves a lock that
  // takes up to lock.STALE_MS to free, hence 15s rather than Python's 5s.
  return wait(async () => get((or(readJson<Dict>(codePath(), {}), {}) as Dict), "pid", null) === pid()
    && (await isRunning()), 15);
}
