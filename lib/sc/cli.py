"""`sc`: the sous chef command line. Run `sc --help` or `sc <command> --help`."""
import argparse
import os
import sys
import time

from . import (chef, context, cron, events, hooks, inbox, kinds, ops, records, runtimes, setup, slack, summary, util,
               watch, worktrees)


def _read_task(args) -> str:
    if args.task_file:
        return open(args.task_file).read()
    if not sys.stdin.isatty():
        return sys.stdin.read()
    return ""


# --- sous chef commands ----------------------------------------------------

def cmd_spawn(args):
    rec = ops.spawn(args.kind, args.title, args.cwd, _read_task(args), thread=args.thread, model=args.model,
                    effort=args.effort, runtime=args.runtime, permissions=args.permissions)
    kind = kinds.load(rec["kind"])
    rt = runtimes.get(rec["runtime"])
    print(f"launched {rec['id']} ({rec['kind']}: {rec['title']})")
    print(f"  attach: {rt.attach_command(rec)}")
    print(f"  starts waiting on: {events.show_waiting(kind['starts_waiting_on'])}")
    print(f"  permissions: {rec['permissions']}")
    if not (rec.get("handle") or {}).get("session_id"):
        print("  warning: the Claude session id was not found yet; `sc status` will retry", file=sys.stderr)
    if not rec.get("thread"):
        print("  warning: no --thread, so standing instructions about this session (a '## Slack me' section in "
              "its thread file) have nowhere to live", file=sys.stderr)


def cmd_send(args):
    rec = records.resolve(args.id)
    text = sys.stdin.read() if args.text == ["-"] else " ".join(args.text)
    msg, problem = ops.send(rec, text, resolves=args.resolves)
    if not problem:
        print(f"message {msg['seq']} saved to {rec['id']}'s inbox and the session was woken")
    else:
        print(f"message {msg['seq']} saved to {rec['id']}'s inbox, but the session was not woken: {problem}. "
              f"It will read the message when it next runs `sc inbox` (`sc resume {rec['id']}` if it is stopped).")


def cmd_events(args):
    if args.action == "ack":
        if not args.token:
            raise util.SCError("usage: sc events ack <token>")
        moved = events.ack(args.token)
        print(f"acknowledged: {', '.join(moved) if moved else 'nothing new'}")
        return
    util.require_owner()
    token_parts, printed = [], False
    for rec in records.all_records() + list(events.CHEF_LOGS):
        sid = rec if isinstance(rec, str) else rec["id"]
        rec = None if isinstance(rec, str) else rec
        log = events.read_all(sid)
        new = events.unread(sid, log)
        if not new:
            continue
        if not printed:
            print("UNREAD EVENTS")
            printed = True
        if rec:
            rt = runtimes.get(rec["runtime"])
            job = f" | cron job {rec['cron']['job']}" if rec.get("cron") else ""
            waiting = events.show_waiting(events.waiting_on(log))
            print(f"\n[{sid}] {rec['kind']}: {rec['title']} | waiting on: {waiting} | "
                  f"attach: {rt.attach_command(rec)}{job}")
        elif sid == events.CRON_LOG:
            print(f"\n[{sid}] scheduled jobs for sous chef itself (`sc cron list`)")
        elif sid == events.SLACK_LOG:
            print(f"\n[{sid}] messages from Slack, collected from the relay (`sc slack status`)")
            for e in new:
                print("\n".join(slack.describe(e)))
            token_parts.append(f"{sid}:{new[-1]['seq']}")
            continue
        elif sid == events.SYNC_LOG:
            print(f"\n[{sid}] keeping your data folder committed and pushed (docs/domains/watcher.md)")
        else:
            print(f"\n[{sid}] how full your own context is (`sc context`)")
        for e in new:
            key = f" key={e['key']}" if e.get("key") else ""
            print(f"  #{e['seq']} {e['state']}{key} ({e['author']}, {util.age(e['ts'])} ago): {e['text']}")
        linked = slack.linked_memory(rec) if rec else [slack.job_memory(j) for j in
                                                       dict.fromkeys(e.get("job") for e in new if e.get("job"))]
        for line in slack.instruction_lines([m for m in linked if m]):
            print(line)
        token_parts.append(f"{sid}:{new[-1]['seq']}")
    if not printed:
        print("No unread events.")
    open_lines = []
    for rec in records.all_records():
        for q in events.open_questions(events.read_all(rec["id"])):
            open_lines.append(f"  [{rec['id']}] key={q['key']} (#{q['seq']}, {util.age(q['ts'])} ago): {q['text']}\n"
                              f"    answer: sc send {rec['id']} --resolves {q['key']} \"...\"")
    if open_lines:
        print("\nOPEN QUESTIONS (listed until answered with --resolves, or resolved by the session)")
        print("\n".join(open_lines))
        for line in slack.instruction_lines([slack.GENERAL_INSTRUCTIONS]):
            print(line)
    if token_parts:
        print(f"\nAfter handling these, run: sc events ack {','.join(token_parts)}")


def cmd_context(args):
    if args.action == "check":
        path = args.transcript
        if not path:
            held = (chef.current() or {}).get("session_id")
            if not held:
                raise util.SCError("no sous chef session is registered; pass --transcript PATH")
            path = context.find_transcript(held)
        try:
            r = context.read_usage(path)
        except context.ReadError as e:
            raise util.SCError(f"could not read usage: {e}") from e
        print(f"transcript: {path}")
        if r.get("compacted"):
            print(f"compacted at {r['timestamp']} (before: {r['pre_tokens']} tokens); no turn since")
            return
        print(f"context: {r['tokens']:,} tokens ({' + '.join(f'{k} {v:,}' for k, v in r['parts'].items())})")
        print(f"model: {r['model']}; turn at {r['timestamp']}")
        size = (context.config().get("windows") or {}).get(r["model"])
        print(f"window: {size:,} tokens, so {100.0 * r['tokens'] / size:.1f}% full" if size
              else f"window: none set for {r['model']} (`sc context set --window {r['model']}=TOKENS`)")
        print("(read only: nothing recorded, no events written)")
        return
    if args.action in ("set", "off"):
        windows = dict(context.parse_window(w) for w in args.window or [])
        if args.action == "set" and args.warn_at is None and args.rearm_below is None and not windows:
            raise util.SCError("usage: sc context set [--warn-at N] [--rearm-below N] [--window MODEL=TOKENS]")
        context.set_config(warn_at=args.warn_at, rearm=args.rearm_below, windows=windows,
                           off=args.action == "off")
        print(f"saved {context.config_path().name} (tracked in git; commit it to keep it)")
    print("\n".join(context.status_lines()))


def cmd_cron(args):
    if args.action == "add":
        if not args.name:
            raise util.SCError("usage: sc cron add <name> (--at HH:MM[,HH:MM] | --every 6h) "
                               "--target chef|worker ...; task on stdin")
        job = cron.add({"name": args.name, "at": args.at, "every": args.every, "target": args.target,
                        "kind": args.kind, "cwd": args.cwd, "title": args.title,
                        "model": args.model, "effort": args.effort, "thread": args.thread,
                        "memory": args.memory, "runtime": args.runtime, "task": _read_task(args)})
        print(f"added cron job {job['name']}: {cron.schedule_text(job)}, target {job['target']}")
        print(f"  definition: cron/{job['name']}.md (tracked in git; commit it to keep it)")
        print("  it first fires at its next scheduled time, and only while sous chef is running")
        return
    if args.action in ("remove", "run"):
        if not args.name:
            raise util.SCError(f"usage: sc cron {args.action} <name>")
        if args.action == "remove":
            cron.remove(args.name)
            print(f"removed cron job {args.name} (cron/{args.name}.md deleted)")
        else:
            print(f"cron job {args.name}: {cron.run_now(args.name)}")
        return
    jobs, broken = cron.all_jobs()
    if not jobs and not broken:
        print("No cron jobs. Add one with `sc cron add`.")
        return
    runs, now = cron.runs(), util.now()
    blocker = _cron_blocker() if jobs else None
    if blocker:
        print(f"{blocker}\n")
    for job in jobs:
        run = runs.get(job["name"], {})
        where = f"worker ({job['kind']} in {job['cwd']})" if job["target"] == "worker" else "sous chef"
        print(f"{job['name']}: {cron.schedule_text(job)} | {where}")
        fired = f"{util.age(run['last_fired'])} ago" if run.get("last_fired") else "never"
        print(f"  last fired: {fired}; last result: {run.get('last_result', '-')}")
        if cron.is_due(job, run, now):
            # A due time in the past never arrives: say why it has not fired instead.
            slot = cron.latest_slot(job, run, now)
            why = ("see the line at the top" if blocker else
                   "the watcher fires it on its next cycle; if this persists, check state/watch.log")
            print(f"  OVERDUE: due since {time.strftime('%a %d %b %H:%M %Z', time.localtime(slot))} "
                  f"({util.age(slot)} ago) and not fired yet: {why}")
            continue
        nxt = cron.next_slot(job, run, now)
        print(f"  next due: {time.strftime('%a %d %b %H:%M %Z', time.localtime(nxt))} "
              f"(in {util.age(now - (nxt - now))})")
    for name, problem in broken.items():
        print(f"{name}: BROKEN, never fires until fixed: {problem}")


def _cron_blocker():
    """Why jobs cannot fire right now, or may not, as one line for `sc cron list`; None if they can."""
    h = watch.health()
    if not h["running"]:
        return f"WARNING: {h['problem']}."
    if not h["current"]:
        return f"WARNING: {h['problem']}."
    if not chef.live_incumbent():
        return ("WARNING: sous chef is not running, so nothing fires: jobs fire only while it runs. Each due "
                "job fires once when it is back (`souschef`).")
    return None


def cmd_slack(args):
    rest = args.rest or []
    if args.action == "setup":
        if not (args.url and args.key_file and args.user):
            raise util.SCError("usage: sc slack setup --url <relay url> --key-file <path> --user <your Slack user id>")
        done = slack.setup(args.url, args.key_file, args.user)
        print(f"wrote {done['path']} (mode 600, gitignored); {done['checked']}")
        return
    if args.action == "send":
        text = sys.stdin.read() if rest == ["-"] else " ".join(rest)
        sent = slack.send(text, session=args.session)
        where = f"{util.owner_name()}'s DM with the bot"
        if args.session:
            where = (f"a new update thread for {args.session}" if sent.get("thread") == "new"
                     else f"the update thread for {args.session}")
        print(f"sent to {where} (conversation {sent['conversation_id']}, message {sent['message_id']})")
        return
    if args.action == "ask":
        if len(rest) < 2:
            raise util.SCError("usage: sc slack ask <session> <key> [\"<the question, reworded>\"]")
        sent = slack.ask(rest[0], rest[1], " ".join(rest[2:]) or None)
        owner = util.owner_name()
        print(f"asked in a new thread in {owner}'s DM (message {sent['message_id']}); {owner}'s reply there comes back "
              f"under [slack] in `sc events`, labelled with the question")
        return
    if args.action == "reply":
        if len(rest) < 2:
            raise util.SCError("usage: sc slack reply <n> \"<text>\" (n: the #n under [slack] in `sc events`)")
        text = sys.stdin.read() if rest[1:] == ["-"] else " ".join(rest[1:])
        sent = slack.reply(rest[0], text)
        print(f"replied in the thread (conversation {sent['conversation_id']}, thread {sent['parent_id']})")
        return
    if args.action == "read":
        if len(rest) != 1:
            raise util.SCError("usage: sc slack read <n> [--before N] (n: the #n under [slack] in `sc events`)")
        print("\n".join(slack.read(rest[0], before=args.before)))
        return
    print("\n".join(slack.status_lines(live=True)))


def cmd_worktree(args):
    wt = worktrees.create(args.repo, args.branch, args.dir, base=args.base)
    print(f"created {wt['path']} on branch {wt['branch']} from origin/{wt['base']} (not pushed, no upstream)")
    if wt["env_linked"]:
        print(f"  linked env files from .local/: {', '.join(wt['env_linked'])}")
    elif wt["has_local"]:
        print("  .local/ has no .env files, so none were linked")
    else:
        print("  the repo has no .local/ folder, so no env files were linked; the session may need them")
    print("  dependencies are not installed; the session installs them if it needs to")
    print(f"  next: sc spawn --cwd {wt['path']} ...")


def cmd_owner(args):
    if args.action == "set":
        if not args.name or args.branch_prefix is None:
            raise util.SCError("usage: sc owner set --name <name> --branch-prefix <prefix>")
        ops.set_owner(args.name, args.branch_prefix)
        print(f"saved {util.owner_path().name} (tracked in git; commit it to keep it)")
    o = util.owner()
    if not o:
        print(util.NO_OWNER)
        return
    print(f"owner: {o['name']}")
    print(f"branch prefix: {o['branch_prefix'] or '(none)'}")
    print(f"sessions waiting on the owner show as: waiting on: {o['lower']}")


def cmd_sessions(_args):
    print(summary.sessions_table())


def cmd_status(args):
    rec = records.resolve(args.id)
    rt = runtimes.get(rec["runtime"])
    log = events.read_all(rec["id"])
    st = rt.status(rec)
    turns = records.turns(rec["id"])
    print(f"{rec['id']} ({rec['kind']}: {rec['title']})")
    print(f"  running: {'yes' if st['alive'] else 'no'}{' (busy)' if st['busy'] and not st.get('prompt') else ''}"
          f"{' (stopped by sous chef)' if rec.get('stopped_by_sc') else ''}")
    if st.get("prompt"):
        print(f"  HELD AT A PROMPT: {st['prompt']} (answer it in the session: {rt.attach_command(rec)})")
    activity = st.get("activity") if st["alive"] else None
    if activity:
        if activity.get("detail"):
            print(f"  doing: {activity['detail']}")
        if activity.get("in_flight") is not None:
            print(f"  subagents and background commands in flight: {activity['in_flight']}")
        for r in activity.get("running") or []:
            since = f", started {util.age(r['since'])} ago" if r.get("since") else ""
            print(f"    {r['kind']}: {r['label']}{since}")
    print(f"  permissions: {rec.get('permissions') or runtimes.DEFAULT_PERMISSIONS}")
    print(f"  waiting on: {events.show_waiting(events.waiting_on(log))}")
    print(f"  attach: {rt.attach_command(rec)}")
    print(f"  cwd: {rec['cwd']}{' (worktree created for this session)' if rec.get('own_worktree') else ''}")
    print(f"  brief: {records.session_dir(rec['id']) / 'brief.md'}")
    report = records.session_dir(rec["id"]) / "report.md"
    if report.is_file():
        print(f"  report: {report}")
    if rec.get("thread"):
        print(f"  thread: memory/threads/{rec['thread']}.md")
    for field in ("last_prompt_at", "last_stop_at"):
        if turns.get(field):
            print(f"  {field.replace('_', ' ')}: {util.age(turns[field])} ago")
    print(f"  unhandled inbox messages: {len(inbox.unhandled(rec['id']))}")
    print("  recent events:")
    for e in log[-args.n:]:
        key = f" key={e['key']}" if e.get("key") else ""
        print(f"    #{e['seq']} {e['state']}{key} ({e['author']}, {util.age(e['ts'])} ago): {e['text']}")
    for q in events.open_questions(log):
        print(f"  OPEN QUESTION key={q['key']}: {q['text']}")


def cmd_attach(args):
    rec = records.resolve(args.id)
    print(runtimes.get(rec["runtime"]).attach_command(rec))


def cmd_stop(args):
    rec = records.resolve(args.id)
    ops.stop(rec)
    print(f"stopped {rec['id']}; its conversation is kept (resume with `sc resume {rec['id']}`)")


def cmd_resume(args):
    rec = records.resolve(args.id)
    ops.resume(rec)
    print(f"resumed {rec['id']}; attach: {runtimes.get(rec['runtime']).attach_command(rec)}")


def cmd_mark(args):
    rec = records.resolve(args.id)
    ops.mark(rec, args.waiting_on, " ".join(args.text))
    print(f"{rec['id']} is now waiting on: {events.show_waiting(events.waiting_on(events.read_all(rec['id'])))}")


def cmd_cleanup(args):
    rec = records.resolve(args.id)
    ops.cleanup(rec, force=args.force)
    print(f"cleaned up {rec['id']}: stopped if running, record moved to state/archive/{rec['id']}")


def cmd_kinds(args):
    rt = runtimes.get(args.runtime or runtimes.DEFAULT)
    for name in kinds.names():
        k = kinds.load(name)
        perms = f"  (permissions: {k['permissions']})" if k["permissions"] else ""
        skill = ""
        if k["skill"]:
            # No working directory here, so only the skills every session gets are checked.
            missing = rt.skill_available(k["skill"], None) is False
            skill = f"  skill: {k['skill']}" + (" (not found in your skills)" if missing else "")
        source = ("  [user, replaces core]" if k["replaces_core"] else "  [user]") if k["source"] == "user" else ""
        print(f"{name:14} starts waiting on {events.show_waiting(k['starts_waiting_on']):6}  "
              f"{k['description']}{perms}{skill}{source}")
        if k["skill"] and not kinds.names_skill(k["body"], k["skill"]):
            print(f"  warning: {k['path']} declares the skill '{k['skill']}' but its instructions never name "
                  f"/{k['skill']}; make them match")


def cmd_summary(_args):
    print(summary.build())


def cmd_watch(args):
    if args.once:
        for a in watch.cycle()["actions"]:
            print(a)
        return
    if args.ensure:
        result = watch.ensure()
        if result["note"]:
            print(f"sc watch: {result['note']}", file=sys.stderr if not result["running"] else sys.stdout)
        print("watcher running" if result["running"] else "watcher failed to start; see state/watch.log")
        return
    sys.exit(watch.run_forever())


def cmd_chef(args):
    if getattr(args, "take", False):
        claude_sid = os.environ.get("CLAUDE_CODE_SESSION_ID")
        if not claude_sid:
            raise util.SCError("CLAUDE_CODE_SESSION_ID is not set, so there is no session to register. "
                               "Run `sc chef --take` from inside the Claude session that should be sous chef.")
        prev = chef.register(claude_sid, os.environ.get("SC_CHEF_RUNTIME", "claude-bg"))
        was = f" (taken from {prev['session_id'][:8]})" if prev and prev.get("session_id") != claude_sid else ""
        print(f"this session ({claude_sid[:8]}) is now sous chef{was}")
        print("if the previous one is still running, stop it: two sous chefs share one set of files")
        return
    info = chef.current()
    if not info:
        print("no sous chef session registered yet")
        return
    print(f"sous chef session: {info['session_id']} (runtime {info['runtime']}, registered "
          f"{util.age(info['registered_at'])} ago)")
    rt = runtimes.get(info["runtime"])
    try:
        row = rt.listing().get(info["session_id"])
    except util.SCError as e:
        print(f"  could not check whether it is running: {e}")
        return
    if row and row.get("pid"):
        print(f"  running (pid {row['pid']}), so wake-ups can reach it")
    else:
        print("  NOT running, so wake-ups cannot reach it; events wait on disk until it starts "
              "(`souschef`), and `sc events` still lists them")


# --- session commands ------------------------------------------------------

def cmd_report(args):
    event = ops.report(args.state, " ".join(args.text), key=args.key)
    key = f" (key {event['key']})" if event.get("key") else ""
    print(f"reported {event['state']}{key} as event #{event['seq']}")
    if event.get("woke_sous_chef") is False:
        print("sous chef could not be woken just now; it will see this when it next looks.")


def cmd_inbox(args):
    rec = ops.current_session_record()
    if args.action == "ack":
        if args.seq is None:
            raise util.SCError("usage: sc inbox ack <n>")
        inbox.ack(rec["id"], args.seq)
        print(f"message {args.seq} marked handled")
        return
    msgs = inbox.unhandled(rec["id"])
    if not msgs:
        print("Inbox is empty.")
        return
    for m in msgs:
        extra = f" (answers your question {m['resolves']})" if m.get("resolves") else ""
        print(f"--- message {m['seq']} from {m['from']}, {util.age(m['ts'])} ago{extra}\n{m['text']}\n")
    print("After acting on a message, run: sc inbox ack <n>")


class _IntermixedParser(argparse.ArgumentParser):
    """A subcommand parser that accepts positionals before, after or between options.

    Plain argparse cannot: once it has matched an optional positional such as the
    text of `sc report resolved --key q2 "text"` (as empty, before `--key`), text
    after the option is an "unrecognized argument". So every subcommand parses
    intermixed. The top-level parser cannot (argparse refuses subparsers there),
    and does not need to.
    """
    _intermixing = False

    def parse_known_args(self, args=None, namespace=None):
        if self._intermixing:  # parse_known_intermixed_args calls back into this method
            return super().parse_known_args(args, namespace)
        self._intermixing = True
        try:
            return self.parse_known_intermixed_args(args, namespace)
        finally:
            self._intermixing = False


def build_parser():
    p = argparse.ArgumentParser(prog="sc", description="Sous chef: memory and session manager.")
    sub = p.add_subparsers(dest="command", required=True, parser_class=_IntermixedParser)

    s = sub.add_parser("spawn", help="launch a session; task text on stdin or --task-file")
    s.add_argument("--kind", required=True, help="see `sc kinds`")
    s.add_argument("--title", required=True, help="short human title")
    s.add_argument("--cwd", required=True, help="directory the session starts in")
    s.add_argument("--task-file", help="file holding the task text (otherwise stdin)")
    s.add_argument("--thread", help="memory thread slug this work belongs to")
    s.add_argument("--model", help="model alias, e.g. opus or sonnet (default: Claude Code's default)")
    s.add_argument("--effort", help="low, medium, high, xhigh or max")
    s.add_argument("--permissions", choices=list(runtimes.PERMISSIONS), default=None,
                   help="what the session may do without asking: "
                        + "; ".join(f"{k}: {v}" for k, v in runtimes.PERMISSIONS.items())
                        + f" (default: the kind's permissions, shown by `sc kinds`, else {runtimes.DEFAULT_PERMISSIONS})")
    s.add_argument("--runtime", help=argparse.SUPPRESS)
    s.set_defaults(fn=cmd_spawn)

    s = sub.add_parser("send", help="message a session (text, or - for stdin)")
    s.add_argument("id")
    s.add_argument("text", nargs="+")
    s.add_argument("--resolves", metavar="KEY", help="this message answers the open question with KEY")
    s.set_defaults(fn=cmd_send)

    s = sub.add_parser("events", help="show unread events and open questions; `sc events ack <token>` after")
    s.add_argument("action", nargs="?", choices=["ack"])
    s.add_argument("token", nargs="?")
    s.set_defaults(fn=cmd_events)

    s = sub.add_parser("cron", help="scheduled jobs the watcher fires while sous chef runs: list (default), "
                                    "add, remove, run (fire now)")
    s.add_argument("action", nargs="?", choices=["list", "add", "remove", "run"], default="list")
    s.add_argument("name", nargs="?", help="job name, kebab-case, e.g. email-check")
    g = s.add_mutually_exclusive_group()
    g.add_argument("--at", help="times of day, local, 24-hour: 09:00,16:00")
    g.add_argument("--every", help="interval: 30m, 6h, 1d")
    s.add_argument("--target", choices=cron.TARGETS,
                   help="chef: sous chef does it; worker: a session is launched for it (or, if the previous "
                        "run's session is still going, sent the task in its inbox)")
    s.add_argument("--kind", help="worker only: as for sc spawn")
    s.add_argument("--cwd", help="worker only: as for sc spawn")
    s.add_argument("--title", help="worker only: session title (default: the job name)")
    s.add_argument("--model", help="worker only: as for sc spawn")
    s.add_argument("--effort", help="worker only: as for sc spawn")
    s.add_argument("--thread", help="worker only: as for sc spawn")
    s.add_argument("--memory", help="the memory file holding the job's context, e.g. memory/email.md; `sc events` "
                                    "prints its '## Slack me' section under the job's events")
    s.add_argument("--task-file", help="file holding the task text (otherwise stdin)")
    s.add_argument("--runtime", help=argparse.SUPPRESS)
    s.set_defaults(fn=cmd_cron)

    s = sub.add_parser("context", help="how full sous chef's context is, and when it is warned: "
                                       "show (default), set, off, check")
    s.add_argument("action", nargs="?", choices=["set", "off", "check"])
    s.add_argument("--warn-at", type=float, help="warn once usage reaches this percentage of the window")
    s.add_argument("--rearm-below", type=float,
                   help="warn again only after usage fell below this percentage (default: 10 under --warn-at)")
    s.add_argument("--window", action="append", metavar="MODEL=TOKENS",
                   help="the context window of a model, e.g. claude-opus-5=1m; repeatable")
    s.add_argument("--transcript", help="(check) the transcript to read; default: sous chef's own")
    s.set_defaults(fn=cmd_context)

    s = sub.add_parser("slack", help="Slack through the relay: status (default), setup, send, ask, reply, read")
    s.add_argument("action", nargs="?", choices=["status", "setup", "send", "ask", "reply", "read"],
                   default="status")
    s.add_argument("rest", nargs="*", help="send: the text (or - for stdin); ask: <session> <key> [text]; "
                                           "reply: <n> <text>; read: <n> (n: the #n under [slack] in `sc events`)")
    s.add_argument("--url", help="setup: the relay's address")
    s.add_argument("--key-file", help="setup: a file holding your relay key (kept out of shell history)")
    s.add_argument("--user", help="setup: your Slack user id, e.g. U0123ABCDE")
    s.add_argument("--session", help="send: post into this session's update thread instead of a new message")
    s.add_argument("--before", type=int, help="read: how many messages before a top-level tag (default 10, max 100)")
    s.set_defaults(fn=cmd_slack)

    s = sub.add_parser("worktree", help="create a branch and worktree in a repo, for a session to work in")
    s.add_argument("--repo", required=True, help="repo root (the folder holding .bare/ or the bare repo)")
    s.add_argument("--branch", required=True, help="new branch, e.g. yourname/ABC-123-short-slug")
    s.add_argument("--dir", required=True, help="short kebab-case folder name, e.g. org-invite")
    s.add_argument("--base", help="base branch on origin (default: origin's default branch)")
    s.set_defaults(fn=cmd_worktree)

    s = sub.add_parser("setup", help="install: connect this code folder to your data folder (install.sh runs it); "
                                     "safe to run again")
    s.add_argument("--data", help=f"your data folder (default {setup.DEFAULT_DATA})")
    s.add_argument("--clone", metavar="URL", help="make the data folder by cloning this git URL")
    s.add_argument("--git", action=argparse.BooleanOptionalAction, default=None,
                   help="a new data folder: track it in git (default: yes)")
    s.add_argument("--push-url", metavar="URL", help="push the data folder to this empty repo (never created for you)")
    s.add_argument("--name", help="your name, when the data folder has no owner yet")
    s.add_argument("--branch-prefix", help="your branch prefix, e.g. sam/, when the data folder has no owner yet")
    s.add_argument("--bin-dir", help=f"where to link sc and souschef (default {setup.DEFAULT_BIN})")
    s.add_argument("--yes", action="store_true", help="ask nothing: take the flags, else the defaults")
    s.set_defaults(fn=setup.run)

    s = sub.add_parser("owner", help="who this sous chef works for: show (default), set")
    s.add_argument("action", nargs="?", choices=["show", "set"], default="show")
    s.add_argument("--name", help="set: the owner's name, as sessions and Slack labels show it")
    s.add_argument("--branch-prefix", help="set: the owner's branch prefix, e.g. sam/ (\"\" for none)")
    s.set_defaults(fn=cmd_owner)

    sub.add_parser("sessions", help="list active sessions").set_defaults(fn=cmd_sessions)

    s = sub.add_parser("status", help="details for one session")
    s.add_argument("id")
    s.add_argument("-n", type=int, default=10, help="number of recent events to show")
    s.set_defaults(fn=cmd_status)

    for name, fn, text in (("attach", cmd_attach, "print the command the owner runs to open a session"),
                           ("stop", cmd_stop, "stop a session (conversation kept)"),
                           ("resume", cmd_resume, "start a stopped session again")):
        s = sub.add_parser(name, help=text)
        s.add_argument("id")
        s.set_defaults(fn=fn)

    s = sub.add_parser("mark", help="record who a session is waiting on after handling its events")
    s.add_argument("id")
    s.add_argument("waiting_on", help="owner (or the owner's name), "
                                      + ", ".join(sorted(ops.WAITING_VALUES - {"owner"})))
    s.add_argument("text", nargs="+", help="why")
    s.set_defaults(fn=cmd_mark)

    s = sub.add_parser("cleanup", help="stop and archive a finished session; refuses if work looks unlanded")
    s.add_argument("id")
    s.add_argument("--force", action="store_true", help="skip the unlanded-work check (only with the owner's OK)")
    s.set_defaults(fn=cmd_cleanup)

    s = sub.add_parser("kinds", help="list session kinds, the skill each runs, and whether it is found")
    s.add_argument("--runtime", help=argparse.SUPPRESS)
    s.set_defaults(fn=cmd_kinds)
    sub.add_parser("summary", help="print the startup summary").set_defaults(fn=cmd_summary)
    s = sub.add_parser("chef", help="show which Claude session is registered as sous chef")
    s.add_argument("--take", action="store_true",
                   help="make THIS session sous chef, even if a running one holds it")
    s.set_defaults(fn=cmd_chef)

    s = sub.add_parser("watch", help="run the watcher (normally started automatically)")
    g = s.add_mutually_exclusive_group()
    g.add_argument("--ensure", action="store_true", help="start it in the background if not running")
    g.add_argument("--once", action="store_true", help="run one cycle and print what it did")
    s.set_defaults(fn=cmd_watch)

    s = sub.add_parser("report", help="(inside a session) report an event to sous chef")
    s.add_argument("state", help=", ".join(events.SESSION_STATES))
    s.add_argument("text", nargs="*")
    s.add_argument("--key", help="question key; needs-decision and blocked get one automatically")
    s.set_defaults(fn=cmd_report)

    s = sub.add_parser("inbox", help="(inside a session) read messages from sous chef; `sc inbox ack <n>` after")
    s.add_argument("action", nargs="?", choices=["ack"])
    s.add_argument("seq", nargs="?", type=int)
    s.set_defaults(fn=cmd_inbox)

    s = sub.add_parser("hook", help="(internal) Claude Code hook handlers")
    s.add_argument("hook_name", choices=sorted(hooks.HANDLERS))
    s.add_argument("--session")
    s.set_defaults(fn=hooks.run)
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = args.fn(args)
        return result if isinstance(result, int) else 0
    except util.SCError as e:
        print(f"sc: {e}", file=sys.stderr)
        return 1
