# 0024: Locks through proper-lockfile

**Date:** 2026-10-01
**Status:** Accepted

## Context
The Python sc locked event logs, inboxes and the watcher's single-instance lock with `flock`, which the operating system releases the moment the holder dies. Node has no `flock`. A watcher that runs twice wakes sous chef twice and can double up scheduled jobs, so the single-instance lock matters.

## Decision
All locks go through the `proper-lockfile` npm package, wrapped in one file (`src/lock.ts`); nothing else imports it. A lock on a path is the folder `<path>.lock`, made atomically, which the holder touches every few seconds. A lock nobody has touched for 10 seconds counts as abandoned and is taken over. Short locks retry for about 15 seconds. The watcher holds `state/watch.lock` for its whole life and a starting watcher retries for 12 seconds, so a watcher killed outright (whose lock goes stale after 10 seconds) is replaced; `ensure` waits up to 15 seconds for a new watcher, where Python waited 5.

Because `proper-lockfile` keeps a lock alive from a timer, a holder that blocks its event loop for 10 seconds loses the lock to another process (checked by running it). So nothing that holds a lock blocks: git, the load check and the relay all run asynchronously.

A watcher counts as running when its lock is held and fresh and the pid in `state/watch.pid` is alive. The pid only reports liveness: a watcher killed outright leaves a lock that looks held for up to 10 seconds, and without the pid check `ensure` would report it as running.

Set aside: a hand-written lock made with an exclusive file create plus a pid check, because stale-lock handling is better taken from a well-used package than written again. The Python and TypeScript lock files never have to agree, because the two versions never run at once (the switch-over stops the Python watcher first), and their names differ (`<path>.lock` folders, beside Python's `<path>` files), so leftovers of either never block the other.

## Consequences
After a crash, a lock stays held for up to 10 seconds instead of being freed at once. Any new code that holds a lock, the watcher above all, must stay asynchronous (`AGENTS.md`, Learnings).
