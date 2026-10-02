# 0028: Switching the live sous chef to TypeScript

**Date:** 2026-10-01
**Status:** Accepted

## Context
The TypeScript core (decision 0021, the rewrite built in five serial steps, and the records after it) replaces the Python core in place, at the same path, `~/.sous-chef`. The live install there runs the Python core, with sous chef's own background session and the Python watcher running from it. The change cannot happen piece by piece: sous chef's hooks, the watcher and the saved hook commands of every session call `~/.sous-chef/bin/sc`. The Python watcher cannot switch itself: when its code changes it loads the new code with Python first, which fails for a Node `bin/sc`, so it keeps running the old code from memory. And the two versions lock differently (Python's `flock` on `state/watch.lock`, TypeScript's `proper-lockfile` folder beside it; decision 0024, locks through proper-lockfile), so neither sees the other's watcher: if both ever ran, every wake-up, cron firing and data sync would happen twice. The goal was that the owner's sous chef keeps running through the switch with the same data folder, sessions, cron jobs, Slack and conversation, and that going back is one documented command.

## Decision
**A one-off script, rehearsed, run by the owner.** `switch_over.py` checks every precondition first (no session running, stopped ones listed; the core a clean checkout of `main` at the Python core; `origin/main` holding the TypeScript core; Node 22 or later and npm), then stages that exact `origin/main` commit in a temporary clone, runs `npm ci`, the build and the full behaviour suite against it, and stops if any of it fails. Only then does it tag the running Python commit `last-python` and push the tag, stop sous chef (`claude stop`, which keeps its conversation) and then the watcher (SIGTERM, wait; never SIGKILL), move the core to the commit it tested with `git merge --ff-only` (not `git pull`, which could pick up a later commit than the one tested), run the documented update step, and run `souschef --print`, which resumes the same conversation and starts the TypeScript watcher through the startup hook. It checks the result before handing over. It never touches the data folder or the `my` link. It was rehearsed end to end on a scratch install (a stub `claude`, local bare repos, the real Python and TypeScript watchers on scratch data), with every refusal as a negative case; the record is in the pull request for the switch-over. Set aside: merging and pulling by hand (nothing checks the preconditions, and stopping the watcher is easy to miss).

**Python and TypeScript never run at once.** The script stops sous chef before the watcher, so nothing is left that could start a watcher again (only sous chef's startup hook and `sc watch --ensure` start one), and it checks no watcher process for the core remains and the Python lock is free before moving the code.

**Rollback stops first, then checks out `last-python`.** `--rollback` stops sous chef and the TypeScript watcher, checks out `last-python` and runs `souschef`. A checkout alone is not enough: `dist/` is untracked, so the TypeScript watcher sees no change and keeps running, and the Python startup hook cannot see its lock, so it would start a second watcher. Going forward again is `git checkout main` and the script again; it recognises that `last-python` already names an older Python commit and makes no new tag. The tag and the rollback exist until the Python code leaves the core.

**The script lives in the core's history, not its tree.** It was committed in `switch-over/` on the switch-over's branch and deleted by that branch's last commit, so `main`'s tree never holds a one-off, while `git show <commit>:switch-over/switch_over.py` still reaches it. The earlier data-folder switch-over was likewise a one-off kept only in history, in the data repo's (decision 0020, the core and the owner's data are separate repos). Set aside: a branch that is never merged (lost if the branch is deleted) and a `.gitignore` entry (a trace of a one-off in the core forever).

## Consequences
What the rehearsal could not check, the owner checks after the live switch with the checklist the script prints: real Claude Code stopping and resuming sous chef, Porch reaching a sous chef started without Porch's hooks, Slack, a cron job firing, the data sync. After a rollback, sessions the TypeScript sc launched cannot run their hooks (they run `bin/sc` with Node, which cannot run the Python one) and keep their turn times in Porch rather than `turns.json`, so they need relaunching. How to run it: `docs/operations/running.md` ("Switching from the Python sous chef to TypeScript", "Going back to the Python version").

## Switching over and going back

This runbook lived in `docs/operations/running.md` until the core went public, and moved here because only the first owner's install ever needed it (decision 0030, the one-off scrub before the core went public, records why this record was added to after merge).

### Switching an install over

The core moved from Python to TypeScript, and `~/.sous-chef` was switched over with a one-off script (this decision). The Python code and tests have since left the core. To switch another install that still runs the Python core, use the same script: it is in the core's history, in the commit before the one that deleted it. From a plain terminal, never from inside a Claude session:

```sh
git -C ~/.sous-chef fetch origin
c=$(git -C ~/.sous-chef log -1 --full-history --diff-filter=D --format=%H origin/main -- switch-over/switch_over.py)
git -C ~/.sous-chef show "$c^:switch-over/switch_over.py" > /tmp/switch_over.py
python3 /tmp/switch_over.py --core ~/.sous-chef --check       # every check; changes nothing live
python3 /tmp/switch_over.py --core ~/.sous-chef               # the switch; add --accept-stopped to keep stopped sessions
```

"Decision" above says what it checks and does. One check no longer works as written: the script runs the Python test suite in a staged copy of `origin/main`, and `main` has no Python tests now, so that step tests nothing. Python 3.11 counts no tests as a pass; Python 3.12 and later fail the step, and the script refuses, so on those run it with a Python 3.11 (`python3.11 /tmp/switch_over.py ...`). Either way, run `npm ci && npm test` in a fresh clone of `main` yourself first, since the script's own check no longer does. After the switch, remove the Python caches git leaves behind (`rm -rf ~/.sous-chef/lib ~/.sous-chef/tests/__pycache__`): the core no longer ignores them, so they show as untracked files and the suite's "every tracked file is core" check fails in that folder.

### Going back to the Python version

The last Python commit is tagged `last-python`, and the tag keeps the whole Python tree, so going back still works now that the Python code has left `main`. It needs Python 3 again, since that is what the Python sous chef runs on. To go back:

```sh
python3 /tmp/switch_over.py --core ~/.sous-chef --rollback
```

It stops sous chef and the TypeScript watcher, checks out `last-python` (a detached HEAD; `dist/` and `node_modules/` stay, untracked and unused) and runs `souschef --print`, which resumes the same conversation on the Python code; its startup hook starts a Python watcher. By hand it is the same steps in the same order: `claude stop <short id>` (`sc chef` shows it), `kill $(cat ~/.sous-chef/my/state/watch.pid)` and wait until that process has gone, `git -C ~/.sous-chef checkout last-python`, `souschef`. The stops are not optional: a checkout does not change `dist/`, so the TypeScript watcher would keep running, and the Python startup hook cannot see its lock (Python and TypeScript lock differently), so it would start a second watcher beside it.

After going back, sessions the TypeScript sc launched cannot run their hooks: their saved hook commands run `bin/sc` with Node, which cannot run the Python one, so each hook fails with a hook error (including the guard on `state/`); `sc report` from them still works. They also keep their turn times in Porch, not in `turns.json`, so the Python watcher's silent-stop check (`docs/domains/watcher.md`) never fires for them. Stop them before going back if you can (the rollback lists the ones still running), and relaunch the ones you still need. Sessions launched before the switch are not affected.

To go forward again: `git -C ~/.sous-chef checkout main`, then the switch-over script again (without `--rollback`). It sees that `last-python` already names the Python commit and makes no new tag.
