// `souschef`: open sous chef from any terminal.
//
// Sous chef runs as a Claude Code background session so it keeps running when no
// terminal is attached. `souschef` works out what to do from the session
// registered in state/chef.json and the runtime's live listing:
//
//   registered session running in the background  -> attach to it
//   registered session running in a terminal       -> say where; attaching is not possible
//   registered session exists but is stopped       -> resume it in the background, then attach
//   nothing registered, or it cannot be resumed    -> start a new one, then attach
//
// A new sous chef starts with PERMISSIONS (bypass: nothing ever asks), the owner's
// choice (docs/decisions/0015). A resumed one keeps the mode it was started with,
// so switching an older sous chef over takes `souschef --new`.
//
// `souschef --new` stops the registered background session (its conversation is
// kept) and starts a fresh one. `souschef --print` does everything except attach
// and prints the attach command instead.
//
// The runtime is Claude Code (`claude-bg`). Tests name another with SC_CHEF_RUNTIME
// (the fake runtime), which then provides the same functions: listing, startNamed,
// resumeSessionId, stopShort, attachCommand and attachExec.

import { ArgExit, parse } from "./args.js";
import * as chef from "./chef.js";
import { print, printErr } from "./io.js";
import { Dict, get, truthy } from "./py.js";
import * as runtimes from "./runtimes/index.js";
import { Listing } from "./runtimes/index.js";
import { CODE_ROOT, ownerName, SCError } from "./util.js";

export const SESSION_NAME = "sous-chef";
// sc's permission value for sous chef's own session (runtimes.PERMISSIONS).
export const PERMISSIONS = "bypass";

/**
 * A first message, so the new session has a saved conversation it can later be
 * resumed from (a session that never had a turn cannot be resumed), and so sous
 * chef reads its startup summary before the owner arrives.
 */
export function firstPrompt(): string {
  return "Started by the souschef command. Check your startup summary: if it reports unread events " +
    `or open questions, run \`sc events\` and handle them. Then wait for ${ownerName()}.`;
}

type Decision = ["start", null] | ["attach", string] | ["elsewhere", Dict] | ["resume", string];

/** Pure decision: [action, detail] from the registered chef and the listing. */
export function decide(info: Dict | null, rows: Listing): Decision {
  if (!info || !truthy(info.session_id)) return ["start", null];
  const sid = info.session_id as string;
  const row = Object.hasOwn(rows, sid) ? rows[sid] : undefined;
  if (row && truthy(row.pid)) {
    if (row.kind === "background") return ["attach", (truthy(row.id) ? row.id : sid.slice(0, 8)) as string];
    return ["elsewhere", row];
  }
  return ["resume", sid];
}

/** The runtime sous chef's own session runs on: SC_CHEF_RUNTIME (tests), else Claude Code. */
function runtime(): runtimes.Runtime {
  return runtimes.get(process.env.SC_CHEF_RUNTIME || runtimes.DEFAULT);
}

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (k !== "SC_TEST_HOME" && v !== undefined) out[k] = v;
  return out;
}

function pyStr(x: unknown): string {
  return x === null || x === undefined ? "None" : String(x);
}

export async function main(argv: string[]): Promise<number> {
  let args;
  try {
    args = parse({
      prog: "souschef", description: "Attach to sous chef, resuming or starting it if needed.",
      args: [
        { flags: ["--new"], dest: "new", action: "store_true",
          help: "stop the current background sous chef and start a fresh one" },
        { flags: ["--print"], dest: "print_only", action: "store_true",
          help: "start or resume if needed, then print the attach command instead of attaching" },
      ],
    }, argv, (s) => process.stdout.write(s), (s) => process.stderr.write(s));
  } catch (e) {
    if (e instanceof ArgExit) return e.code;
    throw e;
  }
  try {
    const rt = runtime();
    const info = chef.current();
    const rows = await rt.listing();
    let [action, detail] = decide(info, rows) as [string, unknown];

    if (args.new && (action === "attach" || action === "resume")) {
      if (action === "attach") {
        await rt.stopShort(detail as string);
        print(`stopped the previous sous chef (${detail as string}); its conversation is kept`);
      }
      action = "start";
    } else if (args.new && action === "elsewhere") {
      throw new SCError("sous chef is open in a terminal (pid " +
        `${pyStr(get(detail, "pid", null))}); close it there before starting a new one`);
    }

    if (action === "elsewhere") {
      print(`Sous chef is already open in another terminal (pid ${pyStr(get(detail, "pid", null))}, ` +
        `session ${pyStr(get(detail, "name", null) || get(detail, "id", null))}). Switch to that terminal, or exit it ` +
        "there and run souschef again to run it in the background.");
      return 1;
    }
    if (action === "resume") {
      const short = await rt.resumeSessionId(detail as string, CODE_ROOT, env());
      if (short) {
        print(`resumed sous chef (${short})`);
        action = "attach";
        detail = short;
      } else {
        print("could not resume the previous sous chef session; starting a new one");
        action = "start";
      }
    }
    if (action === "start") {
      detail = await rt.startNamed(SESSION_NAME, firstPrompt(), CODE_ROOT, env(), PERMISSIONS);
      print(`started sous chef (${detail as string}) with permissions: ${PERMISSIONS}`);
    }

    if (args.print_only) {
      print(rt.attachCommand({ handle: { short_id: detail } }));
      return 0;
    }
    return await rt.attachExec(detail as string, CODE_ROOT, env());
  } catch (e) {
    if (e instanceof SCError) {
      printErr(`souschef: ${e.message}`);
      return 1;
    }
    throw e;
  }
}
