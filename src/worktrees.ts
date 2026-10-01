// Worktrees sous chef creates for sessions, following the owner's repo layout.
//
// The owner's repos keep git data at the repo root (a `.bare/` folder with a `.git`
// file, or a bare repo at the root) with worktrees as sibling folders, and shared
// env files in `<root>/.local/` (see the repo-setup skill). `sc worktree` makes a
// new branch and worktree there and records it in state/worktrees.json:
//
//   {"<worktree path>": {"repo": ..., "branch": ..., "base": ..., "created_at": ...,
//                        "session": "<id of the session using it, or null>"}}
//
// That record is what lets `sc spawn` turn off Claude Code's background worktree
// isolation for a session: only a worktree sous chef created, and no other active
// session is using, counts as the session's own. Everywhere else the default stays.
//
// Every change to the record also drops entries whose folder no longer exists and
// that no active session holds (`prune`), so worktrees removed by hand do not stay
// listed. An entry whose folder exists is never dropped.

import fs from "node:fs";
import path from "node:path";
import { withLock } from "./lock.js";
import { run } from "./proc.js";
import { Dict, exists, expanduser, isDir, isFile, listDir, or, partition, resolvePath, strip } from "./py.js";
import * as records from "./records.js";
import { now, readJson, SCError, stateDir, writeJson } from "./util.js";

const DIR_NAME = /^[a-z0-9][a-z0-9-]*(?=\n?$)/;

function registryPath(): string {
  return path.join(stateDir(), "worktrees.json");
}

function lockPath(): string {
  return path.join(stateDir(), ".worktrees.lock");
}

export function registry(): Record<string, Dict> {
  return or(readJson<Record<string, Dict>>(registryPath(), {}), {}) as Record<string, Dict>;
}

/**
 * Drop entries whose folder is gone and no active session holds. True if any were dropped.
 *
 * Called with the lock held, before the record is written.
 */
function prune(data: Record<string, Dict>): boolean {
  const active = new Set(records.allIds());
  const gone = Object.entries(data)
    .filter(([p, entry]) => !exists(p) && !active.has(entry.session as string))
    .map(([p]) => p);
  for (const p of gone) delete data[p];
  return gone.length > 0;
}

function git(args: string[], cwd?: string) {
  return run("git", args, { cwd });
}

export interface Created {
  path: string;
  branch: string;
  base: string;
  env_linked: string[];
  has_local: boolean;
}

export async function create(repo: string, branch: string, dirName: string, base: string | null = null):
  Promise<Created> {
  const root = resolvePath(expanduser(repo));
  if (!isDir(root)) throw new SCError(`repo root does not exist: ${root}`);
  if (!DIR_NAME.test(dirName) || dirName === ".bare" || dirName === ".local") {
    throw new SCError("--dir must be a short lowercase kebab-case name (not .bare or .local)");
  }
  const common = await git(["-C", root, "rev-parse", "--git-common-dir"]);
  if (common.code !== 0) throw new SCError(`${root} is not a git repository`);
  const target = path.join(root, dirName);
  if (exists(target)) throw new SCError(`${target} already exists`);
  if ((await git(["-C", root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0) {
    throw new SCError(`branch ${branch} already exists; pick another name or use its existing worktree`);
  }

  const fetch = await git(["-C", root, "fetch", "origin"]);
  if (fetch.code !== 0) throw new SCError(`git fetch origin failed: ${strip(fetch.stderr)}`);
  if (!base) {
    const head = await git(["-C", root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (head.code === 0) {
      const ref = strip(head.stdout);
      const [first, sep, rest] = partition(ref, "/");
      base = sep ? rest : first;
    } else {
      base = "main";
    }
  }
  const start = `origin/${base}`;
  if ((await git(["-C", root, "rev-parse", "--verify", "--quiet", start])).code !== 0) {
    throw new SCError(`${start} does not exist`);
  }

  // Branch from origin's base, not from a local base worktree the owner may be using,
  // and without tracking: the first push sets the upstream.
  const add = await git(["-C", root, "worktree", "add", "--no-track", "-b", branch, target, start]);
  if (add.code !== 0) throw new SCError(`git worktree add failed: ${strip(add.stderr)}`);

  const linked: string[] = [];
  const local = path.join(root, ".local");
  if (isDir(local)) {
    for (const name of listDir(local)) {
      if (name.startsWith(".env") && isFile(path.join(local, name)) && !exists(path.join(target, name))) {
        fs.symlinkSync(`../.local/${name}`, path.join(target, name));
        linked.push(name);
      }
    }
  }

  const entry = { repo: root, branch, base, created_at: now(), session: null };
  await withLock(lockPath(), () => {
    const data = registry();
    prune(data);
    data[target] = entry;
    writeJson(registryPath(), data);
  });
  return { path: target, branch, base, env_linked: linked, has_local: isDir(local) };
}

/** Give up any worktree a session held, so it can be used again. */
export async function release(sid: string): Promise<void> {
  await withLock(lockPath(), () => {
    const data = registry();
    let changed = false;
    for (const entry of Object.values(data)) {
      if (entry.session === sid) {
        entry.session = null;
        changed = true;
      }
    }
    // After freeing it: the session is still active while it is cleaned up.
    if (prune(data) || changed) writeJson(registryPath(), data);
  });
}

/**
 * Claim a sous chef worktree for a new session. True if cwd is one and is now claimed.
 *
 * Refuses when another active session already uses it. A worktree whose
 * previous session was cleaned up can be claimed again.
 */
export async function claimFor(cwd: string, sid: string): Promise<boolean> {
  const key = resolvePath(cwd);
  return withLock(lockPath(), () => {
    const data = registry();
    if (prune(data)) writeJson(registryPath(), data);
    if (!Object.hasOwn(data, key)) return false;
    const entry = data[key]!;
    const holder = entry.session as string | null;
    if (holder && holder !== sid && records.allIds().includes(holder)) {
      throw new SCError(`worktree ${key} is already used by active session ${holder}`);
    }
    entry.session = sid;
    writeJson(registryPath(), data);
    return true;
  });
}
