# 0023: Sous chef runs from a compiled build, and refuses a stale one

**Date:** 2026-10-01
**Status:** Accepted

## Context
TypeScript has to be compiled to JavaScript or run through Node's type stripping. The default Node on the development Mac is 22.14, which cannot run `.ts` files directly (that needs 22.18 or later, prints an experimental warning on 22.x and restricts syntax). A forgotten build is easy after a pull, and sous chef running old code without saying so is worse than not running.

## Decision
`npm run build` compiles `src/` with `tsc` into `dist/`, which is gitignored, and writes `dist/.build-stamp` as its last step (`scripts/build-stamp.js`), so a build that did not finish has no stamp. `bin/sc` and `bin/souschef` are small JavaScript launchers that use only Node's own modules. They refuse Node older than 22, then check the build, then load `dist/main.js`. The check refuses, with the command that fixes it and exit code 1 (never 2, which would block a `PreToolUse` hook), when `dist/` or the stamp is missing; when a file under `src/`, or a tsconfig file, is newer than the stamp and its content differs from what the build recorded; or when `node_modules/.package-lock.json` is missing, or older than a `package-lock.json` whose content differs from what the build recorded.

The stamp records a SHA-1 of each source file and of `package-lock.json` (the last only when the installed dependencies were newer than it at build time). The shaping had settled on modification times alone, but that refused a fresh `git worktree add` or clone of a built copy, because git gives every file a new time; so a newer time now counts only when the content changed too. Hashing happens only for files newer than the stamp, which is rare, so the usual check still only compares times.

At `sc hook chef-start` the refusal is printed as sous chef's startup context instead, with exit code 0, so sous chef starts and can tell the owner what is wrong. Every other hook fails with the refusal, which Claude Code shows as a hook error without blocking. While the build is stale, the hook that blocks edits under `state/` does not run, so those edits are not blocked; this is the same as any hook crash before, which also let the edit through.

Set aside: Node's type stripping (above), and committing `dist/` (a build output in every diff, and easy to forget to rebuild before a commit).

## Consequences
Every update is `git pull`, then `npm ci` if `package-lock.json` changed, then `npm run build` (`docs/operations/running.md`). The watcher hashes `bin/sc` and `dist/` and restarts on a new build (`docs/domains/watcher.md`); since the stamp holds only content, a rebuild of the same source does not restart it. No code in `src/` is imported lazily, because a rebuild deletes `dist/` while the watcher and long commands are running.
