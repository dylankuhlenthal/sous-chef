// Which Claude session is sous chef, and how to wake it.
//
// state/chef.json records which session is sous chef:
// {"registered_at": ..., "runtime": "claude-bg", "session_id": "..."}.
// The SessionStart hook (hooks.chefStart) writes it on startup, resume, clear
// and compaction, so it follows sous chef across restarts.
//
// A session only takes the registration when no other live session holds it (see
// `liveIncumbent`). Any session started in this folder runs the hook -- one
// the owner opens by hand, one spawned into a worktree of this repo -- and without
// that check the newcomer would silently become sous chef and wake-ups would
// start going to it instead.

import path from "node:path";
import { run } from "./proc.js";
import { Dict, get, or, splitWs, truthy } from "./py.js";
import * as runtimes from "./runtimes/index.js";
import { Listing, Status, WakeError } from "./runtimes/index.js";
import { CODE_ROOT, now, readJson, SCError, stateDir, writeJson } from "./util.js";

export interface ChefInfo extends Dict {
  session_id: string;
  runtime: string;
  registered_at: number;
}

export function chefPath(): string {
  return path.join(stateDir(), "chef.json");
}

export function current(): ChefInfo | null {
  return readJson<ChefInfo>(chefPath());
}

export function register(sessionId: string, runtime = "claude-bg"): ChefInfo | null {
  const prev = current();
  writeJson(chefPath(), { session_id: sessionId, runtime, registered_at: now() });
  return prev;
}

/**
 * The real sous chef folder, when this copy of the code is a git worktree of it.
 *
 * Checks the code folder (CODE_ROOT), not the data folder: the data folder says
 * nothing about where the code came from, and a worktree of the core has no `my`
 * link, so this must work without one. Without this check a session started in a
 * worktree would register as sous chef, start a second watcher and be handed the
 * "you are sous chef" summary, while the real sous chef runs elsewhere and knows
 * nothing of it. Returns null for the ordinary checkout, and for anything that is
 * not a git worktree at all.
 *
 * Tests run from whatever checkout the suite is in, often a worktree, so with
 * SC_TEST_HOME set the check is made only when SC_TEST_WORKTREE_CHECK is set too.
 */
export async function worktreeOfHome(): Promise<string | null> {
  if (process.env.SC_TEST_HOME && !process.env.SC_TEST_WORKTREE_CHECK) return null;
  const root = CODE_ROOT;
  const out = await run("git", ["-C", root, "rev-parse", "--git-dir", "--git-common-dir"], { timeout: 10 });
  if (out.code !== 0) return null;
  const parts = splitWs(out.stdout);
  if (parts.length !== 2) return null;
  const [gitDir, common] = parts.map((p) => path.isAbsolute(p) ? p : path.join(root, p)) as [string, string];
  if (!gitDir.split("/").includes("worktrees")) return null;
  return path.dirname(path.normalize(common));
}

function runtimeOf(info: Dict): runtimes.Runtime {
  return runtimes.get(get<string>(info, "runtime", "claude-bg"));
}

/**
 * The registered sous chef session, if it may still be running.
 *
 * null means the registration is free to take: nothing is registered, or the
 * session named is definitely gone. A runtime that cannot be asked counts as
 * still running, so a failed check never hands sous chef's identity to another
 * session; `sc chef --take` is the way to take it deliberately.
 */
export async function liveIncumbent(): Promise<ChefInfo | null> {
  const info = current();
  if (!info || !truthy(info.session_id)) return null;
  const rt = runtimeOf(info);
  let row: Dict | undefined;
  try {
    const rows: Listing = await rt.listing();
    row = Object.hasOwn(rows, info.session_id) ? rows[info.session_id] : undefined;
  } catch (e) {
    if (e instanceof SCError || isOsError(e)) return info;
    throw e;
  }
  return row && truthy(or(row.pid, row.alive)) ? info : null;
}

function isOsError(e: unknown): boolean {
  return e instanceof Error && typeof (e as NodeJS.ErrnoException).code === "string";
}

/** {alive, busy} for the registered sous chef session. `busy` null means unknown, never idle. */
export async function status(): Promise<Pick<Status, "alive" | "busy"> & Partial<Status>> {
  const info = current();
  if (!info || !truthy(info.session_id)) return { alive: false, busy: null };
  const rt = runtimeOf(info);
  try {
    return await rt.statusSessionId(info.session_id);
  } catch (e) {
    if (e instanceof SCError || isOsError(e)) return { alive: false, busy: null };
    throw e;
  }
}

/** Try to wake sous chef. Returns false (never throws) when it cannot. */
export async function wakeChef(text: string, rows: Listing | null = null): Promise<boolean> {
  const info = current();
  if (!info || !truthy(info.session_id)) return false;
  const rt = runtimeOf(info);
  try {
    await rt.wakeSessionId(info.session_id, text, rows);
    return true;
  } catch (e) {
    if (e instanceof WakeError || e instanceof SCError) return false;
    throw e;
  }
}
