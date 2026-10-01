// Scheduled jobs (cron), fired by the watcher while sous chef is running.
//
// A job's definition is configuration: cron/<name>.md in the owner's data folder
// (my/cron/), kept and synced with it like memory. Front matter, then the task:
//
//   ---
//   at: 09:00, 16:00          (or: every: 6h)
//   target: chef              (chef, or worker for a spawned session)
//   kind: general             (worker only, and cwd, title, model, effort, thread)
//   cwd: ~/some/folder
//   memory: memory/email.md   (either target: the memory file holding the job's context;
//                              `sc events` prints its `## Slack me` section under the job's events)
//   ---
//   <the task text>
//
// What happened when it ran is runtime state: state/cron/runs.json, written only
// here. The definition is kept apart from it so a synced definition never carries
// one machine's run history to another, and so `state/` stays sc's alone.
//
// Firing a job sends its task to the target as a message, the way messages already
// travel: written to disk first, then the target is woken if it is idle, or left to
// pick the message up when its current turn ends (see `fire`). A job has no setting
// for this; it depends only on what the target is doing when the job fires.
//
// Rules (docs/domains/cron.md explains why):
// - Nothing fires while the registered sous chef session is not running.
// - Every firing is delivered, even when an earlier one is still unread.
// - Missed firings fire once, not once per miss.
// - A new job, or one this machine has no run record for, waits for its next slot.
//
// Local times (`at` slots, `sc cron list`) use the process's time zone, so TZ is honoured.

import fs from "node:fs";
import path from "node:path";
import * as chef from "./chef.js";
import * as events from "./events.js";
import * as kinds from "./kinds.js";
import { withLock } from "./lock.js";
import * as ops from "./ops.js";
import { Dict, exists, get, glob, isDir, isFile, or, readText, stem, strip, truthy } from "./py.js";
import * as records from "./records.js";
import * as runtimes from "./runtimes/index.js";
import { home, now, readJson, render, requireOwner, SCError, stateDir, templatesDir, writeJson } from "./util.js";
import * as watch from "./watch.js";

export const TARGETS = ["chef", "worker"];
export const WORKER_FIELDS = ["kind", "cwd", "title", "model", "effort", "thread"];
// Python's re.match with `$`, which also matches before a final newline.
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*(?=\n?$)/;
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)(?=\n?$)/;
const EVERY = /^(\d+)([mhd])(?=\n?$)/;
const UNIT: Record<string, number> = { m: 60, h: 3600, d: 86400 };
const MEMORY_FILE = /^memory\/([A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.md(?=\n?$)/;

export interface Job extends Dict {
  name: string;
  target: string;
  task: string;
  at_times: string[] | null;
  every_secs: number | null;
}

export type Run = Dict;

export function jobsDir(): string {
  return path.join(home(), "cron");
}

function runsPath(): string {
  return path.join(stateDir(), "cron", "runs.json");
}

function runsLock(): string {
  return path.join(stateDir(), "cron", ".runs.lock");
}

export function runs(): Record<string, Run> {
  return or(readJson<Record<string, Run>>(runsPath(), {}), {}) as Record<string, Run>;
}

// --- definitions -------------------------------------------------------------

export function parseAt(text: string): string[] {
  const times = text.split(",").map((t) => strip(t)).filter(Boolean);
  if (!times.length) throw new SCError("`at` needs one or more times, e.g. 09:00, 16:00");
  const out = new Set<string>();
  for (const t of times) {
    const m = TIME.exec(t);
    if (!m) throw new SCError(`'${t}' is not a time of day; use 24-hour HH:MM, e.g. 09:00`);
    out.add(`${String(Number(m[1])).padStart(2, "0")}:${m[2]}`);
  }
  return [...out].sort();
}

export function parseEvery(text: string): number {
  const m = EVERY.exec(strip(text));
  if (!m || Number(m[1]) === 0) {
    throw new SCError(`'${text}' is not an interval; use a number with m, h or d, e.g. 30m, 6h, 1d`);
  }
  return Number(m[1]) * UNIT[m[2]!]!;
}

/** Check a definition and fill in what firing needs. Throws SCError naming the problem. */
export function validate(job: Dict): Job {
  const name = get<string>(job, "name", "");
  if (!NAME.test(name)) throw new SCError(`job name '${name}' must be lowercase kebab-case, e.g. email-check`);
  if (truthy(job.at) === truthy(job.every)) {
    throw new SCError(`job ${name}: give exactly one schedule, \`at\` (times of day) or \`every\` (an interval)`);
  }
  job.at_times = truthy(job.at) ? parseAt(job.at as string) : null;
  job.every_secs = truthy(job.every) ? parseEvery(job.every as string) : null;
  if (!TARGETS.includes(job.target as string)) throw new SCError(`job ${name}: target must be chef or worker`);
  if (!strip((or(job.task, "") as string))) throw new SCError(`job ${name}: the task text is empty`);
  if (truthy(job.memory) && (!MEMORY_FILE.test(job.memory as string)
      || (job.memory as string).split("/").some((part) => part === "." || part === ".."))) {
    throw new SCError(`job ${name}: memory must name a file under memory/, e.g. memory/${name}.md`);
  }
  if (job.target === "chef") {
    const extra = [...WORKER_FIELDS, "runtime"].filter((f) => truthy(job[f]));
    if (extra.length) {
      throw new SCError(`job ${name}: ${extra.join(", ")} only apply to a worker job; ` +
        "a chef job is done by sous chef itself");
    }
  } else {
    if (!truthy(job.kind) || !truthy(job.cwd)) {
      throw new SCError(`job ${name}: a worker job needs a kind and a cwd, as \`sc spawn\` does`);
    }
    kinds.load(job.kind as string);
    ops.checkCwd(job.cwd as string);
  }
  return job as Job;
}

export function scheduleText(job: Job): string {
  return truthy(job.at_times) ? `at ${job.at_times!.join(", ")}` : `every ${job.every as string}`;
}

function jobPath(name: string): string {
  return path.join(jobsDir(), `${name}.md`);
}

export function load(name: string): Job {
  const p = jobPath(name);
  if (!isFile(p)) throw new SCError(`no cron job '${name}' (see: sc cron list)`);
  const [meta, body] = kinds.parse(readText(p));
  return validate({ ...meta, name, task: body });
}

export function names(): string[] {
  return isDir(jobsDir()) ? glob(jobsDir(), ".md").map(stem).sort() : [];
}

/** [valid jobs, {name: problem}] for every definition file. */
export function allJobs(): [Job[], Record<string, string>] {
  const jobs: Job[] = [];
  const broken: Record<string, string> = {};
  for (const name of names()) {
    try {
      jobs.push(load(name));
    } catch (e) {
      if (!(e instanceof SCError)) throw e;
      broken[name] = e.message;
    }
  }
  return [jobs, broken];
}

export async function add(input: Dict): Promise<Job> {
  const job = validate({ ...input });
  if (job.target === "worker") {
    // Checked here, not in validate, so listing and firing jobs never depend on skills.
    // At fire time a missing skill is refused by ops.spawn and shows as a `failed` cron event.
    await ops.checkSkill(kinds.load(job.kind as string), runtimes.get((job.runtime as string) || runtimes.DEFAULT),
      ops.checkCwd(job.cwd as string));
  }
  if (exists(jobPath(job.name))) {
    throw new SCError(`a cron job named ${job.name} already exists; \`sc cron remove\` it first`);
  }
  const fields = ["at", "every", "target", ...WORKER_FIELDS, "memory", "runtime"];
  const head = fields.filter((f) => truthy(job[f])).map((f) => `${f}: ${String(job[f])}\n`).join("");
  fs.mkdirSync(path.dirname(jobPath(job.name)), { recursive: true });
  fs.writeFileSync(jobPath(job.name), `---\n${head}---\n${strip(job.task)}\n`);
  await withLock(runsLock(), () => {
    const data = runs();
    data[job.name] = { since: now() };
    writeJson(runsPath(), data);
  });
  return job;
}

export async function remove(name: string): Promise<void> {
  const p = jobPath(name);
  if (!isFile(p)) throw new SCError(`no cron job '${name}' (see: sc cron list)`);
  fs.unlinkSync(p);
  await withLock(runsLock(), () => {
    const data = runs();
    if (Object.hasOwn(data, name)) {
      const was = data[name];
      delete data[name];
      if (was !== null && was !== undefined) writeJson(runsPath(), data);
    }
  });
}

// --- schedule ----------------------------------------------------------------

/** Times of day as epoch seconds, local time, from yesterday to tomorrow. */
function slotsAround(job: Job, t: number): number[] {
  const out: number[] = [];
  for (const day of [-1, 0, 1]) {
    const d = new Date((t + day * 86400) * 1000);
    for (const at of job.at_times!) {
      const [hh, mm] = at.split(":").map(Number) as [number, number];
      out.push(new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0).getTime() / 1000);
    }
  }
  return out.sort((a, b) => a - b);
}

function base(run: Run, t: number): number {
  return (or(or(run.last_due, run.since), t)) as number;
}

/** The most recent moment the job was due, at or before now; null if never. */
export function latestSlot(job: Job, run: Run, t: number): number | null {
  if (truthy(job.at_times)) {
    const past = slotsAround(job, t).filter((s) => s <= t);
    return past.length ? past[past.length - 1]! : null;
  }
  const b = base(run, t);
  return t >= b + job.every_secs! ? b + job.every_secs! : null;
}

export function nextSlot(job: Job, run: Run, t: number): number {
  if (truthy(job.at_times)) return slotsAround(job, t).find((s) => s > t)!;
  const b = base(run, t);
  return Math.max(b + job.every_secs!, t);
}

/**
 * Due when a slot has passed since the last one handled (or since this machine first saw the job).
 *
 * Only the latest slot is compared, so any number of missed slots makes the job
 * due once, not once per miss.
 */
export function isDue(job: Job, run: Run, t: number): boolean {
  const slot = latestSlot(job, run, t);
  return slot !== null && slot > base(run, t);
}

/** "%a %d %b %H:%M %Z" for a local time, as Python's time.strftime prints it. */
export function localTimeText(ts: number): string {
  const d = new Date(ts * 1000);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  // The zone's short name as the platform gives it: "UTC", "GMT+2" (Python printed "SAST" there).
  const zone = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(d)
    .find((x) => x.type === "timeZoneName")?.value ?? "";
  return `${days[d.getDay()]} ${p(d.getDate())} ${months[d.getMonth()]} ${p(d.getHours())}:${p(d.getMinutes())} ${zone}`;
}

// --- firing ------------------------------------------------------------------

function message(job: Job): string {
  return `cron job ${job.name}: ${strip(job.task)}`;
}

function workerTask(job: Job): string {
  let note = readText(path.join(templatesDir(), "cron-worker.md"));
  note = render(note, { job: job.name, owner: requireOwner().name });
  return `${strip(job.task)}\n\n${strip(note)}`;
}

/** The job's previous session, if it is still running and has not finished. */
async function inFlight(run: Run): Promise<records.Rec | null> {
  const sid = run.session as string | undefined;
  if (!sid || !records.allIds().includes(sid)) return null;
  const rec = records.load(sid);
  if (events.waitingOn(events.readAll(sid)) === "nobody") return null;
  return (await runtimes.get(rec.runtime).status(rec)).alive ? rec : null;
}

/**
 * Deliver one firing of a job and say what happened. Updates `run` in place.
 *
 * The job's message goes to its target the way any message does: written to disk,
 * and the target woken if it is idle or left to pick it up when its turn ends.
 * - chef: a `due` event in the cron log; the watcher wakes sous chef once it is idle.
 * - worker, previous run still in flight: the message goes to that session's inbox.
 * - worker, otherwise: a new session is launched with the task as its brief.
 * Every firing is delivered, even when an earlier one is still unread, so messages
 * can stack up; each is visible and none is lost.
 */
export async function fire(job: Job, run: Run): Promise<string> {
  const t = now();
  const name = job.name;
  if (job.target === "chef") {
    const e = await events.append(events.CRON_LOG, "cron", "due", message(job), null, null, { job: name });
    Object.assign(run, { last_fired: t, session: null, last_result: `wrote due as cron event #${e.seq} for sous chef` });
    return run.last_result as string;
  }
  let rec = await inFlight(run);
  if (rec) {
    const [msg, problem] = await ops.send(rec, message(job) + "\n\nThis is the next scheduled run of the job you were " +
      "launched for. Finish what you are doing first.", { sender: `cron job ${name}`, onlyIfIdle: true });
    const where = `inbox message ${msg.seq} for ${rec.id}, which is still on an earlier run`;
    Object.assign(run, { last_fired: t,
      last_result: problem ? `wrote ${where}; it was not woken: ${problem}` : `wrote ${where}, and woke it` });
    return run.last_result as string;
  }
  try {
    rec = await ops.spawn(job.kind as string, (job.title as string) || name, job.cwd as string, workerTask(job), {
      thread: (job.thread as string) ?? null, model: (job.model as string) ?? null,
      effort: (job.effort as string) ?? null, runtime: (job.runtime as string) ?? null, cron: { job: name } });
  } catch (e) {
    if (!(e instanceof SCError)) throw e;
    const f = await events.append(events.CRON_LOG, "cron", "failed",
      `cron job ${name} could not launch its session: ${e.message}`, null, null, { job: name });
    Object.assign(run, { last_fired: t, session: null,
      last_result: `could not launch a session (${e.message}); wrote failed as cron event #${f.seq} for sous chef` });
    return run.last_result as string;
  }
  Object.assign(run, { last_fired: t, session: rec.id,
    last_result: `launched ${rec.id}, which starts on the task now ` +
      `(attach: ${runtimes.get(rec.runtime).attachCommand(rec)})` });
  return run.last_result as string;
}

/**
 * `sc cron run`: fire a job now, outside its schedule, and say what happened.
 *
 * Its next scheduled slot is unchanged. Unlike the watcher, it fires even when sous
 * chef is not running, because someone asked for it by hand.
 */
export async function runNow(name: string): Promise<string> {
  const job = load(name);
  let out = await withLock(runsLock(), async () => {
    const data = runs();
    const run = (data[name] ??= { since: now() });
    const result = await fire(job, run);
    writeJson(runsPath(), data);
    return result;
  });
  if (out.includes("cron event #")) out += ".\n" + (await chefWakeNote());
  return out;
}

/** Whether and when sous chef is woken for a cron event: the watcher does it, not `sc cron run`. */
async function chefWakeNote(): Promise<string> {
  if (!(await watch.isRunning())) {
    return "Nobody was woken, and nobody will be: the watcher is not running (`sc watch --ensure`). " +
      "Sous chef sees the event in `sc events` or at its next start.";
  }
  const st = await chef.status();
  if (!st.alive) {
    return "Nobody was woken: sous chef is not running. It sees the event in `sc events` or at its next start.";
  }
  if (st.busy === false) {
    return "Sous chef was not woken by this command; it is idle, so the watcher wakes it within one cycle (15s).";
  }
  return "Sous chef was not woken: it is mid-turn (or its state is unknown), so the watcher wakes it once it is idle.";
}

/** Archive a job's session once it reported nothing-new, so empty runs leave nothing behind. */
async function archiveEmptyWorkers(data: Record<string, Run>, actions: string[]): Promise<void> {
  for (const [name, run] of Object.entries(data)) {
    const sid = run.session as string | undefined;
    if (!sid || !records.allIds().includes(sid) || run.archive_refused === sid) continue;
    const last = events.lastSessionEvent(events.readAll(sid));
    if (!last || last.state !== "nothing-new") continue;
    try {
      await ops.cleanup(records.load(sid));
      run.last_result = `nothing new (${sid} archived)`;
      actions.push(`cron ${name}: archived ${sid}, which found nothing new`);
    } catch (e) {
      if (!(e instanceof SCError)) throw e;
      run.archive_refused = sid; // left for sous chef; `sc cron list` shows it
      run.last_result = `nothing new, but ${sid} was not archived: ${e.message}`;
      actions.push(`cron ${name}: could not archive ${sid}: ${e.message}`);
    }
  }
}

/**
 * One watcher cycle's worth of cron: tidy empty runs, then fire what is due.
 *
 * Returns {actions}. Waking sous chef for the cron log is the watcher's job.
 */
export async function tick(): Promise<{ actions: string[] }> {
  const actions: string[] = [];
  const [jobs, broken] = allJobs();
  if (!jobs.length && !Object.keys(broken).length && !exists(runsPath())) {
    return { actions }; // cron was never used here
  }
  await withLock(runsLock(), async () => {
    const data = runs();
    const t = now();
    const jobNames = new Set(jobs.map((j) => j.name));
    for (const name of Object.keys(data)) {
      if (!jobNames.has(name) && !Object.hasOwn(broken, name)) delete data[name]; // removed or renamed by hand
    }
    await archiveEmptyWorkers(data, actions);
    for (const job of jobs) {
      if (!Object.hasOwn(data, job.name)) data[job.name] = { since: t }; // first seen here: wait for the next slot
    }
    let due = jobs.filter((j) => isDue(j, data[j.name]!, t));
    if (due.length && !(await chef.liveIncumbent())) {
      // The owner's rule: jobs run only while sous chef does. Nothing is marked handled,
      // so each of these fires once when sous chef is back. Said once, not every cycle.
      for (const job of due) {
        if (!truthy(data[job.name]!.held)) {
          data[job.name]!.held = true;
          actions.push(`cron ${job.name}: due, but sous chef is not running; it fires when it is`);
        }
      }
      due = [];
    }
    for (const job of due) {
      const run = data[job.name]!;
      run.last_due = t;
      delete run.held;
      actions.push(`cron ${job.name}: ${await fire(job, run)}`);
    }
    writeJson(runsPath(), data);
  });
  return { actions };
}
