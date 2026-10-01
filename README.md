# sous chef

The owner's go-to agent. Sous chef keeps track of ideas, ongoing topics, PoCs and repos, and launches and manages Claude Code sessions for shaping, building, orchestrating and investigating. Every session it launches can be opened with `claude attach`.

## Install and run it

Needs Node 22 or later with `npm`, `git`, and Claude Code.

```sh
git clone <this repo> ~/.sous-chef
~/.sous-chef/install.sh      # installs and builds, then asks where your data folder goes, and who you are
souschef                     # attach, resuming or starting sous chef
```

Your memory, jobs, kinds and settings live in your own data folder (by default `~/.my-sous-chef`, optionally its own private git repo), reached from here as `my/`. Nothing personal goes in this repo. Details: `docs/operations/running.md`.

After every pull, rebuild: `docs/operations/running.md` ("The build, and updating after a pull").

Tests: `npm test` (the build, the TypeScript unit tests, then `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests`).

## Docs

- `docs/architecture.md`: how it fits together, and its known limits.
- `docs/operations/running.md`: installing, starting, testing, troubleshooting.
- `docs/domains/`: sessions, messaging, the watcher, scheduled jobs (cron), memory, the context check.
- `docs/patterns/`: adding a kind, adding a runtime, documentation standards.
- `docs/decisions/`: why it is built this way.
