# 0029: The build vouches for a lock file the installed dependencies match

**Date:** 2026-10-02
**Status:** Accepted. Replaces the words "(the last only when the installed dependencies were newer than it at build time)" in decision 0023 (sous chef runs from a compiled build and refuses a stale one).

## Context
Decision 0023 has the build record a SHA-1 of `package-lock.json` in `dist/.build-stamp` only when `node_modules/.package-lock.json` (which npm writes on every install) was newer than it. A checkout that rewrites `package-lock.json` with the same content gives it a new time, so the next `npm run build` recorded no hash, and `bin/sc` then refused with "dependencies older than package-lock.json" until `npm ci`, although nothing was out of date (found while switching the live install over, TRV-1156). Decision 0023's aim is to refuse only a build that is really out of date.

## Decision
`scripts/build-stamp.js` also records the hash when npm's record is older but matches the lock file's content: the same name, version and lock format, every installed package present in the lock file with an identical entry, and every package in the lock file installed, except the root entry and optional packages npm did not install (those for other platforms). A lock file whose content really changed (a pull, then a build without `npm ci`) still records nothing, and `bin/sc` still refuses. The launcher's check is unchanged: it trusts the hash the stamp holds.

Set aside: carrying the previous stamp's hash forward (`npm run build` deletes `dist/`, and the stamp with it, first), and a `postinstall` script recording the hash at install time (one more lifecycle step, and the record would sit in `node_modules`, which tests link between copies).

## Consequences
A different npm writing its record with different fields makes the comparison fail, which only means `npm ci` is asked for, as before this change. How it shows: `docs/operations/running.md`, "The build, and updating after a pull".
