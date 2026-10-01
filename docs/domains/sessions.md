# Sessions

A session is one Claude Code background session that sous chef launched for one task. This doc covers what is stored about a session, how kinds shape it, how the Claude runtime runs it, and which Claude Code behaviour that depends on.

Code: `src/records.ts`, `src/kinds.ts` (`load`, `names`, `folders`), `src/cli.ts` (`cmdKinds`), `src/worktrees.ts`, `src/ops.ts` (`spawn`, `checkSkill`, `stop`, `resume`, `cleanup`, `workerSettings`, `workerEnv`, `currentSessionRecord`), `src/runtimes/`.

## What is stored

Each session has a folder `my/state/sessions/<id>/` (in the data folder). The id is `<kind>-<title slug>-<4 hex characters>`, from `records.newId`.

| File | Written by | Holds |
| --- | --- | --- |
| `record.json` | `ops.spawn`, `ops.stop`, `ops.resume` | id, created time, kind, title, working directory, runtime name, model and effort, `permissions` (what the session may do without asking; see "Permissions" below), thread slug, `handle_name` (the Claude session name, `sc-<id>`), `handle` (Claude short id and full session id), `own_worktree`, `stopped_by_sc`, and for a session a scheduled job launched, `cron` (the job's name) |
| `brief.md` | `ops.spawn` | The instructions the session was launched with |
| `events.jsonl` | `sc report`, `sc` commands, the watcher | The event log; see `docs/domains/messaging.md` |
| `inbox/` | `sc send`, `sc inbox ack` | Messages from sous chef; see `docs/domains/messaging.md` |
| `turns.json` | the session's hooks (`sc hook worker-prompt`, `sc hook worker-stop`) | `last_prompt_at` and `last_stop_at`, used by the watcher and `sc status`. Only sessions launched before the move to Porch write it: a session launched through Porch has Porch's hooks instead, and its turn times are read from Porch (see "The Claude runtime") |
| `report.md` | the session | Optional written deliverable (investigations) |

`sc cleanup` moves the folder to `my/state/archive/<id>/`. Nothing reads the archive; it is kept for looking back. A report path a session gave in its `done` event points into `my/state/sessions/<id>/`, so it stops resolving after cleanup: copy anything worth keeping into a memory thread first.

## Kinds

A kind is a markdown file named `<kind>.md`. Its front matter has a `description`, `starts_waiting_on` (`owner` or `agent`; the owner's name in lower case is accepted for `owner`), and optionally `permissions` (the session's default permission mode; see "Permissions" below) and `skill` (the one skill its instructions tell the session to run; see "Skills" below). Its body is inserted into the brief. `kinds.load` reads and checks it.

Kinds come from two folders, looked up in this order (`folders` and `find` in `src/kinds.ts`):

1. **User kinds**: `my/kinds/`, in the owner's data folder (`util.userKindsDir()`). These belong to the person running sous chef.
2. **Core kinds**: `kinds/` in the core (`util.kindsDir()`). These ship with sous chef.

A user kind replaces the core kind of the same name as a whole file; nothing is merged. A user kind with a new name is simply added. When the two folders are the same folder (only when a test points the data folder at the code folder) there is only the core: each kind is listed once and none is marked as a user kind. Tests give the data folder its own temporary folder (`SC_TEST_HOME`), so they can write user kinds there. A kind name must be lowercase kebab-case (`[a-z0-9][a-z0-9-]*`); any other name is refused as an unknown kind, so `--kind` can never read a file outside the two folders.

The core kinds need no skills:

| Kind | Starts waiting on | Permissions | Skill | Runs |
| --- | --- | --- | --- | --- |
| `investigate` | agent | (auto) | none | read-only research ending in `report.md` |
| `general` | agent | (auto) | none | whatever the task says |

Any other kind is the owner's, in `my/kinds/`; kinds that run a skill (the first owner's `shape`, `build`, `mega-shape` and `orchestrate`, say) live there, since the skills are the owner's too. A test checks the core ships only these two (`KindPermissionsTests`, run against a copy of the core as published).

`sc kinds` lists every kind with its description, its permissions when set, `skill: <name>` when it declares one (with `(not found in your skills)` when the runtime says it is missing), and `[user]` or `[user, replaces core]` for user kinds. It also prints a warning under any kind whose instructions never mention `/<skill>` as a whole name (`/shape-gui` does not count for `shape`) for the skill it declares, so the field and the instructions cannot drift apart unnoticed. Like `sc spawn`, it has a hidden `--runtime` flag, defaulting to `claude-bg`; the tests pass `--runtime fake` so their output never depends on the skills installed on the machine running them.

### Skills

A kind declares at most one skill: the one its instructions tell the session to run, as a bare name without a slash (`skill: build`). Skills that skill calls in turn (for example `/build` calling `/red-review-2`) are not declared.

`sc spawn` checks the skill before anything is written (`ops.checkSkill`). It asks the session's runtime `skillAvailable(name, cwd)` with the session's own working directory, and gets one of three answers:

- found: the session launches as before;
- cannot tell: the session launches as before (the Claude runtime cannot tell for a name with a colon, such as `anthropic-skills:docx` or `plugin:skill`);
- missing: `sc spawn` refuses, naming the skill, the places it looked, and the user kinds folder where the person can put their own version of the kind. No record, brief or event is written, as for an unknown kind.

There is no flag to skip the check. If the check is wrong, the fix belongs in the runtime; meanwhile, a user kind of the same name without the `skill` line replaces the refused one. While the two kinds folders are the same folder there is nowhere separate to put it, so the refusal says to change the kind file itself instead. `sc cron add` makes the same check for a worker job, with the job's working directory and its own `runtime` field. `sc cron list` and loading a job do not check skills; a job whose skill has gone missing since it was added is refused when it fires, which shows as a `failed` cron event (`docs/domains/cron.md`).

The spawn check cannot see every skill or tool a session needs, so the brief also tells every session to report `blocked`, naming the skill or tool, when something it needs is not available.

`starts_waiting_on` only sets the first value of the session's "waiting on" (a `launched` event). From the owner's side all kinds are the same: any session can be attached to. The value decides what sous chef tells the owner at launch ("ready for you" or "started") and keeps the watcher from treating an idle shape session as stopped. See decision 0005 (the task decides who drives, not the session type).

## The brief

`ops.renderBrief` fills `templates/worker-brief.md` with the session id, `sc`'s full path, kind, title, working directory, a note about the worktree, the report path (through the `my` link, so it stays valid if the data folder moves), the kind's instructions, the owner's instructions for sessions and the task text, and fills `{{owner}}` with the owner's name from `my/owner.json` (it refuses without one). The kind's instructions get the owner's name first; then the template is filled in one pass (`util.render`), so placeholders inside a value are never filled: a task that says `{{owner}}` keeps saying it. `cron.workerTask` fills the scheduled job note (`templates/cron-worker.md`) the same way. The brief tells the session:

- the full path of the `sc` command, which it uses instead of anything in its environment;
- whether its working directory is a worktree created for it (see "Worktrees" below);
- who the owner and sous chef are, and that the owner's words in the session are authoritative;
- how and when to report (`sc report`), and to never stop without saying why;
- how to read and acknowledge messages (`sc inbox`);
- not to reach the owner through any other messaging tool, but to report, so that sous chef is the one sender in Slack and every reply comes back to it (`docs/domains/slack.md`);
- what it may do without asking: what the task names, never merging into `main` or `staging`, asking before anything destructive or outward-facing, and asking before writing to the issue tracker or repo docs unless the task is to do that. See decision 0006 (ask unless the task is to do the thing).
- under **Instructions from your owner**, between the kind's instructions and the task, the owner's `my/worker-instructions.md` as written (never filled in, `<!-- comments -->` left out; `ops.ownerInstructionsSection`). With no file, or nothing but comments in it, the section is left out. This is where rules that name the owner's own tools belong (for the first owner: ask before writing to Linear; do not use the `slack-me` skill), so the core's template names none. It reaches every session sous chef launches, including ones a scheduled job launches. Verified with a real session launched from a fresh install: its brief had the section, and it followed it.

The launch prompt is only a pointer to the brief file, so the full instructions do not travel through the command line.

A session launched by a scheduled job gets `templates/cron-worker.md` added after its task, telling it the run was scheduled, to report `nothing-new` when it finds nothing worth reporting, and that a later run may arrive in its inbox; see `docs/domains/cron.md`.

## Launching

`ops.spawn` refuses an unknown kind, an empty task, a working directory that does not exist, a working directory inside the core (a session there would load sous chef's own `AGENTS.md` and hooks) or the data folder, and a kind whose skill the runtime says is missing ("Skills" above). The two working directory checks are `ops.checkCwd`, which `sc cron add` also runs for a worker job, along with the skill check. It then saves the record and brief, appends `launched`, and calls the runtime's `launch` with:

- **Environment** (`ops.workerEnv`): only `PATH`, with `bin/` added at the front when it is not already there, as a convenience. Nothing depends on it, because a background session can run with an earlier launch's environment (see below).
- **Settings** (`ops.workerSettings`): the hooks below, plus `"worktree": {"bgIsolation": "none"}` when the session runs in a worktree sous chef created for it.
- **Hooks**: a PreToolUse hook runs `sc hook guard-edit`, which denies the file-editing tools under `my/state/` except the session's own `report.md`, so one session cannot hand-edit another's records. SessionStart runs `sc hook worker-start` (reminds a resumed or compacted session of its brief and unread messages), UserPromptSubmit runs `sc hook worker-prompt`, and Stop runs `sc hook worker-stop` (both record turn times in `turns.json`). `ops.workerSettings` stays the same for every runtime; the Claude runtime drops the `worker-prompt` and `worker-stop` entries before launching, because Porch's own hooks record turn times for the sessions it launches. The commands stay in `sc` for sessions launched before the move to Porch, which keep calling them for the rest of their life (Claude Code keeps a session's launch settings across resume). Hooks are passed at launch, so nothing is written into the repo the session works in.

If launching fails, a `failed` event is appended and the error is shown.

## Permissions

`sc spawn --permissions <value>` sets how much a session may do without asking a person. The values are sous chef's own, listed with a description in `runtimes.PERMISSIONS` (`src/runtimes/types.ts`) and in `sc spawn --help`:

| Value | Means | Claude Code permission mode |
| --- | --- | --- |
| `auto` (the default when neither the flag nor the kind sets one) | a classifier decides each action; anything it judges risky waits for a person | `auto` |
| `accept-edits` | file edits go ahead; other actions wait for a person | `acceptEdits` |
| `bypass` | everything goes ahead; nothing ever asks | `bypassPermissions` |
| `ask` | every action that needs permission waits for a person | `manual` |

The mode for a new session comes from, in order: the `--permissions` flag when it is given, the kind's `permissions` front matter (`kinds.load` returns it as `kind.permissions`, or null), and `runtimes.DEFAULT_PERMISSIONS` (`auto`). `ops.spawn` does this; the flag has no default in the argument parser so that an explicit `--permissions auto` still wins over a kind's `bypass`. `sc kinds` shows a kind's mode when it sets one. `kinds.load` refuses an unknown value in a kind file, so both `sc spawn` and `sc kinds` fail on it rather than ignoring it.

`ops.spawn` refuses a value not in that list and records the value in `record.json`, so `sc status` can show it. A record from before this existed has no value, and means `auto`, which is what such sessions were launched with. Only the runtime turns the value into the tool's own setting (`PERMISSION_MODES` and `permissionMode` in `src/runtimes/claude-bg.ts`); the `fake` runtime (`src/runtimes/fake.ts`) records it.

The core's `general` and `investigate` launch in `auto`. The first owner's own skill kinds (`shape`, `build`, `mega-shape` and `orchestrate`, in their `my/kinds/`) launch in `bypass`, by their ruling. They were told the risk first: build and orchestrate sessions push to shared repos and merge into integration branches, and the prompt that held the TRV-1114 orchestrator (the Moodle auth work) was for a script that drops and restores the shared Postgres and Mongo databases every studio-api worktree uses. Under `bypass` such a command runs with nobody seeing it, and the watcher's `prompt-waiting` report cannot catch it because there is no prompt. See decision 0010 (permission mode chosen per spawn) and decision 0016 (kinds set their default permission mode, and the skill kinds run in bypass). A session held at a prompt is reported by the watcher (`prompt-waiting`, `docs/domains/watcher.md`).

Scheduled worker jobs launch through `ops.spawn` without a flag, so a job takes its kind's mode. The only job today, `inbox-triage`, is kind `general`, so it runs in `auto`; a job of a kind that sets `bypass` would run in `bypass`.

A session keeps its permission mode when resumed. `sc resume` passes no flags (below), and Claude Code reuses the flags it saved at launch.

Sous chef's own session is not spawned: `souschef` starts it with the runtime's `startNamed` (the Claude runtime's for real, through Porch's launch plan; the fake runtime's in tests, chosen by `SC_CHEF_RUNTIME`), passing `souschef.PERMISSIONS`, which is `bypass`, through the same mapping. See decision 0015 (sous chef itself runs in bypass mode) and "Start sous chef" in `docs/operations/running.md`.

## Which session is calling

`sc report` and `sc inbox` find the calling session from `CLAUDE_CODE_SESSION_ID`, which Claude Code sets for each session, by matching it against the `handle.session_id` in the records (`ops.currentSessionRecord`, `records.findByClaudeSession`). Right after launch the record may not have the id yet, so the lookup waits up to 25 seconds (`SC_IDENTITY_WAIT`). A Claude session sous chef did not launch is refused.

Sous chef never passes a session its own id or paths through environment variables. Claude Code keeps spare processes ready for background sessions, and a new session can start in a spare that was created with an earlier launch's environment. This was seen in a live test: a second session launched straight after a first one had the first session's variables. Its hooks and launch prompt were correct, because those are passed as arguments.

For the same reason, the core is always the folder `sc` is installed in (`util.CODE_ROOT`), and the data folder is always found through the `my` link in it (`util.home()`), never through a variable. `SC_TEST_HOME` moves data to a temporary folder for tests only, and no session is ever launched with it.

## Worktrees

`sc worktree --repo <root> --branch <branch> --dir <name> [--base <branch>]` (`worktrees.create`) creates a branch and worktree in the owner's repo layout (see the `repo-setup` skill):

1. Checks the repo root is a git repository, the folder and branch do not exist yet, and the folder name is short kebab-case.
2. Fetches `origin` and branches from `origin/<base>` without tracking. `--base` defaults to origin's default branch, falling back to `main` when `origin/HEAD` cannot be read. It does not touch a local base worktree the owner may be using. The first push sets the upstream.
3. Links `.env*` files from `<root>/.local/` into the worktree with relative symlinks, and says when there are none.
4. Records the worktree in `my/state/worktrees.json`. It does not install dependencies.

Every change to that record (`sc worktree`, a spawn that claims a worktree, a cleanup or failed launch that frees one) first drops entries whose folder no longer exists and that no active session holds (`prune` in `src/worktrees.ts`). So a worktree removed by hand leaves the record the next time it changes. An entry whose folder exists is never dropped, and neither is one an active session holds; that one goes once the session is cleaned up.

`--base` can be any branch that exists on `origin`, not just the default branch, so a session can start from someone else's branch (for example the head of a pull request under review).

`--branch` is always a **new** branch. If you pass a branch name that exists on `origin` but not locally, the check passes and you get a new local branch of that name started from `origin/<base>`, which does not contain that remote branch's commits. To work on an existing remote branch, use it as `--base` and give `--branch` a new name. That gives a session a branch *from* someone's work, never their branch itself: the new branch has no upstream (`--no-track`), so its first push creates a new remote branch rather than adding commits to their pull request.

When `sc spawn --cwd` is a worktree in that record, `worktrees.claimFor` claims it for the new session and sets `own_worktree`. Only one active session can hold a worktree; a second spawn into it is refused until the first session is cleaned up. A session with `own_worktree` is launched with Claude Code's background worktree isolation turned off, and its brief tells it to work there directly. Other sessions keep Claude Code's default, and their brief says Claude Code may ask them to enter a worktree.

What the isolation setting actually does, as observed: a background session was refused edits in a normal clone (the sous chef folder itself) until it entered a worktree. In the bare-repo layout, where every folder is a linked worktree, a background session was not refused, whether or not sous chef created the folder. So in the owner's layout turning isolation off changes nothing; the value of `sc worktree` there is the layout itself and one session per worktree. The setting matters for repos that are normal clones.

## The Claude runtime

`src/runtimes/claude-bg.ts` runs sessions as Claude Code background sessions and reaches them through Porch, used as a library (`new Porch()`, `list`, `observe`, `deliver`, `statusSet`, `launchPlan`) and pinned to a tag in `package.json` (decision 0025, Porch is a GitHub dependency pinned to a tag; decision 0026, sous chef reaches Claude sessions through Porch as a library). One Porch is made per process, on first use, with Porch's default records folder (`~/.porch`); sous chef never sets `PORCH_HOME` (`docs/architecture.md`, Known limits). The runtime name stored in records and `chef.json` stays `claude-bg`. What it does:

- `launch` builds its arguments (`launchArgs`: `--bg -n sc-<id> --permission-mode <mode> --settings <hooks> [--model] [--effort] <prompt>`, with the old turn hooks removed, see "Launching") and asks Porch for a launch plan, which merges Porch's six hooks (SessionStart, UserPromptSubmit, Stop, StopFailure, PermissionRequest, SessionEnd) into the one `--settings` and adds `crossSessionInbound: "accept"`, so every new session accepts messages from other sessions whatever its permission mode (Porch decision 0008). The runtime runs the plan itself in the session's working directory, reads the short id from `backgrounded · <short id> ·` (`parseShortId`, which strips terminal colour codes), and polls Porch for up to 20 seconds for the full session id. If the output cannot be parsed, it looks the session up by its unique name in the listing before reporting a failure.
- `listing` is Porch's `list` for the `claude` harness with `all`, keyed by short id and by session id; each row is `{id, sessionId, name, kind, pid, alive, obs}`, where `kind` comes from Porch's `raw.listing` (Porch's `detail` has none). A listing that failed refuses (`SCError`) rather than reading as "nothing is running", and so does a missing `claude` (Porch alone reads that as no sessions); one unreadable Porch record does not.
- `status` maps Porch's observation (`statusOf`):

| Sous chef | From Porch |
| --- | --- |
| `alive` | Porch's own rule (`notRunning`): `starting`, `busy`, `idle`, `waiting-on-prompt` and `unknown` are running; `ended`, `gone` and a session Porch does not know are not |
| `busy` | `busy` and `waiting-on-prompt`: true (held at a prompt counts as busy); `idle`: false; `starting` and `unknown`: null, never idle |
| `pid` | `detail.pid` |
| `prompt` | only for `waiting-on-prompt`: `detail.prompt` (else `a dialog`), plus ` (<detail.promptNeeds>)` when Porch has the exact ask, for example `permission prompt (approve Bash: touch x)` |
| `activity` | `detail.activity`, with Claude Code's kind `agent` shown as `subagent` and start times turned from ISO times into epoch seconds |
| `turns` | only when the session has Porch's hooks (`detail.hasInsidePart`): `detail.lastTurnStart` and `lastTurnEnd` in epoch seconds. Without it, callers use `turns.json` |
| `stopped` | for a stopped session: Porch's status word (`ended` or `gone`) and `endReason`, or `not found`. Used only in the text of the watcher's `gone` event |

`ended` never means "sous chef stopped it": it also covers Claude Code stopping an idle session (`endReason` `idle`) and a session ended by someone else. Only the record's `stopped_by_sc` says sous chef stopped a session (`tests/watch-porch.test.ts` pins this).
- `wake` is Porch's `deliver` with `from: "sous chef"`. Porch puts `[from sous chef] ` before every message, so a wake-up arrives as `[from sous chef] sous chef: new message 1 in your inbox. ...`. A session that is not running gives `WakeError("<id> is not running (<Porch's reason>)")`.
- `reportStatus` (called by `sc report`) sets the session's Porch self status: needs-decision and waiting become `needs-input`, blocked and paused `blocked`, working `working`, done and nothing-new `done`, failed `failed`; note and resolved change nothing. Porch finds the session from `CLAUDE_CODE_SESSION_ID`; for a session without Porch's hooks it makes a record holding only the self status. A failure prints `porch status not updated: <reason>` on stderr and changes nothing else.
- `stop` runs `claude stop <short id>` and checks the session really stopped, trying twice. Porch then shows it as `ended` (reason `other`) when it has Porch's hooks.
- `resume` runs `claude --bg --resume <session id>` with no other flags, never through Porch's launch plan (which adds `--settings`, and with any flag Claude Code starts a copy), then checks that the same session is running, and stops a copy if one started instead. The session keeps the settings, and so Porch's hooks, it was launched with. `ops.resume` refuses a session that is already running, before the runtime is called.
- `attachCommand` returns `claude attach <short id>`.
- Sous chef's own session (`souschef`): `startNamed` launches through Porch's launch plan with no settings of sous chef's own (`namedArgs`), so Porch's hooks are its only launch settings, on top of the folder's `.agents/settings.json` hooks, which get no Porch hooks. `resumeSessionId` runs `claude --bg --resume <session id>` with no other flags and waits for the listing to show it running; `stopShort` is `claude stop`; `attachExec` runs `claude attach <short id>` as a child on the same terminal with Porch's `runLaunchPlan` (Node has no `execve`) and exits with its code. The watcher wakes sous chef through the same `deliver`; a sous chef started by plain `claude` in the folder is reached through the socket path Porch works out from its pid.

Covered by `tests/claude-runtime.test.ts` (Porch's fake adapter for alive, busy, prompt, turn times, delivery and self status; Porch's Claude adapter with canned listings and job files for prompts, activity, listing rows and failed listings; a stub `claude` on `PATH` for launch, resume, stop and sous chef's own session) and `tests/watch-porch.test.ts`. Real sessions were checked with Claude Code 2.1.286 and Porch `v0.1.0` (recorded in the pull request of TRV-1155, the Claude runtime on Porch).

Other runtimes can be added behind the same functions; see `docs/patterns/adding-a-runtime.md`.

## What a session is doing

`sc sessions` and `sc status` show what a running session says it is doing, and what it has running, when the runtime can tell. This asks the session nothing and uses no tokens: for Claude sessions it comes from Claude Code's job file (`~/.claude/jobs/<short id>/state.json`), which Claude Code keeps up to date itself.

The runtime returns it as `activity` in its status (shape in `src/runtimes/types.ts`, `Activity`):

- `detail`: the session's own one-line summary, from the job file's `detail`, cut to 200 characters. It is what the session last said it was doing, so it can lag behind.
- `in_flight`: how many subagents and background commands it started are still running, from `inFlight.tasks`. The watcher uses this to hold back silent stops ("Work in flight" in `docs/domains/watcher.md`, which also says why `queued` and `drainableMonitors` are left out).
- `running`: the job file's `fan` entries with no `doneAt`, each with its kind (`subagent` for Claude Code's `agent`, `shell`, or whatever else Claude Code calls it), label (cut to 120 characters) and start time. Display only.

How it is shown (`summary.sessionsTable`, `summary.activityLine`, `cli.cmdStatus`):

- In `sc sessions`, and the Sessions part of the startup summary, the session's line gets `, N in flight` after idle or busy, and one more line underneath: `doing: <detail> | subagents: <first two labels>, +N more`. Only subagents are named there; shell commands are long and say little. A session with nothing to show gets no extra line, so the list stays one line per session.
- `sc status <id>` prints the detail, the in-flight count, and every running entry with its kind and how long ago it started.
- A stopped session shows none of it, since the file may describe its last run.

The job file is internal to Claude Code and undocumented; these fields were read live from version 2.1.278 and may change without warning. Every field is optional: when one is missing or malformed, that part is left out, and when the file is missing, unreadable, or names another session, there is no activity and both commands print what they did before. Covered by `ActivityListingTests` in `tests/test_sc.py` (through the fake runtime) and, for reading the job file through Porch, `tests/claude-runtime.test.ts` ("reads activity: subagents named subagent, start times in epoch seconds, in-flight count"). The job file is read by Porch now (its `docs/domains/claude-adapter.md`), so what Porch accepts is what sous chef shows.

## Claude Code behaviour this relies on

Verified by running it with Claude Code 2.1.274. Later versions have not been re-checked, so treat this list as evidence from that version. Since the move to Porch, reading the listing and job file and posting to the socket are Porch's job, and Porch's `docs/domains/claude-adapter.md` is where what it relies on is kept current; the items below about launch, resume and stop are still sous chef's own.

- With Claude Code 2.1.286 and Porch `v0.1.0`, a `claude --bg` launch in a folder that is itself a git repository (`git init`) was refused as "Workspace not trusted" although its parent folder was trusted; a plain folder under the same parent was accepted. So trust follows the repository's own root, not a trusted parent.

- `claude --bg -n <name> ... <prompt>` starts a background session and prints `backgrounded · <short id> · <name>`. When run from inside another Claude session's Bash tool, the output includes terminal colour codes.
- `claude agents --json --all` lists sessions with `id` (short), `sessionId`, `name`, `kind` (`background` or `interactive`, used by `souschef` to decide between attaching and telling the owner to switch terminals; interactive rows carry no `id`), and while running `pid` and `status`. A stopped session has no `pid`. `status` is `idle`, `busy` or `waiting`; `waiting` comes with `waitingFor`, and was seen live as `"waitingFor": "permission prompt"` for a session held at a Bash permission prompt (Claude Code 2.1.278). The separate `state` field (`working`, `blocked`, `done`, `failed`, `stopped`) mixes two things: `blocked` is shown both for a session held at a prompt and for one whose last message Claude Code's classifier judged to be a question. Sous chef does not use it; see "How a prompt is detected" in `docs/domains/watcher.md`.
- A running session listens on `/tmp/cc-socks/<pid>.sock`. Posting `{"type":"user","message":{"role":"user","content":"..."}}` starts a turn in an idle session and is picked up by a busy one. This worked from a plain shell, from a script run in another session's Bash tool, and between sessions using the built-in SendMessage tool. Receivers in manual and auto permission mode both accepted messages.
- A message from another session arrives with a note that it came from another Claude session and cannot grant extra permissions. Sessions treat sous chef's messages as a teammate's request, within their own permission settings.
- Environment variables on the `claude --bg` command are **not reliable** per session. They reached the session in one test, but in another a session launched straight after a first one had the first session's variables, because it started in a spare process created earlier. `CLAUDE_CODE_SESSION_ID` was correct in every test.
- Hooks passed with `--settings '<json>'` run in the background session, and still run after the session is stopped and resumed without flags.
- `--session-id <uuid>` is ignored with `--bg`, which is why the id is read back after launch.
- `claude --bg --resume <session id>` with no other flags restarts a stopped session under the same short id, with its conversation, a new `pid` and socket, and SessionStart `source=resume`. With any other flag (for example `-n`), Claude Code prints that the session "keeps its own saved options" and starts a copy under a new id.
- `claude --bg -n <name>` with no prompt starts an idle session; its SessionStart hook ran straight away.
- `/compact` sent as a message is treated as text. `claude -p --resume <session id> "/compact"` compacts a stopped session and fires SessionStart `source=compact`; context added by that hook was visible after resuming.
- A background session in a normal clone was refused Edit and Write until it entered a worktree, unless the settings set `"worktree": {"bgIsolation": "none"}`. In a linked worktree of a bare repo it was not refused.
- Auto permission mode is not available for Haiku; the session falls back to manual mode.
- Launching with `--dangerously-skip-permissions` from inside an auto-mode session was once blocked by that session's classifier. That was given as the reason sessions use auto mode, and it no longer holds as stated: with Claude Code 2.1.278, a session in auto mode launched `claude --bg --permission-mode bypassPermissions` from its Bash tool, and the new session ran a shell command with no prompt and no confirmation dialog. That is one run from one session; sous chef's own classifier may still judge such a launch differently. Which kinds default to `bypass`, and why, is in "Permissions" above.
- `claude --bg -n <name> --permission-mode bypassPermissions <prompt>`, run from a plain shell in this repo's folder (2.1.283), started unattended: no acceptance dialog, and the session ran a shell command that wrote a file and made a network request with no prompt. Its job file recorded `--permission-mode bypassPermissions` in `respawnFlags`. In a folder Claude Code has never been opened in, `claude --bg` refuses to start ("Workspace not trusted") until `claude` is run there once, whatever the mode.
- A session's permission mode survives `claude --bg --resume <session id>` with no flags (2.1.278). Seen twice: a session launched in manual mode was stopped and resumed, and was held at a permission prompt again, once for a new command sent after the resume, once for the command it had been asked about before it was stopped. A third run did not reach a prompt within 30 seconds of resuming, for a reason not found. Claude Code saves the launch flags in its job file (`respawnFlags` in `~/.claude/jobs/<short id>/state.json`), which is internal and read here only as evidence.
- Claude Code's job file (`~/.claude/jobs/<short id>/state.json`, 2.1.278) holds the session's `sessionId`, a one-line `detail` the session keeps current, `inFlight` (`{"tasks": 4, "queued": 0, "kinds": ["local_agent"], "drainableMonitors": 0}` on an orchestrator waiting for four subagents), and `fan`, one entry per subagent (`kind: agent`) or shell command (`kind: shell`) with `label`, `startedAt` in milliseconds and `doneAt` once finished. Read live from the TRV-1114 orchestrator and from this repo's own sessions; `inFlight.tasks` fell as its subagents were marked finished. Used for "What a session is doing" above.

## What a session inherits

A spawned session runs with the owner's own Claude Code setup: skills, MCP servers, global instructions and command line tools. Verified by asking a real session what it could see:

- **Skills**: the owner's user-level skills (for the first owner, `~/.claude/skills` points at `~/.agents/skills`), skills synced from claude.ai, and the project skills of the folder the session works in. Which of these a spawn checks, and where: "Where Claude Code reads skills from" below.
- **MCP servers**: the owner's are available.
- **Instructions**: the owner's global `~/.claude/CLAUDE.md`, plus any `CLAUDE.md` or `AGENTS.md` in the repo the session works in, plus the owner's `my/worker-instructions.md` through its brief ("The brief" above). The `--settings` sous chef passes at launch adds the session's hooks; it does not replace the owner's own settings.
- **Tools**: whatever is on the owner's PATH.
- **Permission mode**: the kind's, unless `sc spawn --permissions` chose another, and `auto` when neither sets one (see "Permissions" above).

So a kind can tell a session to run a skill. It declares it in its `skill` field, which `sc spawn` checks ("Skills" above); for anything the check cannot see, the brief tells the session to report `blocked`.

### Where Claude Code reads skills from

Claude Code has no command that lists skills (checked on 2.1.285: nothing in `claude --help`, and `claude plugin list` lists plugins only). Skills are files, so the Claude runtime's `skillAvailable` (the lookup is in `src/runtimes/claude-skills.ts`, `skillAvailable` and `skillPlaces`, which the Claude runtime exposes) looks for `<name>/SKILL.md`, or any `SKILL.md` whose front matter `name` is `<name>`, in:

- **User skills**: `<config>/skills`, where `<config>` is `CLAUDE_CONFIG_DIR` when set, else `~/.claude`. The folder may be a symlink.
- **Skills synced from claude.ai**: `<config>/skills/synced/<organisation>/`. Claude Code lists them as `anthropic-skills:<name>`, and a session can also run them by their plain name.
- **Project skills**: `.claude/skills` in the session's working directory and each parent up to the repo root (the worktree root in a linked worktree), or up to `/` outside a repo. A linked worktree with no `.claude/skills` at its root also gets the main checkout's (Claude Code 2.1.277 and later).
- **Managed skills**: `.claude/skills` in Claude Code's managed settings folder, `/Library/Application Support/ClaudeCode` on macOS and `/etc/claude-code` on Linux (`MANAGED_DIR` in `src/runtimes/claude-skills.ts`).
- **Plugin skills**: `skills/` in each installed plugin (the `installPath`s in `<config>/plugins/installed_plugins.json`, and `<config>/plugins/cache/<marketplace>/<plugin>/<version>/`) and each synced plugin (`<config>/plugins/synced/<id>/<plugin>/`). Plugins that are only in a marketplace folder are not installed and are not counted.
- **Legacy commands**: `<name>.md` in `<config>/commands`, in `.claude/commands` in the project folders, and in plugins' `commands/`.

`sc kinds` has no working directory, so it checks everything except project skills; a kind whose skill lives only in a project shows as not found there but still launches with that project as `--cwd`. Names with a colon or a slash are not checked. `--add-dir` folders are not checked, because sous chef never passes that flag.

Checked by running Claude Code 2.1.285 against a temporary repo, with `claude -p` asked which skills it had and told to run one: a skill in the working directory's `.claude/skills` and one in the repo root's were both available, and the repo-root one ran; a skill in `.claude/skills` above the repo root was not available. A linked worktree with no `.claude/skills` had the main checkout's skill. A skill synced from claude.ai (`docx`) was listed as `anthropic-skills:docx` and ran as `/docx`. `skillAvailable` gave the same answers for the same folders, and found `build`, `mega-shape`, `orchestrate` and `shape-gui` in the first owner's setup.

Read from Claude Code 2.1.285's code but not checked by running: that `CLAUDE_CONFIG_DIR` moves the user skills folder (skills are one of the folders under the configuration folder, which `CLAUDE_CONFIG_DIR` sets; a session with a fresh configuration folder is not logged in, so it could not be run), and the managed folder paths. Taken from the Claude Code docs only: plugin skills run by their plain name when no other skill has it, and front matter `name` sets a skill's command name.

Also verified end to end: two sessions launched back to back into worktrees from `sc worktree` each edited, committed on their own branch and reported to the right log; one was then stopped, resumed with `sc resume` under the same id, received a message, reported, and acknowledged the message.

Not yet verified: attaching with `claude attach` while messages arrive, automatic (not manual) compaction, whether background sessions survive a reboot or a Claude Code update, and a real `/build` or `/shape` session.

`sc spawn` and `sc kinds` have a hidden `--runtime` flag that picks a runtime other than `claude-bg`; only the tests use it, with the `fake` runtime.

## Stopping, resuming and cleaning up

- `sc stop <id>` stops the session, marks `stopped_by_sc` (so the watcher does not report it as gone), and appends `stopped`. The conversation is kept.
- `sc resume <id>` continues the same session and appends `resumed`. The watcher resumes a session through the same code when it stopped by itself while waiting on someone else, and appends `auto-resumed` instead (`docs/domains/watcher.md`, check 1). It refuses a session that is still running, and says to message or open it instead. A resumed session's SessionStart hook tells it about unread messages.
- `sc cleanup <id>` frees any worktree the session held (the entry stays in `my/state/worktrees.json` with no session, unless its folder is gone) but does not remove the worktree or branch, and does not remove the session from `claude agents` (`claude rm` does). It refuses when the working directory has uncommitted changes or commits no remote has (`ops.unlandedWork`), because those may be the owner's work. With `--force` (only with the owner's agreement) it skips that check. It then stops the session if running, moves its folder to `my/state/archive/`, and forgets sous chef's read position for it.
