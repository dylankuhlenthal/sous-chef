# 0025: Porch is a GitHub dependency pinned to a tag

**Date:** 2026-10-01
**Status:** Accepted

## Context
Sous chef reaches its Claude sessions through Porch (decision 0026), which lives in its own private repo and is not yet published to npm. Sous chef needs one fixed version of it that any install builds the same way, on any machine.

## Decision
`package.json` depends on Porch through its GitHub repo, pinned to a tag: `github:dylankuhlenthal/porch#v0.1.0`. `package-lock.json` records the exact commit the tag points at. npm runs Porch's `prepare` script on install, which builds Porch's `dist/`, so nothing built is copied into the core. The `v0.1.0` tag was made on Porch's newest `main` when the Claude runtime was built (commit `a504c8a`, which already reports a session Claude Code stopped for being idle as `ended` with reason `idle`). A newer Porch arrives only through a deliberate pin bump: a new tag, then `npm install` of it and a commit of both files.

Set aside: copying Porch's built files into the core (a second copy to keep in step), and linking to a local Porch checkout (works on one machine only, and runs whatever branch happens to be checked out).

## Consequences
Until Porch is published to npm (TRV-1146, Porch goes public), installing sous chef needs read access to the private Porch repo and whatever Porch's build needs, including its native development dependency `node-pty`. Moving to the npm package then changes only the dependency line. The package name carries its author's account, so the owner-neutral check allows exactly that name, and the GitHub source in the two package files (`tests/test_owner_neutral.py`).
