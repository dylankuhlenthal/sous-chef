"""`souschef`: open sous chef from any terminal.

Sous chef runs as a Claude Code background session so it keeps running when no
terminal is attached. `souschef` works out what to do from the session
registered in state/chef.json and the runtime's live listing (`claude agents`):

  registered session running in the background  -> attach to it
  registered session running in a terminal       -> say where; attaching is not possible
  registered session exists but is stopped       -> resume it in the background, then attach
  nothing registered, or it cannot be resumed    -> start a new one, then attach

A new sous chef starts with PERMISSIONS (bypass: nothing ever asks), the owner's
choice (docs/decisions/0015). A resumed one keeps the mode it was started with,
so switching an older sous chef over takes `souschef --new`.

`souschef --new` stops the registered background session (its conversation is
kept) and starts a fresh one. `souschef --print` does everything except attach
and prints the attach command instead.

The runtime is Claude Code (`claude-bg`). Tests name another with SC_CHEF_RUNTIME
(the fake runtime), which then provides the same functions: listing, start_named,
resume_session_id, stop_short, attach_command and attach_exec.
"""
import argparse
import os
import sys

from . import chef, runtimes, util

SESSION_NAME = "sous-chef"
# sc's permission value for sous chef's own session (runtimes.PERMISSIONS).
PERMISSIONS = "bypass"

def first_prompt() -> str:
    """A first message, so the new session has a saved conversation it can later be
    resumed from (a session that never had a turn cannot be resumed), and so sous
    chef reads its startup summary before the owner arrives."""
    return ("Started by the souschef command. Check your startup summary: if it reports unread events "
            f"or open questions, run `sc events` and handle them. Then wait for {util.owner_name()}.")


def decide(info, rows) -> tuple:
    """Pure decision: returns (action, detail) from the registered chef and the listing."""
    if not info or not info.get("session_id"):
        return "start", None
    row = rows.get(info["session_id"])
    if row and row.get("pid"):
        if row.get("kind") == "background":
            return "attach", row.get("id") or info["session_id"][:8]
        return "elsewhere", row
    return "resume", info["session_id"]


def _runtime():
    """The runtime sous chef's own session runs on: SC_CHEF_RUNTIME (tests), else Claude Code."""
    return runtimes.get(os.environ.get("SC_CHEF_RUNTIME") or runtimes.DEFAULT)


def _env() -> dict:
    return {k: v for k, v in os.environ.items() if k != "SC_TEST_HOME"}


def _start() -> str:
    return _runtime().start_named(SESSION_NAME, first_prompt(), str(util.CODE_ROOT), _env(), PERMISSIONS)


def _resume(session_id: str):
    """Resume the registered session. Returns its short id, or None if it did not come back."""
    return _runtime().resume_session_id(session_id, str(util.CODE_ROOT), _env())


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="souschef", description="Attach to sous chef, resuming or starting it if needed.")
    p.add_argument("--new", action="store_true", help="stop the current background sous chef and start a fresh one")
    p.add_argument("--print", dest="print_only", action="store_true",
                   help="start or resume if needed, then print the attach command instead of attaching")
    args = p.parse_args(argv)
    try:
        rt = _runtime()
        info = chef.current()
        rows = rt.listing()
        action, detail = decide(info, rows)

        if args.new and action in ("attach", "resume"):
            if action == "attach":
                rt.stop_short(detail)
                print(f"stopped the previous sous chef ({detail}); its conversation is kept")
            action = "start"
        elif args.new and action == "elsewhere":
            raise util.SCError("sous chef is open in a terminal (pid "
                               f"{detail.get('pid')}); close it there before starting a new one")

        if action == "elsewhere":
            print(f"Sous chef is already open in another terminal (pid {detail.get('pid')}, "
                  f"session {detail.get('name') or detail.get('id')}). Switch to that terminal, or exit it "
                  f"there and run souschef again to run it in the background.")
            return 1
        if action == "resume":
            short = _resume(detail)
            if short:
                print(f"resumed sous chef ({short})")
                action, detail = "attach", short
            else:
                print("could not resume the previous sous chef session; starting a new one")
                action = "start"
        if action == "start":
            detail = _start()
            print(f"started sous chef ({detail}) with permissions: {PERMISSIONS}")

        if args.print_only:
            print(rt.attach_command({"handle": {"short_id": detail}}))
            return 0
        rt.attach_exec(detail, str(util.CODE_ROOT), _env())
    except util.SCError as e:
        print(f"souschef: {e}", file=sys.stderr)
        return 1
