# 0021: The TypeScript rewrite is built in five steps, one after another

**Date:** 2026-10-01
**Status:** Accepted

## Context
Sous chef was about 5,600 lines of Python and moves to TypeScript, with its Claude runtime moving onto Porch (TRV-1143). That is too much for one build to do and for one review to check well, and the live sous chef has to switch over in one go at the end. Each part has its own way to be checked: the behaviour suite, real Claude sessions, and a rehearsal of the switch-over.

## Decision
The rewrite is five sub-issues of TRV-1143, built in order by one serial orchestrate run: (1) the behaviour suite made language-neutral, so the same tests run against either sc; (2) the TypeScript sc at parity on the fake runtime, passing that suite; (3) the Claude runtime on Porch; (4) the switch-over of the live install; (5) the tests ported to TypeScript and the Python code removed. Steps 2 to 4 merge into an integration branch, and only the finished whole goes to `main`.

Step 2 is one pull request built in internal commits (tooling, foundations, commands, the launcher switch, docs), so the review is split without splitting the issue. `bin/sc` and `bin/souschef` switch to the Node launchers only in its last code commit, so every earlier commit still runs the Python sc and passes the suite.

Set aside: one issue with one very large pull request (too big to review well), and a Linear project (more structure than one repo needs). The steps run one at a time because this is the first orchestrate run on this repo and each step builds on the one before.

## Consequences
Between steps 2 and 3, the TypeScript sc runs only on the fake runtime: its Claude runtime (`src/runtimes/claude-bg.ts`) refuses everything except opening a session and the skill lookup. Nothing runs the branch live until the switch-over (step 4); until step 5 the Python code stays in `lib/` and the behaviour suite stays in Python, run against the TypeScript sc.
