# Contributing to sous chef

Sous chef is a personal tool shared as it is. **Issues are welcome**: bugs, questions, and ideas. **Pull requests are not accepted for now**, because there is no capacity to review them; a PR may be closed without review. To report a security problem, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

You are free to fork it under the [licence](LICENSE). The rest of this file is for working on a fork.

## Setup

```sh
npm ci          # installs the dependencies
npm test        # builds (npm run build), then runs the whole suite with vitest
npm run lint    # ESLint; pass file paths to lint only the files you touched
npm run typecheck
```

Node 22 or later. The tests start no Claude Code sessions and never touch a real install: they run `sc` against temporary folders with a fake runtime. `AGENTS.md` ("Testing") says what each part of the suite covers.

## Rules the suite enforces

- **Captured output.** `tests/captured.test.ts` compares what sous chef prints and writes (briefs, `sc kinds`, `sc events`, the startup summary) word for word with `tests/captured/`. After a deliberate change to that output, rewrite the files with `SC_UPDATE_CAPTURED=1 npx vitest run tests/captured.test.ts` and read the diff before committing: it is the list of what changed for the owner.
- **The core names nobody.** `tests/owner-neutral.test.ts` fails when a file outside `docs/decisions/` names a particular person, their private tickets, clients or tools, an email address or a home folder path. Use the owner from `my/owner.json` instead; the tests run as a neutral owner, Alex.
- **The core path list.** A new file at the top of the repo, or a new core kind, goes on the list in `tests/core-paths.ts`, or the suite fails.

## Docs

If you change a documented flow, contract or pattern, change the doc in the same commit. The docs follow the standard in `docs/patterns/documentation.md`, summarised in `AGENTS.md`.
