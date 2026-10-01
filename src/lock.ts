// File locks, through proper-lockfile (docs/decisions/0024). The only file that imports it.
//
// A lock on <path> is the folder <path>.lock, made with mkdir (atomic) and touched by
// the holder every few seconds. A lock nobody has touched for STALE_MS counts as
// abandoned (its holder died) and is taken over. So a holder must never block its
// event loop for that long: everything slow (git, the relay) runs asynchronously.
//
// The Python sc locked <path> itself with flock. The two never run at once, and the
// names differ (<path>.lock is a folder, <path> a file), so leftovers of either never
// block the other.

import path from "node:path";
import lockfile from "proper-lockfile";
import { mkdirs } from "./util.js";

export const STALE_MS = 10_000;

function retries(seconds: number) {
  const step = 100;
  return { retries: Math.ceil((seconds * 1000) / step), factor: 1, minTimeout: step, maxTimeout: step };
}

/**
 * Hold an exclusive lock on `p` while `fn` runs (Python's util.locked). Waits for as long
 * as someone else holds it, as Python's flock did: a holder that dies stops touching its
 * lock, which is then taken over after STALE_MS, so the wait always ends. (Some holders
 * are slow on purpose: the cron run lock is held while sessions launch, which can take
 * more than 90 seconds.)
 */
export async function withLock<T>(p: string, fn: () => T | Promise<T>): Promise<T> {
  mkdirs(path.dirname(p));
  const release = await lockfile.lock(p, {
    realpath: false,
    stale: STALE_MS,
    retries: { forever: true, factor: 1, minTimeout: 100, maxTimeout: 100 },
    // A short lock is only compromised if its holder blocked for STALE_MS, which nothing
    // here does. Never crash the command over it.
    onCompromised: () => undefined,
  });
  try {
    return await fn();
  } finally {
    await release().catch(() => undefined);
  }
}

/**
 * Take a lock to hold for the life of this process (the watcher's single-instance lock).
 * Returns its release function, or null when someone else held it for `waitSeconds`.
 * `onCompromised` is called if the lock is lost (its folder was removed or taken over).
 */
export async function holdLock(p: string, waitSeconds: number,
                               onCompromised: (err: Error) => void): Promise<(() => Promise<void>) | null> {
  mkdirs(path.dirname(p));
  try {
    return await lockfile.lock(p, { realpath: false, stale: STALE_MS, retries: retries(waitSeconds), onCompromised });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOCKED") return null;
    throw e;
  }
}

/** Whether someone holds the lock on `p` and has touched it within STALE_MS. */
export async function isHeld(p: string): Promise<boolean> {
  try {
    return await lockfile.check(p, { realpath: false, stale: STALE_MS });
  } catch {
    return false;
  }
}
