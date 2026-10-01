// Claude Code hook handlers, run as `sc hook <name>`.
//
// Chef hooks are configured in .agents/settings.json (sous chef's own folder).
// Worker hooks are passed to each spawned session at launch (ops.workerSettings).
//
// A hook must never break the session it runs in: every handler catches its own
// errors, writes them to state/hook-errors.log (in the data folder, or the code
// folder's state/ when there is none), and exits 0. The chef hooks work without a
// data folder: chef-start says how to make one, guard-edit still protects state/.

import fs from "node:fs";
import path from "node:path";
import * as chef from "./chef.js";
import * as context from "./context.js";
import * as inbox from "./inbox.js";
import { print, readStdin } from "./io.js";
import { dumps, JSONDecodeError, loads } from "./pyjson.js";
import { Dict, expanduser, get, isDict, isUnder, resolvePath, strip } from "./py.js";
import * as records from "./records.js";
import * as summary from "./summary.js";
import { CODE_ROOT, homeProblem, iso, now, ownerName, SCError, stateDir } from "./util.js";
import * as watch from "./watch.js";

export interface HookArgs {
  hook_name: string;
  session?: string | null;
}

async function stdinJson(): Promise<Dict> {
  try {
    const raw = await readStdin();
    if (!strip(raw)) return {};
    const data = loads(raw);
    return isDict(data) ? data : ({} as Dict);
  } catch (e) {
    if (e instanceof JSONDecodeError) return {};
    throw e;
  }
}

function hookContext(event: string, text: string): void {
  print(dumps({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
}

async function chefStart(): Promise<void> {
  const data = await stdinJson();
  const source = get<string>(data, "source", "startup");
  const sessionId = get<string | null>(data, "session_id", null);

  // Every session started in this folder runs this hook, including one spawned
  // into a worktree of this repo and one the owner opens by hand. Only one of them
  // is sous chef: a live registration is never taken from underneath its owner,
  // because wake-ups follow the registration and the loser would go unheard.
  const realHome = await chef.worktreeOfHome();
  if (realHome) {
    hookContext("SessionStart",
      "You are NOT sous chef. This is a git worktree of sous chef's repo; sous chef itself " +
      `runs from ${realHome}. Do the task you were given (your brief says what it is) and ` +
      "leave sessions and memory to sous chef. Report with the absolute `sc` path in your " +
      "brief, which is sous chef's own, so your events reach it. This worktree's own `bin/sc` " +
      "does not reach sous chef's data.");
    return;
  }

  const problem = homeProblem();
  if (problem) {
    hookContext("SessionStart",
      `Sous chef cannot start: it has no data folder (memory, sessions, settings). ${problem}. ` +
      "Tell the person you are working with, and do nothing as sous chef until it is fixed.");
    return;
  }

  const held = await chef.liveIncumbent();
  if (held && sessionId && held.session_id !== sessionId) {
    const owner = ownerName();
    const short = held.session_id.slice(0, 8);
    hookContext("SessionStart",
      `You are NOT sous chef. Session ${short} holds that role and is still ` +
      "running, so it keeps it and receives the wake-ups. Do the task you were given and do " +
      `not manage sessions or memory as sous chef does. If ${short} is wedged ` +
      `and ${owner} wants this session to take over, ${owner} runs \`sc chef --take\` here.`);
    return;
  }

  let prev: chef.ChefInfo | null = null;
  if (sessionId) prev = chef.register(sessionId, process.env.SC_CHEF_RUNTIME || "claude-bg");
  const notes: string[] = [];
  const started = await watch.ensure();
  if (!started.running) notes.push("The watcher could not be started; run `sc watch --ensure` and check state/watch.log.");
  if (started.note) notes.push(`Watcher: ${started.note}.`);
  if (prev && prev.session_id !== sessionId && source === "startup") {
    notes.push(`A different sous chef session (${String(prev.session_id ?? "None").slice(0, 8)}) was registered ` +
      "before this one; it is not running, so this session took over.");
  }
  const header = `SOUS CHEF STARTUP SUMMARY (SessionStart source=${source}). Your conversation may have ` +
    "been compacted or restarted: trust this summary and the files it names over memory.";
  hookContext("SessionStart", [header, ...notes, await summary.build()].join("\n\n"));
}

/**
 * At the end of each of sous chef's turns, check how full its context is (context.ts).
 *
 * Prints nothing: a Stop hook's output can keep the turn going, and this must never
 * interrupt. What it finds goes into the context log and state/context/state.json.
 */
async function chefStop(): Promise<void> {
  if (homeProblem()) return; // nothing to record into; chef-start already said what to fix
  await context.onStop(await stdinJson());
}

async function workerStart(args: HookArgs): Promise<void> {
  const data = await stdinJson();
  const rec = records.load(args.session as string);
  const waiting = inbox.unhandled(rec.id).length;
  const brief = path.join(records.sessionDir(rec.id), "brief.md");
  let text = `You are sous chef session ${rec.id} (${rec.kind}: ${rec.title}). ` +
    `Your instructions are in ${brief}; if they are not in your context ` +
    `(source=${pyStr(get(data, "source", null))}), read them again before continuing.`;
  if (waiting) text += ` There are ${waiting} unhandled message(s) from sous chef: run \`sc inbox\` first.`;
  hookContext("SessionStart", text);
}

function pyStr(x: unknown): string {
  return x === null || x === undefined ? "None" : String(x);
}

async function workerPrompt(args: HookArgs): Promise<void> {
  await records.recordTurn(args.session as string, "last_prompt_at");
}

async function workerStop(args: HookArgs): Promise<void> {
  await records.recordTurn(args.session as string, "last_stop_at");
}

/**
 * Deny file-tool writes under state/: those files belong to `sc` commands.
 *
 * With --session, this is a spawned session, and its own report file is allowed,
 * because that is the deliverable the brief asks it to write.
 */
async function guardEdit(args: HookArgs): Promise<void> {
  const data = await stdinJson();
  const toolInput = (isDict(data.tool_input) && Object.keys(data.tool_input).length ? data.tool_input : {}) as Dict;
  const target = (toolInput.file_path || toolInput.notebook_path) as string | undefined;
  if (!target) return;
  const p = resolvePath(expanduser(String(target)));
  if (args.session) {
    let ownReport: string | null;
    try {
      ownReport = resolvePath(path.join(records.sessionDir(args.session), "report.md"));
    } catch (e) {
      if (!(e instanceof SCError)) throw e;
      ownReport = null;
    }
    if (p === ownReport) return;
  }
  // Protect the state folder of the data folder and of the code folder. The code
  // folder's state/ is where hook errors are logged when there is no data folder (`run`).
  const protectedDirs = [resolvePath(path.join(CODE_ROOT, "state"))];
  try {
    protectedDirs.push(resolvePath(stateDir()));
  } catch (e) {
    if (!(e instanceof SCError)) throw e;
  }
  if (protectedDirs.some((d) => p === d || isUnder(p, d))) {
    print(dumps({ hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Files under state/ are written only by sc commands. " +
        "Use sc (see `sc --help`) instead of editing them.",
    } }));
  }
}

export const HANDLERS: Record<string, (args: HookArgs) => Promise<void>> = {
  "chef-start": chefStart,
  "chef-stop": chefStop,
  "worker-start": workerStart,
  "worker-prompt": workerPrompt,
  "worker-stop": workerStop,
  "guard-edit": guardEdit,
};

export async function run(args: HookArgs): Promise<number> {
  try {
    await HANDLERS[args.hook_name]!(args);
  } catch (e) { // a hook must never fail the session
    try {
      let log: string;
      try {
        log = path.join(stateDir(), "hook-errors.log");
      } catch (err) {
        if (!(err instanceof SCError)) throw err;
        log = path.join(CODE_ROOT, "state", "hook-errors.log");
      }
      fs.mkdirSync(path.dirname(log), { recursive: true });
      const trace = e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : String(e);
      fs.appendFileSync(log, `${iso(now())} ${args.hook_name}\n${trace}\n\n`);
    } catch {
      // nowhere to write it
    }
  }
  return 0;
}
