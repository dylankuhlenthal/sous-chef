# 0033: Porch comes from npm

**Date:** 2026-10-02
**Status:** Accepted. Supersedes decision 0025 (Porch is a GitHub dependency pinned to a tag).

## Context
Decision 0025 took Porch from its private GitHub repo, pinned to the tag `v0.1.0`, because it was not published anywhere. That meant installing sous chef needed read access to that repo, and npm built Porch on install, which pulled in its development dependencies, including the native module `node-pty`. A stranger installing the public core, and a GitHub Actions runner, have neither. Porch is now public and published to npm, starting at 0.2.0, which split its library by import path: the supported library in the main import, test helpers in `@dylankuhlenthal/porch/testing`, the rest in `@dylankuhlenthal/porch/internal`.

## Decision
`package.json` depends on `@dylankuhlenthal/porch` at `^0.2.0` from npm, and `package-lock.json` records the exact version installed (0.2.0). Below version 1, npm reads `^0.2.0` as 0.2.x only, so a 0.3.0 with breaking changes arrives only through a deliberate `npm install` of it and a commit of both files. The production code uses only the main import. The tests take `createFakeAdapter`, `fake` and `RecordStore` from `@dylankuhlenthal/porch/testing`; nothing uses `/internal`.

## Consequences
Installing sous chef needs only npm's public registry: no access to a private repo and no native build. The owner-neutral check no longer allows Porch's GitHub source, only its package name. Porch's code at 0.2.0 differs from `v0.1.0` only in the import split and in wording, so what was checked with real sessions on `v0.1.0` still describes it. How it works: "Requirements" in `docs/operations/running.md`, "The Claude runtime" in `docs/domains/sessions.md`.
