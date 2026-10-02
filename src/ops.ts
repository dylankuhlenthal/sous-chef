// The operations behind the commands: spawn, send, report, stop, resume, mark, cleanup.

import fs from "node:fs";
import path from "node:path";
import * as chef from "./chef.js";
import * as events from "./events.js";
import * as inbox from "./inbox.js";
import * as kinds from "./kinds.js";
import { run } from "./proc.js";
import { JSONDecodeError } from "./pyjson.js";
import { Dict, expanduser, isDir, isUnder, readText, resolvePath, shellQuote, sorted, strip, truthy } from "./py.js";
import * as records from "./records.js";
import { Rec } from "./records.js";
import { printErr } from "./io.js";
import * as runtimes from "./runtimes/index.js";
import { Runtime, WakeError } from "./runtimes/index.js";
import {
  archiveDir, chefPermissionsProblem, CODE_ROOT, envFloat, home, mkdirs, now, owner, ownerName, ownerPath, ownerProblem, ownerText, readJson, render, requireOwner, scBin, SCError, sleep, templatesDir, userKindsDir, WAITING_VALUES as UTIL_WAITING_VALUES, writeJson,
} from "./util.js";
import type { Owner } from "./util.js";
import * as worktrees from "./worktrees.js";

export const WAITING_VALUES = UTIL_WAITING_VALUES;

export interface OwnerChange {
  name?: string | null;
  branchPrefix?: string | null;
  chefPermissions?: string | null;
}

/**
 * Write owner.json (util.owner), changing only the fields given. Without a usable owner.json
 * it needs both the name and the branch prefix. Refuses a name that would read as another
 * waiting-on value, and a permission mode sous chef's own session cannot have. A file
 * without a usable chef_permissions keeps none unless one is given (none means the default).
 */
export function setOwner(change: OwnerChange): Owner | null {
  // The fields already stored that are still usable, even when another field is not, so one
  // bad field can be fixed on its own.
  let stored: Dict = {};
  try {
    const data = readJson<unknown>(ownerPath());
    if (data && typeof data === "object" && !Array.isArray(data)) stored = data as Dict;
  } catch (e) {
    if (!(e instanceof JSONDecodeError)) throw e;
  }
  const usable = ownerProblem(stored.name, stored.branch_prefix) === null;
  const given = (v: string | null | undefined): v is string => v !== null && v !== undefined;
  if (!usable && !(given(change.name) && given(change.branchPrefix))) throw new SCError(OWNER_SET_USAGE);
  const name = strip(given(change.name) ? change.name : (stored.name as string));
  const branchPrefix = given(change.branchPrefix) ? change.branchPrefix : (stored.branch_prefix as string);
  const problem = ownerProblem(name, branchPrefix) ??
    (given(change.chefPermissions) ? chefPermissionsProblem(change.chefPermissions) : null);
  if (problem) throw new SCError(problem);
  const data: Dict = { name, branch_prefix: branchPrefix };
  if (given(change.chefPermissions)) data.chef_permissions = change.chefPermissions;
  else if (chefPermissionsProblem(stored.chef_permissions) === null) data.chef_permissions = stored.chef_permissions;
  writeJson(ownerPath(), data);
  return owner();
}

export const OWNER_SET_USAGE = "usage: sc owner set [--name <name>] [--branch-prefix <prefix>] " +
  "[--chef-permissions auto|bypass]; with no owner yet, --name and --branch-prefix are both needed";

// Hook commands run Node by its absolute path, then sc by its absolute path: a hook may not
// get the terminal's PATH, and Node here usually comes from nvm or Homebrew. The hooks that
// still find Node through PATH: docs/operations/running.md, "Known limit: hooks find Node
// through PATH".
function hook(name: string, sid: string): Dict {
  const cmd = `${shellQuote(process.execPath)} ${shellQuote(scBin())} hook ${name} --session ${shellQuote(sid)}`;
  return { hooks: [{ type: "command", command: cmd, timeout: 30 }] };
}

/**
 * Settings every spawned session runs with, passed at launch (never written into repos).
 *
 * A session in a worktree sous chef created for it (rec.own_worktree) may edit
 * there directly, so Claude Code's background worktree isolation is turned off
 * for that session only. Every other session keeps Claude Code's default.
 */
export function workerSettings(rec: Dict): Dict {
  const sid = rec.id as string;
  const guard = hook("guard-edit", sid);
  guard.matcher = "Edit|Write|MultiEdit|NotebookEdit";
  const settings: Dict = {
    hooks: {
      SessionStart: [hook("worker-start", sid)],
      UserPromptSubmit: [hook("worker-prompt", sid)],
      Stop: [hook("worker-stop", sid)],
      // The same guard sous chef runs, so a session cannot hand-edit any session's
      // records. Its own report file is the one allowed path (hooks.guardEdit).
      PreToolUse: [guard],
    },
  };
  if (truthy(rec.own_worktree)) settings.worktree = { bgIsolation: "none" };
  return settings;
}

/**
 * Best-effort environment for a session: only PATH, so a bare `sc` usually works.
 *
 * Nothing may depend on it. Claude Code can start a background session in a spare
 * process created with an earlier launch's environment, so identity and paths
 * reach the session through its brief, its hooks and CLAUDE_CODE_SESSION_ID instead.
 */
export function workerEnv(_sid: string): Record<string, string> {
  const binDir = path.dirname(scBin());
  const p = process.env.PATH ?? "";
  return { PATH: p.split(":").includes(binDir) ? p : `${binDir}:${p}` };
}

export const WORKER_INSTRUCTIONS = "worker-instructions.md";

/**
 * The owner's instructions for every session (worker-instructions.md in the data folder) as a
 * brief section, or "" when there is no such file or nothing in it but comments. Never filled in.
 */
function ownerInstructionsSection(): string {
  const text = ownerText(path.join(home(), WORKER_INSTRUCTIONS));
  return text ? `## Instructions from your owner\n\n${text}\n\n` : "";
}

function renderBrief(rec: Rec, kind: kinds.Kind, task: string): string {
  const template = readText(path.join(templatesDir(), "worker-brief.md"));
  const ownerName_ = requireOwner().name;
  const values: Record<string, string> = {
    owner: ownerName_,
    id: rec.id,
    sc: scBin(),
    kind: rec.kind,
    title: rec.title,
    cwd: rec.cwd,
    report_path: path.join(records.sessionDir(rec.id), "report.md"),
    worktree_note: truthy(rec.own_worktree)
      ? "This directory is a git worktree sous chef created for this task, on its own branch. " +
        "Work here directly; do not create or enter another worktree."
      : "This directory was not created for this task, so others may be using it. If the task " +
        "needs to change files, Claude Code may require you to enter a worktree first; follow it.",
    kind_instructions: render(kind.body, { owner: ownerName_ }),
    owner_instructions: ownerInstructionsSection(),
    task: strip(task),
  };
  return render(template, values);
}

/** The resolved working directory for a session, or a refusal saying why it cannot be one. */
export function checkCwd(cwd: string): string {
  const cwdPath = resolvePath(expanduser(cwd));
  if (!isDir(cwdPath)) throw new SCError(`working directory does not exist: ${cwdPath}`);
  const roots: [string, string][] = [
    [resolvePath(CODE_ROOT), "code folder: it would load sous chef's own instructions and hooks"],
    [resolvePath(home()), "data folder: its files are sous chef's own records and memory"],
  ];
  for (const [root, why] of roots) {
    if (cwdPath === root || isUnder(cwdPath, root)) {
      throw new SCError(`a session cannot run inside the sous chef ${why}`);
    }
  }
  return cwdPath;
}

/**
 * Refuse when the kind's skill is definitely not available to a session of this runtime in `cwd`.
 *
 * Only a definite "missing" (false) refuses; a runtime that cannot tell (null) lets it through.
 */
export async function checkSkill(kind: kinds.Kind, rt: Runtime, cwd: string): Promise<void> {
  const skill = kind.skill;
  if (!skill || (await rt.skillAvailable(skill, String(cwd))) !== false) return;
  const places = rt.skillPlaces(String(cwd));
  const looked = places.length > 1 ? places.slice(0, -1).join(", ") + ` and ${places[places.length - 1]}`
    : places[0];
  // While the user kinds folder is the core's (kinds.folders), there is nowhere separate to
  // put a replacement, so the way round it is to change the kind file itself.
  const fix = kinds.separateUserKinds() ? `add your own version of the kind in ${userKindsDir()}`
    : `change the kind file ${kind.path}`;
  throw new SCError(`kind '${kind.name}' needs the skill '${skill}', which is not in your skills ` +
    `(looked in ${looked}). Install it, or ${fix}.`);
}

export interface SpawnOptions {
  thread?: string | null;
  model?: string | null;
  effort?: string | null;
  runtime?: string | null;
  cron?: Dict | null;
  permissions?: string | null;
}

/**
 * Launch a session. `cron` ({job: name}) marks one a scheduled job launched (cron.ts).
 *
 * `permissions` is one of runtimes.PERMISSIONS, recorded so that it is visible later;
 * null means the kind's own `permissions`, and if it sets none, runtimes.DEFAULT_PERMISSIONS.
 */
export async function spawn(kindName: string, title: string, cwd: string, task: string, opts: SpawnOptions = {}):
  Promise<Rec> {
  requireOwner();
  const kind = kinds.load(kindName);
  if (!task || !strip(task)) throw new SCError("the task text is empty; pass it on stdin or with --task-file");
  const permissions = opts.permissions || kind.permissions || runtimes.DEFAULT_PERMISSIONS;
  if (!Object.hasOwn(runtimes.PERMISSIONS, permissions)) {
    throw new SCError(`unknown permissions '${permissions}' (use one of: ${Object.keys(runtimes.PERMISSIONS).join(", ")})`);
  }
  const cwdPath = checkCwd(cwd);
  const rt = runtimes.get(opts.runtime || runtimes.DEFAULT);
  await checkSkill(kind, rt, cwdPath);
  const sid = records.newId(kind.name, title);
  const rec: Rec = {
    id: sid, kind: kind.name, title, cwd: cwdPath, runtime: rt.NAME,
    created_at: now(), thread: opts.thread ?? null, model: opts.model ?? null, effort: opts.effort ?? null,
    permissions, handle_name: `sc-${sid}`, handle: null, stopped_by_sc: false,
  };
  if (opts.cron) rec.cron = opts.cron;
  rec.own_worktree = await worktrees.claimFor(cwdPath, sid);
  records.save(rec);
  const briefPath = path.join(records.sessionDir(sid), "brief.md");
  fs.writeFileSync(briefPath, renderBrief(rec, kind, task));
  await events.append(sid, "sc", "launched", `${kind.name}: ${title}`, null, kind.starts_waiting_on);
  const prompt = `You were launched by sous chef as session ${sid}. Read your full instructions at ` +
    `${briefPath} now and follow them.`;
  try {
    rec.handle = await rt.launch(rec, prompt, workerEnv(sid), workerSettings(rec));
  } catch (e) {
    if (!(e instanceof SCError)) throw e;
    await events.append(sid, "sc", "failed", `launch failed: ${e.message}`, null, "nobody");
    await worktrees.release(sid);
    throw e;
  }
  records.save(rec);
  return rec;
}

export interface SendOptions {
  resolves?: string | null;
  sender?: string;
  onlyIfIdle?: boolean;
}

/**
 * Save a message in a session's inbox and wake it. Returns [message, why it was not woken or null].
 *
 * With `onlyIfIdle`, a session that is mid-turn (or whose state is unknown) is not
 * woken: the message waits, and the watcher wakes the session once it is idle.
 */
export async function send(rec: Rec, text: string, opts: SendOptions = {}): Promise<[inbox.Message, string | null]> {
  const sid = rec.id;
  const resolves = opts.resolves ?? null;
  if (!strip(text)) throw new SCError("empty message");
  if (resolves) {
    const openKeys = new Set(events.openQuestions(events.readAll(sid)).map((q) => q.key!));
    if (!openKeys.has(resolves)) {
      throw new SCError(`${sid} has no open question with key '${resolves}' ` +
        `(open: ${sorted(openKeys).join(", ") || "none"})`);
    }
  }
  const msg = await inbox.write(sid, text, opts.sender ?? "sous chef", resolves);
  if (resolves) await events.append(sid, "sc", "resolved", `answered in inbox message ${msg.seq}`, resolves);
  const rt = runtimes.get(rec.runtime);
  if (opts.onlyIfIdle && (await rt.status(rec)).busy !== false) {
    return [msg, "the session is mid-turn, so the watcher wakes it once it is idle"];
  }
  try {
    await rt.wake(rec, `sous chef: new message ${msg.seq} in your inbox. Run \`sc inbox\`, act on it, ` +
      `then run \`sc inbox ack ${msg.seq}\`.`);
    return [msg, null];
  } catch (e) {
    if (e instanceof WakeError) return [msg, e.message]; // the message is saved; this says why nobody was woken
    throw e;
  }
}

/**
 * The session calling `sc report` or `sc inbox`, from the Claude session id Claude Code sets.
 *
 * Never from a variable sous chef passes at launch (see workerEnv). Right after
 * launch the record may not have its Claude id yet, so this waits briefly for it.
 */
export async function currentSessionRecord(): Promise<Rec> {
  const claudeSid = process.env.CLAUDE_CODE_SESSION_ID;
  if (!claudeSid) {
    throw new SCError("this command only works inside a Claude Code session launched by sous chef " +
      "(CLAUDE_CODE_SESSION_ID is not set)");
  }
  const deadline = Date.now() / 1000 + envFloat("SC_IDENTITY_WAIT", 25);
  let rec: Rec | null;
  for (;;) {
    rec = records.findByClaudeSession(claudeSid);
    if (rec || Date.now() / 1000 >= deadline) break;
    await sleep(1);
  }
  if (!rec) {
    throw new SCError(`this Claude session (${claudeSid.slice(0, 8)}) is not one sous chef launched, ` +
      "so there is no log to report to");
  }
  return rec;
}

export async function report(state: string, text: string, key: string | null = null): Promise<events.Event> {
  const rec = await currentSessionRecord();
  if (!Object.hasOwn(events.SESSION_STATES, state)) {
    throw new SCError(`unknown state '${state}' (use one of: ${Object.keys(events.SESSION_STATES).join(", ")})`);
  }
  if (state === "resolved" && !key) throw new SCError("resolved needs --key naming the question it closes");
  if (!strip(text) && state !== "resolved") throw new SCError("say what happened: the report text is empty");
  if (state === "note" && events.READS_AS_QUESTION.test(text)) {
    throw new SCError(
      "this reads like a question, and a question reported as a note does not exist: " +
      "it never wakes sous chef and never shows as an open question, so nobody learns " +
      "you are waiting. Report it with:\n" +
      '  sc report needs-decision "<the question, the options, your recommendation>"\n' +
      "which prints a key sous chef answers with `sc send --resolves <key>`. " +
      "Put the whole question in that command, not a summary pointing somewhere else.");
  }
  if (state === "nothing-new" && !truthy(rec.cron)) {
    throw new SCError("nothing-new is only for sessions a scheduled job launched. " +
      'Report what came out of the task with `sc report done "..."`.');
  }
  if (state === "resolved") {
    const openKeys = new Set(events.openQuestions(events.readAll(rec.id)).map((q) => q.key!));
    if (!openKeys.has(key!)) {
      throw new SCError(`no open question with key '${key}' (open: ${sorted(openKeys).join(", ") || "none"})`);
    }
  }
  const event = await events.append(rec.id, "session", state, text, key);
  if (events.WAKE_STATES.has(state)) {
    event.woke_sous_chef = await chef.wakeChef(`sous chef: session ${rec.id} reported ${state}. Run \`sc events\`.`);
  }
  // Best effort: a runtime that keeps a status of its own (the Claude runtime: Porch's self
  // status) is told too. The event above is the record; this never changes the outcome.
  // A failure's message is the runtime's own line.
  const rt = runtimes.get(rec.runtime);
  if (rt.reportStatus) {
    try {
      await rt.reportStatus(rec, state, text);
    } catch (e) {
      printErr(e instanceof Error ? e.message : String(e));
    }
  }
  return event;
}

export async function stop(rec: Rec): Promise<void> {
  await runtimes.get(rec.runtime).stop(rec);
  rec.stopped_by_sc = true;
  records.save(rec);
  await events.append(rec.id, "sc", "stopped", "stopped by sous chef");
}

/**
 * Start a stopped session again. Refuses one that is running, which would risk two copies of it.
 *
 * A session that could not be checked is refused too: the runtime's error says why.
 * `author`, `state` and `text` are the event it appends: the watcher resuming a
 * session itself records `auto-resumed` (watch.ts, check 1). Returns that event.
 */
export async function resume(rec: Rec, author = "sc", state = "resumed", text = "resumed by sous chef"):
  Promise<events.Event> {
  const rt = runtimes.get(rec.runtime);
  if ((await rt.status(rec)).alive) {
    throw new SCError(`${rec.id} is already running, so it was not resumed: resuming it could start ` +
      `a second copy. Message it with \`sc send ${rec.id} "..."\`, check it with ` +
      `\`sc status ${rec.id}\`, or open it with \`${rt.attachCommand(rec)}\`.`);
  }
  await rt.resume(rec, workerEnv(rec.id), workerSettings(rec));
  rec.stopped_by_sc = false;
  records.save(rec);
  return events.append(rec.id, author, state, text);
}

/** A waiting-on value as typed (`owner`, or the owner's name in any case) as stored, or a refusal. */
export function waitingValue(value: string): string {
  const o = owner();
  if (o && value.toLowerCase() === o.lower) return "owner";
  if (WAITING_VALUES.has(value)) return value;
  const ownerShown = o ? `owner (or ${o.lower})` : "owner";
  const others = sorted([...WAITING_VALUES].filter((v) => v !== "owner")).join(", ");
  throw new SCError(`waiting-on must be one of: ${ownerShown}, ${others}`);
}

export async function mark(rec: Rec, waitingOn: string, text: string): Promise<events.Event> {
  return events.append(rec.id, "sc", "marked", text, null, waitingValue(waitingOn));
}

function git(cwd: string, ...args: string[]) {
  return run("git", ["-C", cwd, ...args]);
}

/** Reasons the session's working directory may hold work that is not safe to walk away from. */
export async function unlandedWork(cwd: string): Promise<string[]> {
  if ((await git(cwd, "rev-parse", "--is-inside-work-tree")).code !== 0) return [];
  const reasons: string[] = [];
  const st = await git(cwd, "status", "--porcelain");
  if (strip(st.stdout)) reasons.push(`uncommitted changes in ${cwd}`);
  const ahead = await git(cwd, "rev-list", "--count", "HEAD", "--not", "--remotes");
  if (ahead.code === 0 && !["", "0"].includes(strip(ahead.stdout))) {
    reasons.push(`${strip(ahead.stdout)} commit(s) on the current branch that no remote has`);
  }
  return reasons;
}

export async function cleanup(rec: Rec, force = false): Promise<void> {
  if (!force) {
    const ownerShown = ownerName();
    const reasons = await unlandedWork(rec.cwd);
    if (reasons.length) {
      throw new SCError("refusing to clean up: " + reasons.join("; ") +
        `. These may be ${ownerShown}'s own changes. Check first, then use --force ` +
        `only if ${ownerShown} agreed.`);
    }
  }
  const rt = runtimes.get(rec.runtime);
  if ((await rt.status(rec)).alive) await stop(rec);
  await worktrees.release(rec.id);
  const dest = path.join(archiveDir(), rec.id);
  mkdirs(path.dirname(dest));
  moveDir(records.sessionDir(rec.id), dest);
  await events.forget(rec.id);
}

/** shutil.move for a folder: a rename, or copy and delete across file systems. */
function moveDir(src: string, dest: string): void {
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}
