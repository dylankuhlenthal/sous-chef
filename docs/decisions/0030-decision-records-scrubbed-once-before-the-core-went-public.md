# 0030: Decision records were scrubbed once, before the core went public

**Date:** 2026-10-02
**Status:** Accepted

## Context
Decision records are never edited after merge, and decision 0020 (the core and the owner's data are separate repos) kept the first owner's name in them, because they say who decided what. The core is now going public. Its records named the first owner throughout, cited their private tickets by id, and described one of their client projects and its databases. Porch, which went public just before, faced the same question and scrubbed its records once, by hand. Leaving the records as written, and cleaning only the other docs, was set aside: a stranger reading why sous chef works as it does would read about someone else's clients and tickets they cannot open.

## Decision
Every record in `docs/decisions/` was scrubbed once, before the core went public, and this is the one exception to "never edited after merge":

- the first owner's name became "the first owner" or "the owner";
- ticket ids became a description of what they referred to;
- the client project and its databases became a neutral description that keeps the point (a destructive command against shared databases);
- the two records whose file names carried the first owner's name were renamed: 0008 (sous chef creates worktrees in the owner's layout) and 0014 (a tag from the owner is handled like a message in the terminal);
- test paths that no longer exist were corrected (decision 0025 and decision 0018 cited `tests/test_owner_neutral.py`, now `tests/owner-neutral.test.ts`).

Two stored values the first owner's old records still contain (`waiting_on: "dylan"`, `from_dylan`) stay in decision 0018, which describes them. Decision 0028 (switching the live sous chef to TypeScript) also gained its switch-over and rollback runbook, moved out of `docs/operations/running.md` because only the first owner's install ever needed it.

## Consequences
The original wording stays in git history. From here on records are again never edited after merge. `docs/decisions/` stays outside the search in `tests/owner-neutral.test.ts`, which every other core file passes: a record may need to name a stored value or quote what someone decided, and checking that is left to review.
