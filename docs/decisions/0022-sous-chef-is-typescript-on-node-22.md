# 0022: Sous chef is TypeScript on Node 22 or later

**Date:** 2026-10-01
**Status:** Accepted

## Context
Sous chef was written in Python 3 using only the standard library. No decision record said so; it was a line in `AGENTS.md`, `docs/operations/running.md` and the relay client. Sous chef is moving its Claude runtime onto Porch, a TypeScript library for observing and messaging agent sessions, and keeping two languages side by side would mean every shared behaviour is written twice (TRV-1143).

## Decision
Sous chef is TypeScript, run on Node 22 or later, with its code in `src/` and its tooling taken from Porch's (TypeScript 5.9 strict, ES modules, ESLint 9, vitest). Its runtime dependencies are `proper-lockfile` now (decision 0024, locks through `proper-lockfile`) and Porch when the Claude runtime moves onto it (TRV-1155); nothing else. Command-line parsing is a small parser written for `sc` (`src/args.ts`) that reproduces what Python's `argparse` did for it, because a parser package would add a dependency and Node's own `parseArgs` has no subcommands, choices or required options.

State files and printed JSON are written the way Python wrote them (`src/pyjson.ts`), so the two versions read each other's files and a rollback works. The one known difference is that a whole number Python stored as a float (`1800000000.0`) is written without the `.0`.

Set aside: keeping Python and calling Porch's command line from it (a second language for the same behaviour, and a process per call).

## Consequences
Installing sous chef needs Node 22 or later and `npm`, and an update needs `npm ci` when `package-lock.json` changed and a build (decision 0023, the compiled build refused when stale). Python stays a development dependency only while the behaviour suite is still in Python (until TRV-1157 ports the suite to vitest and deletes the Python code). `sc cron list` names time zones as Node's `Intl` does, so outside UTC it can print `GMT+2` where Python printed `SAST`.
