# Architecture

Sous chef is a Claude Code session with a job description (`AGENTS.md`), a command line tool (`sc`) and two folders of files: the core (the shared code) and the owner's data folder. The owner talks to sous chef; sous chef keeps notes and launches other Claude Code sessions to do the work, keeps track of them, and passes messages between them and the owner.

There is no server or daemon to install. Everything is either a file in one of the two folders, a Claude Code background session, or a small watcher process that sous chef starts itself.

## Two folders joined by one link

The **core** is the code everyone shares (the sous chef repo): `bin/`, `src/` (the code, TypeScript on Node 22 or later, compiled into `dist/` by `npm run build`), `templates/`, `docs/`, `tests/`, the core kinds, `AGENTS.md`, `.agents/` and `install.sh`. It runs from `~/.sous-chef`, because Claude Code's trust, its saved conversations and every brief's `sc` path are keyed to that path.

The **data folder** is the owner's own: their memory, cron jobs, kinds, owner file, instructions, settings, `state/` and `.env`. It lives wherever the owner chose at install (by default `~/.my-sous-chef`) and may be a private git repo of its own, which the watcher keeps committed and pushed.

The core reaches the data folder through one link, `<core>/my` (gitignored). `util.home()` returns that path, through the link and not resolved, so paths written into briefs stay valid if the data folder moves and the link is re-pointed. Without a usable link, every command that needs data refuses and names the fix: no link means run `install.sh`; a broken link names its target. Help, the hooks and `sc setup` work without it. Tests point the data at a temporary folder with `SC_TEST_HOME` instead. Why it is built this way: decision 0020 (the core and the owner's data are separate repos joined by one link).

`install.sh` checks `node` (22 or later), `npm`, `git` and `claude`, brings the install up to date (runs `npm ci` when the dependencies are missing or older than `package-lock.json`, and `npm run build` when the build is missing or stale), then runs `sc setup` (`src/setup.ts`), which makes or connects the data folder and the link; see `docs/operations/running.md`.

## The parts

```mermaid
flowchart LR
    D[the owner] -- chat --> SC[sous chef session<br/>Claude Code in the core, ~/.sous-chef]
    D -. claude attach .-> W1
    SC -- sc spawn / sc send --> CMD[sc command<br/>bin/sc, src/]
    CMD -- claude --bg --> W1[session: build]
    CMD -- claude --bg --> W2[session: shape]
    W1 -- sc report / sc inbox --> CMD
    W2 -- sc report / sc inbox --> CMD
    CMD -- files --> ST[(my/state/<br/>records, event logs, inboxes)]
    WA[watcher<br/>src/watch.ts] -- reads --> ST
    CMD -- wake-up message --> SC
    WA -- wake-up message --> SC
    WA -- wake-up message --> W1
    SC -- edits --> MEM[(my/memory/<br/>focus, threads, ideas, PoCs, repos)]
    WA -- commits, pushes --> DR[data repo<br/>the owner's, private]
    WA -- polls, acknowledges --> RL[messaging relay<br/>separate service]
    CMD -- sc slack --> RL
    RL <--> SL[Slack]
```

| Part | What it does | Where |
| --- | --- | --- |
| Sous chef session | Talks to the owner, keeps memory, decides what to launch, handles what sessions report | Any Claude Code session started in the core, normally the background session `souschef` opens (`bin/souschef`, `src/souschef.ts`); instructions in `AGENTS.md` plus the owner's own in `my/instructions.md` (shown in the startup summary), hooks in `.agents/settings.json` |
| `sc` | Every mechanical action: launching, messaging, reporting, reading events, cleanup. When whatever reads its output stops early (`sc status <id> \| head`), it stays quiet and exits as it would have (`ignoreClosedOutput` in `src/io.ts`). That matches the Python sc for output that fits in the pipe; for more, Python printed a BrokenPipeError traceback and exited 1, and the difference is deliberate (the owner's ruling) | `bin/sc`, `src/cli.ts`, `src/ops.ts`, `src/io.ts` |
| Sessions | Claude Code background sessions doing one task each, which the owner can open | Launched by `ops.spawn`; brief from `templates/worker-brief.md` plus the kind's file and the owner's `my/worker-instructions.md`. Kinds come from the owner's kinds (`my/kinds/`) first, then the core's (`kinds/`). The core kinds are `general` and `investigate`, which need no skills; a kind that runs a skill declares it, and `sc spawn` refuses it when the runtime says the skill is missing |
| State | Session records, event logs, inboxes, sous chef's read positions, watcher files | `my/state/` (never tracked), written by `sc`; the one file written directly is a session's own `report.md` |
| Memory | Sous chef's own notes | `my/memory/`, edited directly by sous chef |
| Owner | Who this sous chef works for: the name it uses for them everywhere it writes, their branch prefix, and the permission mode sous chef's own session starts in (`chef_permissions`, `auto` or `bypass`, `auto` when unset). The code and docs name nobody; the startup summary opens with the owner | `my/owner.json`, written by `sc setup` or `sc owner set`, read only through `util.owner()`; decision 0018, and decision 0031 (sous chef's own permission mode is the owner's setting) |
| Watcher | A loop that uses no tokens and wakes sous chef or a session when something needs attention, fires scheduled jobs, and keeps the data folder committed and pushed | `src/watch.ts`, started by sous chef's SessionStart hook |
| Cron jobs | Tasks on a schedule, done by sous chef itself or by a session launched for them | Definitions in `my/cron/<name>.md`, run record in `my/state/cron/`; `src/cron.ts` |
| Context check | Sous chef's Stop hook: reads how full its context is from Claude Code's transcript and, past a set level, leaves a warning to write working state to memory before compaction | `src/context.ts`, settings in `my/context.json` |
| Slack | Sous chef's messages to the owner in Slack, sent through the messaging relay (a separate service) with the owner's key; config in `my/.env`, never tracked | `src/slack.ts`, `src/relay.ts`; see `docs/domains/slack.md` |
| Install | Makes or connects the owner's data folder and the `my` link, and links `sc` and `souschef` | `install.sh`, `src/setup.ts` (`sc setup`) |
| Runtime | The only code that knows how a session actually runs | `src/runtimes/` (`claude-bg.ts`, and `fake.ts` for tests). The Claude runtime reaches sessions through Porch, used as a library installed from npm: listing, status, waking, launching and turn times go through Porch, while resume, stop and attach run `claude` directly (decisions 0033 and 0026; `docs/domains/sessions.md`, "The Claude runtime"). |

## How the main flows work

**Opening sous chef.** `souschef` attaches to the registered sous chef background session, resumes it if it is stopped, or starts a new one; see `docs/operations/running.md`.

**Launching a session.** For work that changes code, sous chef first runs `sc worktree` to create a branch and worktree in the owner's repo layout. Sous chef runs `sc spawn --kind <kind> --title <title> --cwd <dir>` with the task on stdin. `ops.spawn` refuses a kind whose skill the runtime says is missing in that directory, then writes the session record and brief under `my/state/sessions/<id>/`, appends a `launched` event, and asks the runtime to start the session. The Claude runtime runs `claude --bg` through Porch's launch plan, with the brief's path as the prompt and the session's hooks, plus Porch's, passed in one `--settings`; the session is later recognised by its Claude session id, not by anything in its environment. `sc spawn` prints the attach command. Details: `docs/domains/sessions.md`.

**A session reporting back.** The session runs `sc report <state> "<text>"`. `ops.report` works out which session is calling from the Claude session id Claude Code sets, appends the event to that session's log, and, for states that need attention, sends sous chef a one-line wake-up. Sous chef runs `sc events`, handles what it sees, then acknowledges with the token `sc events` printed. Details: `docs/domains/messaging.md`.

**Sous chef messaging a session.** Sous chef runs `sc send <id> "<text>"` (with `--resolves <key>` when it answers a question). `ops.send` saves the message in the session's inbox and sends the session a one-line wake-up. The session runs `sc inbox`, acts, and runs `sc inbox ack <n>`. Details: `docs/domains/messaging.md`.

**Noticing problems.** The watcher checks every 15 seconds for sessions that stopped without saying why, sessions that disappeared, messages nobody picked up, and events sous chef has not read. It writes what it finds into the session's event log and wakes sous chef. A session that disappeared while it was waiting on someone else (the owner, sous chef, or something external) is resumed by the watcher itself, which wakes sous chef only if that fails (decision 0017, the watcher resumes sessions that stop while idle). Details: `docs/domains/watcher.md`.

**Scheduled jobs.** `sc cron add` writes a job's definition to `cron/<name>.md`. When a job is due and sous chef is running, the watcher fires it: a job for sous chef appends an event to the cron log, which sous chef reads with `sc events` like a session's; a job for a worker launches a session with `ops.spawn`, or, if the job's previous session is still going, sends the task to its inbox. Either way the target is woken if it is idle and otherwise picks the message up when its turn ends. Details: `docs/domains/cron.md`.

**Slack.** When the data folder has a Slack config (`my/.env`), the watcher collects the owner's Slack messages from the messaging relay every cycle, writes them to sous chef's slack log, acknowledges them, and wakes sous chef at once. Sous chef reads them with `sc events` and answers through `sc slack`, which posts through the relay as its bot. A session's question can be posted as its own thread (`sc slack ask`), and the owner's reply there comes back labelled with the question. Details: `docs/domains/slack.md`.

**Surviving compaction and restarts.** Sous chef's SessionStart hook runs on startup, resume, clear and compaction. It registers the session as sous chef, makes sure the watcher is running, and injects a bounded startup summary built from `my/state/`, the owner's instructions and `my/memory/`. Because everything that matters is in files, a compacted or brand new sous chef session picks up where the last one was. Details: `docs/domains/memory.md`. So that the files are current when a compaction comes, sous chef's Stop hook reads how full its context is at the end of each turn and, past a set level, writes a warning into the context log asking it to write down what it is holding; see `docs/domains/context.md`.

## Design rules

- **Files are the record; wake-ups are best effort.** Every event and message is written to disk before anyone is woken. A lost wake-up delays attention and the watcher retries it; it never loses the message. See decision 0002 (files are the record, wake-ups are best effort).
- **Mechanics are commands; judgment is instructions.** Sessions and sous chef never handle `state/` files by hand. See decision 0003 (commands for mechanics).
- **One place knows how sessions run.** Only `src/runtimes/` calls `claude`. See decision 0004 (Claude only, behind a runtime layer).

## Known limits and shortcuts

These are deliberate PoC shortcuts. Each has a safeguard, and each is something a production version must deal with.

| Shortcut | Safeguard | What production must do |
| --- | --- | --- |
| Wake-ups go through Porch's `deliver`, which uses Claude Code's local message socket (the path the session's own hook recorded, else paths worked out from its pid), observed rather than documented (Porch's `docs/domains/claude-adapter.md`). Porch puts `[from sous chef] ` before every wake-up | A failure names Porch's reason, and `sc send` and `sc report` print it rather than assuming the session is stopped; messages are on disk first, and the watcher retries | Use a supported messaging interface if Claude Code publishes one (a change in Porch) |
| Sous chef uses Porch's default records folder (`~/.porch`) and never sets `PORCH_HOME`: a worker's `sc report` sets its Porch status from the worker's own environment, which can be stale, so only the default folder is certain to be the one its hooks write to. Setting `PORCH_HOME` for sous chef is not supported | Nothing in sous chef sets it; the tests set it only for their own temporary Porch | Nothing, unless sous chef ever needs a second records folder |
| Porch's hook commands, baked into each session's launch settings, name `<core>/node_modules/@dylankuhlenthal/porch/dist/cli/main.js` and the Node that launched it. `npm ci` deletes and rebuilds `node_modules`, so those hooks fail while it runs (Claude Code does not read their exit 1 as blocking); turn times are missed for that moment | Porch's hooks never block a session; a later Porch version keeps the same path | Nothing further while hooks stay best effort |
| Sous chef's own hooks (`.agents/settings.json`) and hook commands saved by sessions started before the move to TypeScript run `bin/sc` directly, whose first line finds `node` on `PATH`. Hook commands sous chef writes now name the Node that ran `sc` (`process.execPath`), so removing that Node version breaks them until the session is relaunched | `install.sh` says which Node it found; Claude Code's background processes on the development Mac carry a `PATH` with Node 22 (seen 2026-10-01); a hook that cannot start shows as a hook error and blocks nothing (`docs/operations/running.md`, "The build, and updating after a pull") | Launchers that fall back to a Node path recorded at install, or hooks that name it |
| The watcher is started by sous chef's SessionStart hook, not by a system service | The startup summary says when the watcher is not running | Run it under launchd so it survives reboots without sous chef starting |
| Sessions run in their kind's permission mode unless a spawn chose another (`sc spawn --permissions`, decision 0010): a kind may set `bypass` (decision 0016, kinds set their default permission mode; the owner's own kinds may, the core's two do not), and every other session runs in `auto`. In `auto` Claude Code's classifier decides what a session may do unattended, and in `bypass` nothing asks. Sous chef's own session runs in the mode the owner chose at install (`auto` by default, `bypass` if they chose it; decision 0031), and in `bypass` nothing it does waits for a person, though it reads what sessions report and, with Slack, messages from other people | The brief's rules and sous chef's instructions (never merge into `main` or `staging`, ask before anything outward-facing, only the owner's words are instructions), and `auto` for the core's `general` and `investigate` sessions. A session held at a prompt is reported by the watcher (`prompt-waiting`) | Structural guards: branch protection on `main` and `staging`, or a hook that blocks those merge commands |
| `claude agents --json` fields (`id`, `sessionId`, `name`, `kind`, `pid`, `status`, `waitingFor`) are read without a documented contract, and so are `needs`, `detail`, `inFlight` and `fan` in Claude Code's job file (`~/.claude/jobs/<short id>/state.json`, read from 2.1.278). Porch reads them now (its `docs/domains/claude-adapter.md` lists what it relies on); sous chef reads the listing's `kind` from Porch's `raw.listing`, which Porch documents as for debugging, pinned by the tag | A listing status Porch cannot place gives `unknown`, which sous chef reads as running with busy unknown, never idle. `waiting` was confirmed live and in Claude Code's code (`docs/domains/watcher.md`, "How a prompt is detected"); `needs` only adds detail to a `prompt-waiting` event, and an unreadable file is ignored. `inFlight.tasks` holds back silent stops only while it is a whole number above 0, and for at most 2 hours after a turn ends (`docs/domains/watcher.md`, "Work in flight"); a missing or reshaped field gives today's behaviour. The watcher does not trust the status alone: a session counts as idle when its own turn record shows its turn ended at least 5 minutes ago, and `gone` needs the session missing for a minute (`docs/domains/watcher.md`) | Pin to a documented schema if one is published |
| Background sessions stop by themselves about an hour after their last activity, most likely Claude Code stopping idle background sessions; this was seen three times on one session and inferred from a one-hour constant in Claude Code's code, not confirmed | The watcher resumes a session that stopped while waiting on someone else and tells it to restart what was tied to its old process, at most 24 times in 24 hours and not again when it stops within 10 minutes of a resume (`docs/domains/watcher.md`, check 1) | Keep sessions from being stopped in the first place, if Claude Code offers a setting for it |
| Claude Code's background worktree isolation is turned off for sous chef's own folder and for sessions in worktrees `sc worktree` created; everything else keeps the default | Only worktrees sous chef recorded, and only one active session per worktree | Nothing further observed in the owner's bare-repo layout, where isolation did not block edits anyway; revisit if Claude Code changes the rule |
| Environment variables passed at launch can be stale, because background sessions may start in a spare process created earlier | Nothing depends on them: identity comes from `CLAUDE_CODE_SESSION_ID`, paths from the brief and hooks | Keep it that way; if Claude Code documents per-session environment, it could simplify the brief |
| Stopped and archived sessions stay in `claude agents` until removed with `claude rm` | None; they only clutter the agent view | Decide whether `sc cleanup` should also remove the Claude session |
| Context usage is read from Claude Code's session transcript (`message.usage` on assistant lines), a format observed rather than documented (`src/context.ts`) | Anything unexpected is reported as a failure (a `context-unreadable` event, and `FAILING` in `sc context` and the startup summary), never as a low reading | Read usage from a documented source if Claude Code publishes one |
| One sous chef runs at a time, on one machine | On a fresh start (not a resume or compaction) the summary warns when a different sous chef session was registered before. The data folder is pushed by the watcher, so another machine can clone it, but two sous chefs writing the same data folder at once would conflict (syncing stops and says so) | Decide how two machines share one owner's data, if that is ever wanted |
| Nothing reaches the owner unless they are attached to sous chef, or Slack is set up (`docs/domains/slack.md`) | The records wait on disk, and `sc events` still lists open questions when they next looks; with Slack on, sous chef forwards what the owner asked for (`## Slack me` instructions) and questions (`sc slack ask`) | Send only what the owner asked for, as now; decide whether anything should reach them without an instruction |
| Slack runs through the messaging relay, which runs on the owner's laptop behind ngrok, and only while the watcher runs (started by sous chef) | Messages wait on the relay for up to seven days and arrive marked late with their age; an unreachable relay is shown in the startup summary and `sc slack status`; a failed send says why. Nothing is queued to send later | Run the relay on Railway (only the URL in `.env` changes), and the watcher under launchd |
| Slack's user and channel ids stay in their raw form (`<@U...>`, `<#C...>`) apart from the bot's own tag | The owner's messages are recognised by their Slack id from `.env`, and everyone else's are marked `NOT FROM <NAME>` (the owner's name in capitals) | Look up names through the relay, which would need a Slack scope it does not have (`users:read`) |
| Scheduled jobs fire only while the watcher and the registered sous chef session are both running | Missed jobs fire once when sous chef is back; `sc cron list` shows the last and next firing | Run the watcher under launchd, if jobs must run while sous chef is down (decision 0009 chose not to) |
| Job definitions sync through git, so a job would fire on every machine where sous chef runs | Sous chef only ever runs in one place (the owner's ruling), which the design assumes | Record which machine a job belongs to, if that assumption ever changes |

## Where to read more

- `docs/domains/sessions.md`: session records, kinds, the Claude runtime, and the Claude Code behaviour it relies on.
- `docs/domains/messaging.md`: event logs, open questions, read positions, inboxes and wake-ups.
- `docs/domains/watcher.md`: the watcher's checks and settings.
- `docs/domains/cron.md`: scheduled jobs: where they live, how they fire, overlap and missed firings.
- `docs/domains/memory.md`: memory files, the startup summary, and surviving compaction.
- `docs/domains/slack.md`: Slack through the messaging relay: config, sending, the slack log and its labels, questions, tags and standing instructions.
- `docs/domains/context.md`: the context check, which warns sous chef before compaction.
- `docs/operations/running.md`: installing, starting, attaching, testing and troubleshooting.
- `docs/patterns/`: adding a kind, adding a runtime, and the documentation standards.
- `docs/decisions/`: why it is built this way.
