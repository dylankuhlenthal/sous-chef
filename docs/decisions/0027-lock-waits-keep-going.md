# 0027: Lock waits keep going

**Date:** 2026-10-01
**Status:** Accepted. Replaces the sentence "Short locks retry for about 15 seconds" in decision 0024 (locks through proper-lockfile).

## Context
Decision 0024 moved sous chef's file locks to `proper-lockfile` and let a short lock wait about 15 seconds. Python's `flock` waited for as long as the holder held the lock. With the 15-second limit, a command that met a lock held a little longer crashed with `proper-lockfile`'s raw error. Some holders are slow on purpose: the cron run lock is held while sessions launch, and a real Claude launch can take more than 90 seconds.

## Decision
`withLock` (`src/lock.ts`) waits for as long as the lock is held, retrying every 100 milliseconds, as Python did. The wait always ends: a holder that dies stops touching its lock, which is then taken over after 10 seconds (decision 0024). The watcher's own single-instance lock keeps its fixed wait.

Set aside: a longer fixed limit (any limit can be shorter than a slow but healthy holder, and then crashes a command that would have succeeded).

## Consequences
A holder that is alive but stuck holds every waiter with it, as with Python. Holders must stay asynchronous (decision 0024), or their lock goes stale and is taken over.
