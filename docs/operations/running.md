# Running sous chef

## Requirements

- macOS or Linux with Node 22 or later and `npm` (developed and tested on Node 22.14). The one runtime dependency, `proper-lockfile`, is installed by `npm ci` into the core's `node_modules/`.
- Claude Code with background sessions (`claude --bg`), logged in. Verified with 2.1.274.
- `git`, for `sc worktree`, for `sc cleanup`'s unlanded-work check, and for keeping the data folder in a git repo.

## Install

Clone the core to `~/.sous-chef`, then run its install script:

```sh
git clone <the sous chef core repo> ~/.sous-chef
~/.sous-chef/install.sh
```

`install.sh` checks that `node`, `npm`, `git` and `claude` are on `PATH` (naming every missing one), that `node` is version 22 or later, and says which Node it found (`using Node v22.14.0 at <path>; hooks and the watcher run this Node`). It then brings the install up to date, doing only what is out of date. When `bin/sc --help` fails, it runs `npm ci` if `node_modules/.package-lock.json` is missing or `bin/sc` says the dependencies are older than `package-lock.json`, then `npm run build` if `bin/sc` still fails. It refuses to reinstall a `node_modules` that is a link to another install. Last, it runs `sc setup` (`src/setup.ts`), which asks:

| Question | What happens |
| --- | --- |
| Data folder | Default `~/.my-sous-chef`. An existing sous chef data folder is used as it is. Otherwise you can clone one from a git URL, or a new one is made with starter files: the memory files the summary shows, a feedback file named in `instructions.md`, empty `cron/` and `kinds/`, `instructions.md` and `worker-instructions.md` with a comment saying what they are for, and a `.gitignore` for `state/` and `.env`. |
| Owner | Only when the folder has no `owner.json`: your name and branch prefix. `sc owner set` changes them later. |
| Track in git? | A new folder only: `git init` and a first commit. |
| Push to a remote? | When the data folder is a git repo with no `origin`: the URL of an empty private repo you made. It never creates repos. Once pushed, the watcher keeps it committed and pushed (`docs/domains/watcher.md`, check 9). |

Then it makes the `my` link in the core, links `sc` and `souschef` into `~/.local/bin`, writes `.agents/settings.local.json` so a plain `claude` in the core may edit the data folder as it edits the core, and says how to set up Slack. Every question has a flag (`--data`, `--clone`, `--git`/`--no-git`, `--push-url`, `--name`, `--branch-prefix`, `--bin-dir`, `--yes`; `sc setup --help`), and running it again is safe: what is in place is left alone. It refuses a `my` link that points somewhere else (remove the link first; the data behind it is not touched) and a core folder that still holds `memory/` and `state/`.

Claude Code only reads `.agents/settings.local.json` in a folder you have trusted, so if you run plain `claude` in the core, accept its trust prompt the first time. Sous chef itself runs in bypass mode (decision 0015) and does not need it.

Sessions do not need `sc` on `PATH`: their brief gives its full path.

### The build, and updating after a pull

`bin/sc` and `bin/souschef` are small launchers. They run the compiled code in `dist/`, which `npm run build` makes from `src/` (`dist/` is not tracked). Before running anything they check the build, and refuse with the command that fixes it, exit code 1:

- no `dist/`, or no `dist/.build-stamp` (the last step of a build, so a build that did not finish has none): `run: cd <core> && npm ci && npm run build`;
- a file under `src/`, or `tsconfig.json` or `tsconfig.build.json`, newer than the build and with different content from what the build recorded in the stamp: `run: cd <core> && npm run build`;
- `node_modules/.package-lock.json` missing, or older than a changed `package-lock.json`: `run: cd <core> && npm ci && npm run build`.

At sous chef's startup hook the same text reaches sous chef as its startup context instead, so it can tell you. While the build is stale every other hook fails with the same text instead of running, including the one that blocks edits under `state/`, so those edits are not blocked. Why it works this way: decision 0023 (compiled into `dist/`, refused when stale).

So after every pull of the core, update it with one step:

```sh
cd ~/.sous-chef && git pull && { git diff --quiet ORIG_HEAD HEAD -- package-lock.json || npm ci; } && npm run build
```

The watcher notices the new build between cycles and restarts on it (`docs/domains/watcher.md`).

**Known limit: hooks find Node through `PATH`.** Hook commands written into a session's settings name the Node that ran `sc` (`process.execPath`), so they do not depend on `PATH`. But sous chef's own hooks in `.agents/settings.json`, and hook commands saved by sessions started before the core moved to TypeScript, run `bin/sc` directly, and its first line (`#!/usr/bin/env node`) finds `node` on `PATH`. Claude Code's background processes on the development Mac carry a `PATH` with Node 22 (seen 2026-10-01). If they did not, those hooks would fail to start, and Claude Code would show a hook error. Lifting it would mean launchers that fall back to a Node path recorded at install.

### Moving the data folder

Move the folder, then re-point the link: `ln -sfn <new place> ~/.sous-chef/my`. Paths in briefs go through the link, so running sessions keep working. Update the path in `.agents/settings.local.json` (or delete the file and run `sc setup --data <new place> --yes`).

### The owner's files

Everything that belongs to the owner is in the data folder, reached from the core as `my/`: `owner.json`, `instructions.md` (their rules for sous chef, shown in full in the startup summary), `worker-instructions.md` (their rules for every session, added to each brief), `kinds/` (their own kinds), `memory/`, `cron/`, `context.json`, and the never-tracked `state/` and `.env`. The core's `.gitignore` lists all of them, so none can be committed to the core by mistake.

## Start sous chef

Run `souschef` from any terminal. It uses the session registered in `my/state/chef.json` and the `claude agents` listing (the runtime's listing; tests run `souschef` on the fake runtime with `SC_CHEF_RUNTIME=fake`):

| Situation | What `souschef` does |
| --- | --- |
| Sous chef is running in the background | Attaches to it |
| Sous chef is stopped | Resumes the same session in the background (checking it really is the same one), then attaches |
| Nothing registered, or the resume did not bring the session back | Starts a new background session named `sous-chef` in bypass permission mode, with a short first message, then attaches |
| Sous chef is open in a terminal (someone ran `claude` in the core) | Says so and exits, since that session cannot be attached to |
| There is no data folder | Says to run `install.sh`, and exits |

`claude attach` opens it in the terminal; the left arrow returns to Claude Code's agent view, and Ctrl+Z drops back to the shell. Either way sous chef keeps running.

- `souschef --new` stops the current background sous chef (its conversation is kept) and starts a fresh one. If sous chef is already stopped it just starts a fresh one, and if it is open in a terminal it refuses, since it cannot stop that one for you.
- `souschef --print` does everything except attach, and prints the attach command. Without `--print`, `souschef` replaces itself with `claude attach`, so you land in the session and your shell returns when you leave it.

**Permission mode.** A sous chef that `souschef` starts runs in bypass mode: nothing it does waits for a person. The owner chose this knowing sous chef reads email and Slack from other people and can run commands, push and write to Linear, so a mistake or a hidden instruction it wrongly follows goes ahead unseen; only its instructions stand in the way. See decision 0015 (sous chef itself runs in bypass mode). A resumed sous chef keeps the mode it was started with, so a sous chef started before this change keeps its old mode until `souschef --new`. Sessions sous chef spawns take their kind's mode (see "Permissions" in `docs/domains/sessions.md`). The setting is `PERMISSIONS` in `src/souschef.ts`.

Running `claude` in `~/.sous-chef` also works and registers that session as sous chef, but it only lives as long as that terminal. Running only one sous chef at a time is expected; the startup summary warns if a different sous chef session was registered before.

## Stop sous chef fully

1. `sc chef` shows the registered sous chef session and its short id. `claude stop <short id>` stops it; its conversation is kept.
2. Stop the watcher: `kill $(cat ~/.sous-chef/my/state/watch.pid)`. It stops between cycles. Without this it keeps running and keeps writing events, but cannot wake sous chef, and scheduled jobs do not fire while sous chef is stopped.

Sessions sous chef launched keep running; `sc sessions` lists them and `sc stop <id>` stops one.

The next `souschef` resumes the same sous chef, in the mode it was started with. To start a fresh one instead (for example to pick up a new permission mode), run `souschef --new`; it also works straight away without the steps above, since it stops the running sous chef itself. The new sous chef starts the watcher again.

## How you hear about things

**Without Slack, nothing reaches you unless you are attached to sous chef.** A session's question or result wakes sous chef, which answers or decides to ask you, but that only appears in sous chef's conversation. If you are not in that terminal and Slack is not set up, nobody rings you, and a build session that asks a question at 10am waits until you next look.

**With Slack set up** (`sc slack setup`, once; `docs/domains/slack.md`), sous chef can message you in its bot's DM. Tell it what you want to hear about ("slack me when the orchestrate is ready", "slack me whenever a session needs me"); it writes that down and follows it. A forwarded question comes as its own thread, and your reply there is the answer. Anything you write to the bot, or a tag of the bot in a channel or thread, reaches sous chef within one watcher cycle (15 seconds), and it replies in the same place. Only your own messages are instructions. `sc slack` shows whether it is working.

So checking in is a manual step:

| What you want | Command |
| --- | --- |
| Talk to sous chef and see what it has for you | `souschef` |
| A quick look without attaching | `sc sessions`, or `sc summary` for the fuller picture |
| What sous chef has not handled yet | `sc events` (read-only until you acknowledge; do not acknowledge on sous chef's behalf) |
| One session in detail | `sc status <id>` |

## Everyday commands

`sc --help` and `sc <command> --help` are the reference. The ones the owner is most likely to use directly:

- `sc sessions`: what is running, who each session is waiting on, and, when Claude Code's job file says, what it is doing and which subagents it has running (`sc status <id>` lists them all).
- `sc status <id>`: one session's details, recent events and open questions.
- `sc attach <id>`: the command to open a session.
- `sc events`: what sous chef has not handled yet.
- `sc cron`: scheduled jobs, when each last fired and when it is next due.
- `sc context`: how full sous chef's context is and when it is warned; `sc context check` reads it now.
- `sc owner`: who this sous chef works for, and their branch prefix.

## When something seems missing

A session reported something and sous chef never mentioned it. Work from the durable end backwards, because the file is always written before anyone is woken:

1. **Is it on disk?** `sc status <id> -n 50`, or read `my/state/sessions/<id>/events.jsonl`. If the event is not there, the session never reported it: look at the session itself (`claude logs <short id>`).
2. **Does sous chef still owe it?** `sc events`. If the event is on disk but not listed here, sous chef has already acknowledged it.
3. **Can the wake-up reach sous chef?** `sc chef` prints the registered session; it needs a `pid` in `claude agents --json`. Without one, wake-ups quietly fail and events wait on disk.
4. **Is the watcher running?** Top of `sc summary`, or `my/state/watch.log`. The watcher is what retries a lost wake-up, so without it one lost wake-up is never retried.
5. **Did a hook fail?** `my/state/hook-errors.log` (or the core's `state/hook-errors.log` when there is no data folder). Hooks never fail the session they run in, so their errors appear nowhere else.

**An acknowledged event does not come back.** `my/state/cursors.json` holds the highest acknowledged event per session, and there is no command to move it back. Read the log (`sc status <id> -n 50`) instead. Open questions are the exception: they are recomputed from the whole log, so they keep appearing in `sc events` until they are answered.

## After a reboot

1. Run `souschef`. That starts or resumes sous chef, which starts the watcher again (the watcher is not a system service).
2. Run `sc sessions`. The watcher resumes sessions that did not survive and were waiting on the owner, sous chef or something external (up to its limits, `docs/domains/watcher.md` check 1). For any other session it did not expect to be stopped, it adds a `gone` event.
3. `sc resume <id>` brings a session back with its conversation, or `sc cleanup <id>` retires it.

Whether Claude Code's background sessions survive a reboot has not been tested; the records, event logs and inbox messages under `my/state/` do, because they are files.

## Environment variables

Sous chef needs none of these to run; they exist for the watcher's timing and for tests.

| Variable | Used by |
| --- | --- |
| `SC_WATCH_POLL`, `SC_SILENT_GRACE`, `SC_INBOX_GRACE`, `SC_INBOX_RINGS`, `SC_WAKE_RETRY`, `SC_GONE_GRACE`, `SC_STALE_BUSY` | The watcher's timing (`docs/domains/watcher.md`) |
| `SC_IDENTITY_WAIT` | How long `sc report` waits for a just-launched session's record (default 25 seconds) |
| `SC_TEST_HOME`, `SC_FAKE_NOW`, `SC_CHEF_RUNTIME`, `SC_WATCH_DISABLE_ENSURE`, `SC_FAKE_LAUNCH_FAILS`, `SC_FAKE_RESUME_FAILS` | Tests only: the data folder, the clock, the runtime recorded for sous chef and the one `souschef` starts and resumes it on, suppressing the real watcher, and making a fake launch or resume fail |
| `SC_TEST_CODE_FILE` | Tests only: one more file the watcher counts as its code (`codeFingerprint` in `src/watch.ts`), so a test can make the watcher restart by changing that file |
| `SC_UNDER_TEST` | The test suite only, never `sc`: the code root whose `sc` the suite tests (see "Tests" below) |

Sessions are never launched with any of these; see "Which session is calling" in `docs/domains/sessions.md`.

## Tests

```sh
cd ~/.sous-chef
npm ci && npm run build
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests
npx vitest run
```

`npm test` does the same in one command (build, vitest, then the Python suite). The suite runs the real `sc` command against a temporary home using the `fake` runtime, so it starts no Claude sessions. `WatcherCodeTests` and `CronWakeNoteTests` start real watcher processes from a temporary copy of the code and stop them afterwards; the live watcher is never touched. Claude Code behaviour is checked by hand; `docs/domains/sessions.md` lists what was verified.

To run the suite against another code root (a folder with an executable `bin/sc` and `bin/souschef`, such as another checkout or a staged copy), name it with an absolute path:

```sh
SC_UNDER_TEST=<code root> PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests
```

The tests come from this checkout and the `sc` from the code root. Tests marked Python-only (the Python sc's internals) are skipped when that `sc` is not the Python one; `AGENTS.md` ("Testing") says how this is decided.

`npx vitest run` runs the TypeScript unit tests in `tests/*.test.ts`; the launcher tests need a build. The Python behaviour tests above stay the gate for behaviour until they are ported (TRV-1157).

The captured-output tests (`tests/test_captured.py`) compare output word for word with the files in `tests/captured/`, with paths, session ids and the fake relay's port replaced by placeholders. After a deliberate change to that output, run the suite with `SC_UPDATE_CAPTURED=1` to rewrite the files, and check their diff: it is the list of what changed for the owner.

The suite must pass in the core as published, which ships only the core's two kinds: tests that run a copy of the code use `tests/core_paths.py` (the core's path list), which copies only core files.

To try the whole flow with real sessions without touching real state, make a throwaway install: `git worktree add --detach <scratch>/core HEAD`, then `<scratch>/core/install.sh --data <scratch>/data --name <you> --no-git --bin-dir <scratch>/bin --yes`, and use the copy's own commands (`<scratch>/core/bin/souschef --print`, `<scratch>/core/bin/sc`). Sessions it launches use the copy's `sc` by full path. Background sessions only start in a folder Claude Code trusts (you ran `claude` there and accepted the prompt), so give them such a `--cwd`. Afterwards stop and `claude rm` the test sessions, stop the copy's watcher (`<scratch>/data/state/watch.pid`), and `git worktree remove` the copy. Do not use environment variables to redirect a real sous chef; sessions can start with stale ones.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `sc` says "no data folder" or "my points to ..., which does not exist" | The `my` link in the core is missing, broken, or never made. Run `install.sh` (a new or existing data folder) or re-point the link (`ln -sfn <data folder> ~/.sous-chef/my`), as the message says |
| `[sync] sync-stopped` in `sc events` | The watcher stopped pushing the data folder. After a conflict: rebase or merge by hand in the data folder (`git -C ~/.sous-chef/my status`); syncing starts again by itself once the checked-out commit changes. After failed pushes: usually offline; it starts again once a fetch works. `docs/domains/watcher.md`, check 9 |
| Summary says the watcher is not running | `sc watch --ensure`, then `my/state/watch.log` |
| Summary says the watcher is not on current code | `sc watch --ensure` replaces it and says what it did; if it could not, `my/state/watch.log`. A watcher on the current code restarts itself after a code change, so this means one started by older code, or new code that does not load (the log says which) |
| Sous chef is not woken by sessions | `sc chef` shows the registered session; it must be running (`claude agents`). Events are still on disk: `sc events` |
| A session never picks up messages | `sc status <id>` (running? unhandled messages?), `claude logs <short id>` |
| `sc spawn` says the session did not start | The error includes Claude Code's output; a common cause is an expired login (`/login`) |
| A hook seems to do nothing | `my/state/hook-errors.log`; hooks never fail the session they run in, so errors only appear there |
| Edit or Write refused with "hasn't isolated its changes yet" | Claude Code's background isolation in a normal clone. The core turns it off in `.agents/settings.json`; for a session, launch it in a worktree created with `sc worktree` |
| `souschef` started a new session instead of resuming | It could not bring back the registered one (the message says so). The old conversation still exists: `claude --resume <id>` |
| `sc report` says the Claude session is not one sous chef launched | It was run outside a session sous chef launched, or the record lost its Claude id; check `sc status <id>` |
| A scheduled job did not fire | `sc cron list` (a warning at the top? overdue? broken definition? last result?), then `my/state/watch.log`. `sc cron run <name>` fires it by hand and says what it wrote and who was woken. Jobs fire only while the watcher and sous chef are both running; see `docs/domains/cron.md` |
| Sous chef was compacted without a context warning | `sc context`: is it `OFF`, `FAILING` (with the reason), or has the Stop hook never run ("Last check: never")? Then `my/state/hook-errors.log`; see `docs/domains/context.md` |
| `sc cleanup` refuses | It found uncommitted changes or commits no remote has in the session's working directory. Look first; `--force` only with the owner's agreement |

## Resetting

`my/state/` holds only runtime records. Stopping every session (`sc stop`) and deleting `my/state/` returns sous chef to empty; memory in `my/memory/`, job definitions in `my/cron/` and the context check's settings in `my/context.json` are untouched. Jobs then wait for their next scheduled time, as new ones do. Claude sessions it launched remain in `claude agents` until removed with `claude rm`.
