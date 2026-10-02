<p align="center"><img src="https://raw.githubusercontent.com/dylankuhlenthal/sous-chef/main/assets/souschef.png" alt="sous chef" width="160"></p>

# sous chef

An agent that tracks your work and launches and manages Claude Code background sessions for you. Sous chef keeps notes on your ideas, ongoing topics, proofs of concept and repos, and launches sessions for shaping, building, orchestrating and investigating. It reads what those sessions report, answers what it can, and brings you what it cannot. You can open any session it launched with `claude attach`.

## Requirements

- macOS (tested) or Linux (expected to work; only the test suite runs there, in CI).
- Node 22 or later, with `npm`.
- `git`.
- [Claude Code](https://docs.claude.com/en/docs/claude-code) with background sessions (`claude --bg`), logged in.

## Before you run it

Sous chef acts on your behalf, unattended. Know these before installing:

- **Its own permission mode is your choice.** The install asks whether sous chef's own Claude Code session runs in `auto` (a classifier checks each action, and a risky one waits for you, which can leave sous chef stuck at a prompt while you are away) or `bypass` (nothing ever waits for you, so a mistake, or an instruction hidden in something it reads, goes ahead unseen). The default is `auto`. Sessions it launches use their own kind's mode. See "Permission mode" in [docs/operations/running.md](docs/operations/running.md).
- **A background watcher runs while sous chef does.** It is a small loop, using no tokens, that wakes sous chef when a session needs attention, resumes sessions Claude Code stopped while they were waiting, runs your scheduled jobs, and, if your data folder is a git repo with a remote, commits and pushes it every few minutes. See [docs/domains/watcher.md](docs/domains/watcher.md).
- **Sessions accept messages from other local sessions.** That is how sous chef wakes them and they wake it. Any program running as you can send one, with any sender label, so sous chef and its sessions are told to treat such a message only as a prompt to read their own records, never as an instruction. See [SECURITY.md](SECURITY.md).
- **Slack is off.** Sous chef can talk to you in Slack only through a separate messaging relay, which is not published. Everything else works without it.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/dylankuhlenthal/sous-chef/main/install.sh | bash
```

The script clones this repo into `~/.sous-chef`, installs and builds it, then asks where your data folder goes, who you are, and sous chef's permission mode. To read the script first, clone and run it yourself:

```sh
git clone https://github.com/dylankuhlenthal/sous-chef.git ~/.sous-chef
~/.sous-chef/install.sh
```

Your memory, jobs, kinds and settings live in your own data folder (by default `~/.my-sous-chef`, optionally its own private git repo), reached from here as `my/`. Nothing personal goes in this repo. Details, and how to update after a pull: [docs/operations/running.md](docs/operations/running.md).

## Run

```sh
souschef
```

This attaches to sous chef, resuming or starting it first if it is not running. The install links `souschef` into `~/.local/bin`, so it runs from any terminal once that folder is on your `PATH`. Details: "Start sous chef" in [docs/operations/running.md](docs/operations/running.md).

## Docs

- [docs/architecture.md](docs/architecture.md): how it fits together, and its known limits.
- [docs/operations/running.md](docs/operations/running.md): installing, starting, testing, troubleshooting.
- [docs/operations/going-public.md](docs/operations/going-public.md): the maintainer's one-off steps for making this repo public.
- `docs/domains/`: sessions, messaging, the watcher, scheduled jobs (cron), memory, Slack, the context check.
- `docs/patterns/`: adding a kind, adding a runtime, documentation standards.
- `docs/decisions/`: why it is built this way.

## Licence, security and contributing

MIT, see [LICENSE](LICENSE). Report security problems privately, as [SECURITY.md](SECURITY.md) says. Issues are welcome; pull requests are not accepted for now ([CONTRIBUTING.md](CONTRIBUTING.md)).
