"""The startup summary sous chef reads on every start, resume and compaction.

It has to stay small, because it is loaded into a session that may run for a
very long time. Each memory file is capped, and the summary names the file to
read when something was cut.

Right after the owner line come the owner's own instructions (instructions.md in
the data folder), in full up to INSTRUCTIONS_CAP: the rules that are theirs rather
than sous chef's, so the core's AGENTS.md can stay free of them. The summary is
cut from the end, so TOTAL_CAP leaves room for them before the memory sections.
Paths in headings are written as sous chef reaches them from its folder: my/...
"""
from . import context, cron, events, inbox, records, runtimes, slack, util, watch

FILE_CAP = 6000             # characters per memory file
INSTRUCTIONS_CAP = 12000    # characters of the owner's instructions
TOTAL_CAP = 42000           # characters for the whole summary (roughly 10,500 tokens)
INSTRUCTIONS = "instructions.md"

MEMORY_FILES = [
    ("Current focus", "focus.md"),
    ("Threads index", "threads/index.md"),
    ("Ideas", "ideas.md"),
    ("PoCs", "pocs.md"),
    ("Repos", "repos.md"),
]


def sessions_table(recs=None) -> str:
    recs = records.all_records() if recs is None else recs
    if not recs:
        return "No active sessions."
    listings, lines = {}, []
    for rec in recs:
        rt = runtimes.get(rec["runtime"])
        if rec["runtime"] not in listings:
            try:
                listings[rec["runtime"]] = rt.listing()
            except util.SCError:
                listings[rec["runtime"]] = None
        rows = listings[rec["runtime"]]
        activity = None
        if rows is None:
            running = "unknown"
        else:
            st = rt.status(rec, rows)
            if not st["alive"]:
                running = "stopped"
            elif st.get("prompt"):
                running = "held at a prompt"
            else:
                # busy is None when the runtime cannot tell; never call that idle.
                running = {True: "busy", False: "idle"}.get(st["busy"], "running")
            if st["alive"]:
                activity = st.get("activity")
                n = (activity or {}).get("in_flight")
                if n:
                    running += f", {n} in flight"
        log = events.read_all(rec["id"])
        last = events.last_session_event(log)
        last_txt = f"{last['state']} {util.age(last['ts'])} ago" if last else "-"
        extras = []
        if events.open_questions(log):
            extras.append(f"{len(events.open_questions(log))} open question(s)")
        if inbox.unhandled(rec["id"]):
            extras.append(f"{len(inbox.unhandled(rec['id']))} unhandled message(s)")
        waiting = events.show_waiting(events.waiting_on(log))
        lines.append(f"- {rec['id']} | {rec['kind']} | {running} | waiting on: {waiting} | "
                     f"last: {last_txt} | {rec['title']}" + (f" | {', '.join(extras)}" if extras else ""))
        doing = activity_line(activity)
        if doing:
            lines.append(f"    {doing}")
    return "\n".join(lines)


def activity_line(activity, most=2) -> str:
    """One line on what a running session says it is doing and which subagents it has running, or "".

    At most `most` subagent labels are named; `sc status` lists everything running.
    """
    if not activity:
        return ""
    parts = []
    if activity.get("detail"):
        parts.append(f"doing: {activity['detail']}")
    agents = [r["label"] for r in activity.get("running") or [] if r.get("kind") == "subagent"]
    if agents:
        named = ", ".join(agents[:most]) + (f", +{len(agents) - most} more" if len(agents) > most else "")
        parts.append(f"subagents: {named}")
    return " | ".join(parts)


def cron_lines() -> str:
    jobs, broken = cron.all_jobs()
    if not jobs and not broken:
        return "None."
    lines = [f"- {j['name']}: {cron.schedule_text(j)}, done by {'a worker' if j['target'] == 'worker' else 'you'}"
             for j in jobs]
    lines += [f"- {name}: BROKEN, see `sc cron list`" for name in broken]
    return "\n".join(lines)


def _watcher_line() -> str:
    h = watch.health()
    if not h["running"]:
        return "NOT RUNNING: run `sc watch --ensure`"
    return "running" if h["current"] else f"running, but NOT ON CURRENT CODE: {h['problem']}"


def _file_section(title: str, path, shown: str, cap: int, read=lambda p: p.read_text().strip()) -> str:
    """One file in full under a heading naming it as `shown`, cut at `cap` characters saying where the rest is."""
    if not path.is_file():
        return f"## {title} ({shown})\nABSENT"
    text = read(path)
    if len(text) > cap:
        text = text[:cap] + f"\n[... cut at {cap} characters; read {shown} for the rest]"
    return f"## {title} ({shown})\n{text or '(empty)'}"


def _memory_section(title: str, rel: str) -> str:
    return _file_section(title, util.memory_dir() / rel, f"my/memory/{rel}", FILE_CAP)


def instructions_section() -> str:
    """The owner's instructions, with their <!-- comments --> left out."""
    return _file_section("Your owner's instructions: follow them as you follow AGENTS.md",
                         util.home() / INSTRUCTIONS, f"my/{INSTRUCTIONS}", INSTRUCTIONS_CAP, util.owner_text)


def owner_line() -> str:
    """The summary's first line: who sous chef works for, or how to set it. Never refuses."""
    try:
        o = util.owner()
    except util.SCError as e:
        return f"No usable owner: {e}."
    if not o:
        return "No owner set: run `sc owner set --name <name> --branch-prefix <prefix>`."
    return f"Owner: {o['name']}. Branch prefix: {o['branch_prefix'] or '(none)'}."


def build() -> str:
    recs = records.all_records()
    unread = {r["id"]: events.unread(r["id"]) for r in recs}
    unread[events.CRON_LOG] = events.unread(events.CRON_LOG)
    unread[events.SLACK_LOG] = events.unread(events.SLACK_LOG)
    unread[events.SYNC_LOG] = events.unread(events.SYNC_LOG)
    unread_count = sum(len([e for e in es if e["state"] in events.WAKE_STATES])
                       for es in unread.values())
    # Context warnings never wake anyone (context.py), but each one asks for action.
    unread_count += len(events.unread(events.CONTEXT_LOG))
    # Notes stay out of WAKE_STATES on purpose: they need no action, so they must not
    # interrupt. But nothing else surfaced them either, so a note sat unread until
    # someone happened to run `sc events`. Counting them here means they are picked up
    # at the next start, resume or compaction without waking anyone.
    note_count = sum(len([e for e in es if e["state"] == "note"]) for es in unread.values())
    open_q = sum(len(events.open_questions(events.read_all(r["id"]))) for r in recs)
    attention = f"Unread events needing attention: {unread_count}. Open questions: {open_q}."
    if note_count:
        attention += f" Unread notes (no action needed): {note_count}."
    attention += (" Run `sc events` now." if unread_count or open_q or note_count
                  else " Nothing waiting.")
    parts = [
        owner_line(),
        instructions_section(),
        "## Sessions\n" + sessions_table(recs),
        "## Attention\n" + attention,
        "## Watcher\n" + _watcher_line(),
        "## Cron jobs\n" + cron_lines(),
        "## Context check (`sc context`)\n" + "\n".join(context.status_lines()),
        "## Slack (`sc slack status`)\n" + "\n".join(slack.status_lines()),
    ]
    parts += [_memory_section(t, rel) for t, rel in MEMORY_FILES]
    text = "\n\n".join(parts)
    if len(text) > TOTAL_CAP:
        text = text[:TOTAL_CAP] + "\n[... summary cut; run `sc summary` in full or read the memory files]"
    return text
