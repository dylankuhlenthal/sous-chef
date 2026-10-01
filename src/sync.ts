// Keeping the owner's data folder committed and pushed, from the watcher (watch.cycle).
//
// Only when the data folder is a git repo whose branch has an upstream (`sc setup`
// sets one when it pushes). Otherwise this does nothing.
//
// Each watcher cycle:
//
// 1. Changes to files git does not ignore start a quiet period. Once nothing has
//    changed for SC_SYNC_QUIET seconds (2 minutes), it commits them all as
//    `sync: <files>`. `state/` and `.env` are never committed, whatever the data
//    folder's .gitignore says.
// 2. When the branch has commits the upstream lacks and no tracked file has an
//    uncommitted edit (git would refuse to rebase over one), it fetches, rebases
//    onto the upstream if the remote moved on, and pushes. It never force-pushes.
// 3. A rebase that conflicts (leaves unmerged files) is aborted, leaving the folder as it was, and syncing
//    stops: `sync-stopped` in the sync log, which wakes sous chef. It starts again
//    by itself on the first cycle where the folder has no rebase in progress, no
//    unmerged files, and a different commit checked out than at the conflict (the
//    owner rebased or merged by hand).
// 4. A failed fetch or push is retried later, backing off from SC_SYNC_RETRY
//    seconds. After SC_SYNC_MAX_FAILURES (5) in a row, syncing stops the same way;
//    it starts again by itself on the first cycle where a fetch succeeds.
//
// Each restart appends `sync-resumed`, which does not wake sous chef. Git never
// prompts (GIT_TERMINAL_PROMPT=0, SSH in batch mode) and every call times out. Every
// git call runs asynchronously, so the watcher keeps its lock alive meanwhile.
// While the owner is in the middle of a rebase or merge, a cycle does nothing.
//
// Files:
//   state/sync/state.json    written only by the watcher: stopped or not, why, failures
//   state/sync/events.jsonl  the sync log (events.SYNC_LOG), read with `sc events`

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as events from "./events.js";
import { withLock } from "./lock.js";
import { run, RunResult } from "./proc.js";
import { Dict, exists, get, or, partition, resolvePath, slice, splitWs, strip } from "./py.js";
import { envFloat, home, now, readJson, stateDir, writeJson } from "./util.js";

const GIT_TIMEOUT = 60;
const NEVER_COMMITTED_PATHS = ["state", ".env"];
const NEVER_COMMITTED = NEVER_COMMITTED_PATHS.map((p) => `:(exclude)${p}`);

function statePath(): string {
  return path.join(stateDir(), "sync", "state.json");
}

async function git(...args: string[]): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (env.GIT_SSH_COMMAND === undefined) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  const r = await run("git", ["-C", home(), ...args], { env, timeout: GIT_TIMEOUT });
  if (r.timedOut) return { code: 124, stdout: "", stderr: `git ${args[0]} timed out after ${GIT_TIMEOUT}s` };
  return r;
}

async function out(...args: string[]): Promise<string> {
  const r = await git(...args);
  return r.code === 0 ? strip(r.stdout) : "";
}

function err(r: RunResult): string {
  return slice(splitWs(r.stderr || r.stdout || "").join(" "), 0, 500);
}

/** A rebase or merge in progress, or unmerged files: the owner is working in the folder. */
async function busyByHand(): Promise<boolean> {
  const gitDir = (await out("rev-parse", "--absolute-git-dir")) || "/nonexistent";
  if (["rebase-merge", "rebase-apply", "MERGE_HEAD"].some((n) => exists(path.join(gitDir, n)))) return true;
  return Boolean(await out("diff", "--name-only", "--diff-filter=U"));
}

/** [files, signature] for what is not committed. The signature changes whenever any of it does. */
async function changes(): Promise<[string[], string]> {
  const status = await git("status", "--porcelain", "-z", "--untracked-files=all", "--", ".", ...NEVER_COMMITTED);
  if (status.code !== 0) return [[], ""];
  const files = status.stdout.split("\0").filter((entry) => entry.length > 3).map((entry) => entry.slice(3));
  const h = createHash("sha1");
  h.update(status.stdout, "utf8");
  for (const rel of files) {
    try {
      const st = fs.statSync(path.join(home(), rel), { bigint: true });
      h.update(`${rel}\0${st.mtimeNs}\0${st.size}\0`, "utf8");
    } catch {
      h.update(`${rel}\0gone\0`, "utf8");
    }
  }
  return [files, h.digest("hex")];
}

function message(files: string[]): string {
  const shown = files.slice(0, 5).join(", ");
  return `sync: ${shown}` + (files.length > 5 ? ` and ${files.length - 5} more` : "");
}

async function stopSync(st: Dict, why: string, detail: string, extra: Dict = {}): Promise<string> {
  Object.assign(st, { stopped: why, ...extra });
  const text = why === "conflict"
    ? "rebasing onto the remote conflicted, so the rebase was aborted and nothing was lost"
    : `${String(get(st, "failures", null) ?? "None")} fetches or pushes in a row failed`;
  await events.append(events.SYNC_LOG, "sync", "sync-stopped",
    `Syncing the data folder stopped: ${text}. Git said: ${detail}`);
  return `sync: stopped (${why})`;
}

async function resumeSync(st: Dict, why: string): Promise<string> {
  await events.append(events.SYNC_LOG, "sync", "sync-resumed", `Syncing the data folder started again: ${why}.`);
  for (const k of ["stopped", "conflict_head", "retry_at"]) delete st[k];
  st.failures = 0;
  return "sync: resumed";
}

async function failedSync(st: Dict, t: number, r: RunResult): Promise<string> {
  st.failures = (get<number>(st, "failures", 0)) + 1;
  if ((st.failures as number) >= Math.trunc(envFloat("SC_SYNC_MAX_FAILURES", 5))) return stopSync(st, "push", err(r));
  st.retry_at = t + Math.min(1800, envFloat("SC_SYNC_RETRY", 60) * 2 ** ((st.failures as number) - 1));
  return `sync: fetch or push failed (${st.failures as number} in a row), retrying later: ${err(r)}`;
}

/** One watcher cycle of syncing. Returns {actions}; never throws for git failures. */
export async function tick(): Promise<{ actions: string[] }> {
  const top = await out("rev-parse", "--show-toplevel");
  if (!top || resolvePath(top) !== resolvePath(home())) {
    return { actions: [] }; // not a repo, or the data folder sits inside some other repo: not ours to commit
  }
  const upstream = await out("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
  if (!upstream) return { actions: [] };
  const remote = partition(upstream, "/")[0];
  const t = now();
  const actions: string[] = [];
  await withLock(path.join(stateDir(), "sync", ".lock"), async () => {
    const st = or(readJson<Dict>(statePath(), {}), {}) as Dict;
    const head = await out("rev-parse", "HEAD");

    if (st.stopped === "conflict") {
      if ((await busyByHand()) || head === st.conflict_head) {
        writeJson(statePath(), st);
        return;
      }
      actions.push(await resumeSync(st, "the conflict was resolved in the data folder"));
    } else if (st.stopped === "push") {
      if (t < get<number>(st, "retry_at", 0)) return;
      const r = await git("fetch", "--quiet", remote);
      if (r.code !== 0) {
        st.retry_at = t + envFloat("SC_SYNC_RETRY_STOPPED", 600);
        writeJson(statePath(), st);
        return;
      }
      actions.push(await resumeSync(st, "the remote can be reached again"));
    }

    if (await busyByHand()) {
      writeJson(statePath(), st);
      return;
    }

    const [files, sig] = await changes();
    if (files.length) {
      if (sig !== st.sig) {
        Object.assign(st, { sig, changed_at: t });
      } else if (t - get<number>(st, "changed_at", t) >= envFloat("SC_SYNC_QUIET", 120)) {
        let add = await git("add", "-A");
        if (add.code === 0) { // then take state/ and .env back out, whatever .gitignore says
          add = await git("rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...NEVER_COMMITTED_PATHS);
        }
        const commit = add.code === 0 ? await git("commit", "-q", "-m", message(files)) : add;
        if (commit.code === 0) {
          actions.push(`sync: committed ${files.length} file(s)`);
          delete st.sig;
        } else {
          actions.push(`sync: commit failed: ${err(commit)}`);
        }
      }
    } else {
      delete st.sig;
    }

    // git refuses to rebase over uncommitted edits to tracked files, so a push waits
    // until they are committed (after their own quiet period).
    const clean = (await git("diff", "--quiet", "HEAD")).code === 0;
    const ahead = await out("rev-list", "--count", `${upstream}..HEAD`);
    if (!["", "0"].includes(ahead) && clean && t >= get<number>(st, "retry_at", 0)) {
      actions.push(await push(st, t, upstream));
    }
    writeJson(statePath(), st);
  });
  return { actions };
}

async function push(st: Dict, t: number, upstream: string): Promise<string> {
  const [remote, , branch] = partition(upstream, "/");
  let r = await git("fetch", "--quiet", remote);
  if (r.code !== 0) return failedSync(st, t, r);
  if (!["", "0"].includes(await out("rev-list", "--count", `HEAD..${upstream}`))) {
    r = await git("rebase", "--quiet", upstream);
    if (r.code !== 0) {
      const conflicted = Boolean(await out("diff", "--name-only", "--diff-filter=U"));
      await git("rebase", "--abort");
      if (!conflicted) return failedSync(st, t, r); // git refused for another reason: retried like a failed push
      return stopSync(st, "conflict", err(r), { conflict_head: await out("rev-parse", "HEAD") });
    }
  }
  r = await git("push", "--quiet", remote, `HEAD:${branch}`);
  if (r.code !== 0) return failedSync(st, t, r);
  st.failures = 0;
  delete st.retry_at;
  return "sync: pushed";
}
