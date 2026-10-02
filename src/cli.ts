// `sc`: the sous chef command line. Run `sc --help` or `sc <command> --help`.

import path from "node:path";
import { ArgExit, Command, parse, Parsed } from "./args.js";
import * as chef from "./chef.js";
import * as context from "./context.js";
import * as cron from "./cron.js";
import * as events from "./events.js";
import * as hooks from "./hooks.js";
import * as inbox from "./inbox.js";
import { print, printErr, readStdin, stdinIsTty } from "./io.js";
import * as kinds from "./kinds.js";
import * as ops from "./ops.js";
import { commas, Dict, fixed, get, isFile, or, readText, sorted, truthy } from "./py.js";
import * as records from "./records.js";
import * as runtimes from "./runtimes/index.js";
import * as setup from "./setup.js";
import * as slack from "./slack.js";
import * as summary from "./summary.js";
import { age, NO_OWNER, now, owner, ownerName, ownerPath, requireOwner, SCError } from "./util.js";
import * as watch from "./watch.js";
import * as worktrees from "./worktrees.js";

type Args = Parsed;

function s(args: Args, key: string): string | null {
  const v = args[key];
  return v === undefined || v === null ? null : String(v);
}

async function readTask(args: Args): Promise<string> {
  if (args.task_file) return readText(String(args.task_file));
  if (!stdinIsTty()) return readStdin();
  return "";
}

async function textArg(parts: string[]): Promise<string> {
  return parts.length === 1 && parts[0] === "-" ? readStdin() : parts.join(" ");
}

// --- sous chef commands ----------------------------------------------------

async function cmdSpawn(args: Args): Promise<void> {
  const rec = await ops.spawn(s(args, "kind")!, s(args, "title")!, s(args, "cwd")!, await readTask(args), {
    thread: s(args, "thread"), model: s(args, "model"), effort: s(args, "effort"), runtime: s(args, "runtime"),
    permissions: s(args, "permissions") });
  const kind = kinds.load(rec.kind);
  const rt = runtimes.get(rec.runtime);
  print(`launched ${rec.id} (${rec.kind}: ${rec.title})`);
  print(`  attach: ${rt.attachCommand(rec)}`);
  print(`  starts waiting on: ${events.showWaiting(kind.starts_waiting_on)}`);
  print(`  permissions: ${String(rec.permissions)}`);
  if (!truthy(records.handle(rec).session_id)) {
    printErr("  warning: the Claude session id was not found yet; `sc status` will retry");
  }
  if (!truthy(rec.thread)) {
    printErr("  warning: no --thread, so standing instructions about this session (a '## Slack me' section in " +
      "its thread file) have nowhere to live");
  }
}

async function cmdSend(args: Args): Promise<void> {
  const rec = records.resolve(s(args, "id")!);
  const text = await textArg(args.text as string[]);
  const [msg, problem] = await ops.send(rec, text, { resolves: s(args, "resolves") });
  if (!problem) {
    print(`message ${msg.seq} saved to ${rec.id}'s inbox and the session was woken`);
  } else {
    print(`message ${msg.seq} saved to ${rec.id}'s inbox, but the session was not woken: ${problem}. ` +
      `It will read the message when it next runs \`sc inbox\` (\`sc resume ${rec.id}\` if it is stopped).`);
  }
}

async function cmdEvents(args: Args): Promise<void> {
  if (args.action === "ack") {
    if (!args.token) throw new SCError("usage: sc events ack <token>");
    const moved = await events.ack(String(args.token));
    print(`acknowledged: ${moved.length ? moved.join(", ") : "nothing new"}`);
    return;
  }
  requireOwner();
  const tokenParts: string[] = [];
  let printed = false;
  const logs: (records.Rec | string)[] = [...records.allRecords(), ...events.CHEF_LOGS];
  for (const item of logs) {
    const sid = typeof item === "string" ? item : item.id;
    const rec = typeof item === "string" ? null : item;
    const log = events.readAll(sid);
    const fresh = events.unread(sid, log);
    if (!fresh.length) continue;
    if (!printed) {
      print("UNREAD EVENTS");
      printed = true;
    }
    if (rec) {
      const rt = runtimes.get(rec.runtime);
      const job = truthy(rec.cron) ? ` | cron job ${String((rec.cron as Dict).job)}` : "";
      const waiting = events.showWaiting(events.waitingOn(log));
      print(`\n[${sid}] ${rec.kind}: ${rec.title} | waiting on: ${waiting} | attach: ${rt.attachCommand(rec)}${job}`);
    } else if (sid === events.CRON_LOG) {
      print(`\n[${sid}] scheduled jobs for sous chef itself (\`sc cron list\`)`);
    } else if (sid === events.SLACK_LOG) {
      print(`\n[${sid}] messages from Slack, collected from the relay (\`sc slack status\`)`);
      for (const e of fresh) print(slack.describe(e).join("\n"));
      tokenParts.push(`${sid}:${fresh[fresh.length - 1]!.seq}`);
      continue;
    } else if (sid === events.SYNC_LOG) {
      print(`\n[${sid}] keeping your data folder committed and pushed (docs/domains/watcher.md)`);
    } else {
      print(`\n[${sid}] how full your own context is (\`sc context\`)`);
    }
    for (const e of fresh) {
      const key = e.key ? ` key=${e.key}` : "";
      print(`  #${e.seq} ${e.state}${key} (${e.author}, ${age(e.ts)} ago): ${e.text}`);
    }
    const linked = rec ? slack.linkedMemory(rec)
      : [...new Set(fresh.map((e) => e.job).filter((j) => truthy(j)) as string[])].map((j) => slack.jobMemory(j));
    for (const line of slack.instructionLines(linked.filter((m): m is string => truthy(m)))) print(line);
    tokenParts.push(`${sid}:${fresh[fresh.length - 1]!.seq}`);
  }
  if (!printed) print("No unread events.");
  const openLines: string[] = [];
  for (const rec of records.allRecords()) {
    for (const q of events.openQuestions(events.readAll(rec.id))) {
      openLines.push(`  [${rec.id}] key=${q.key} (#${q.seq}, ${age(q.ts)} ago): ${q.text}\n` +
        `    answer: sc send ${rec.id} --resolves ${q.key} "..."`);
    }
  }
  if (openLines.length) {
    print("\nOPEN QUESTIONS (listed until answered with --resolves, or resolved by the session)");
    print(openLines.join("\n"));
    for (const line of slack.instructionLines([slack.GENERAL_INSTRUCTIONS])) print(line);
  }
  if (tokenParts.length) print(`\nAfter handling these, run: sc events ack ${tokenParts.join(",")}`);
}

async function cmdContext(args: Args): Promise<void> {
  if (args.action === "check") {
    let p = s(args, "transcript");
    if (!p) {
      const held = get<string | null>(or(chef.current(), {}), "session_id", null);
      if (!held) throw new SCError("no sous chef session is registered; pass --transcript PATH");
      p = context.findTranscript(held);
    }
    let r: context.Reading;
    try {
      r = context.readUsage(p);
    } catch (e) {
      if (e instanceof context.ReadError) throw new SCError(`could not read usage: ${e.message}`);
      throw e;
    }
    print(`transcript: ${p}`);
    if (r.compacted) {
      print(`compacted at ${String(r.timestamp ?? "None")} (before: ${String(r.pre_tokens ?? "None")} tokens); no turn since`);
      return;
    }
    print(`context: ${commas(r.tokens!)} tokens (${Object.entries(r.parts!).map(([k, v]) => `${k} ${commas(v)}`).join(" + ")})`);
    print(`model: ${String(r.model)}; turn at ${String(r.timestamp ?? "None")}`);
    const size = get<number | null>(or(context.config().windows, {}), r.model as string, null);
    print(truthy(size) ? `window: ${commas(size!)} tokens, so ${fixed((100.0 * r.tokens!) / size!, 1)}% full`
      : `window: none set for ${String(r.model)} (\`sc context set --window ${String(r.model)}=TOKENS\`)`);
    print("(read only: nothing recorded, no events written)");
    return;
  }
  if (args.action === "set" || args.action === "off") {
    const windows: Record<string, number> = {};
    for (const w of (args.window as string[] | null) ?? []) {
      const [model, n] = context.parseWindow(w);
      windows[model] = n;
    }
    if (args.action === "set" && args.warn_at === null && args.rearm_below === null && !Object.keys(windows).length) {
      throw new SCError("usage: sc context set [--warn-at N] [--rearm-below N] [--window MODEL=TOKENS]");
    }
    context.setConfig(args.warn_at as number | null, args.rearm_below as number | null, windows, args.action === "off");
    print(`saved ${path.basename(context.configPath())} (tracked in git; commit it to keep it)`);
  }
  print(context.statusLines().join("\n"));
}

async function cmdCron(args: Args): Promise<void> {
  const action = s(args, "action")!;
  if (action === "add") {
    if (!args.name) {
      throw new SCError("usage: sc cron add <name> (--at HH:MM[,HH:MM] | --every 6h) " +
        "--target chef|worker ...; task on stdin");
    }
    const job = await cron.add({ name: args.name, at: args.at, every: args.every, target: args.target,
      kind: args.kind, cwd: args.cwd, title: args.title, model: args.model, effort: args.effort,
      thread: args.thread, memory: args.memory, runtime: args.runtime, task: await readTask(args) });
    print(`added cron job ${job.name}: ${cron.scheduleText(job)}, target ${job.target}`);
    print(`  definition: cron/${job.name}.md (tracked in git; commit it to keep it)`);
    print("  it first fires at its next scheduled time, and only while sous chef is running");
    return;
  }
  if (action === "remove" || action === "run") {
    if (!args.name) throw new SCError(`usage: sc cron ${action} <name>`);
    const name = String(args.name);
    if (action === "remove") {
      await cron.remove(name);
      print(`removed cron job ${name} (cron/${name}.md deleted)`);
    } else {
      print(`cron job ${name}: ${await cron.runNow(name)}`);
    }
    return;
  }
  const [jobs, broken] = cron.allJobs();
  if (!jobs.length && !Object.keys(broken).length) {
    print("No cron jobs. Add one with `sc cron add`.");
    return;
  }
  const runs = cron.runs();
  const t = now();
  const blocker = jobs.length ? await cronBlocker() : null;
  if (blocker) print(`${blocker}\n`);
  for (const job of jobs) {
    const run = (Object.hasOwn(runs, job.name) ? runs[job.name] : {}) as Dict;
    const where = job.target === "worker" ? `worker (${String(job.kind)} in ${String(job.cwd)})` : "sous chef";
    print(`${job.name}: ${cron.scheduleText(job)} | ${where}`);
    const fired = truthy(run.last_fired) ? `${age(run.last_fired as number)} ago` : "never";
    print(`  last fired: ${fired}; last result: ${String(get(run, "last_result", "-"))}`);
    if (cron.isDue(job, run, t)) {
      // A due time in the past never arrives: say why it has not fired instead.
      const slot = cron.latestSlot(job, run, t)!;
      const why = blocker ? "see the line at the top"
        : "the watcher fires it on its next cycle; if this persists, check state/watch.log";
      print(`  OVERDUE: due since ${cron.localTimeText(slot)} (${age(slot)} ago) and not fired yet: ${why}`);
      continue;
    }
    const nxt = cron.nextSlot(job, run, t);
    print(`  next due: ${cron.localTimeText(nxt)} (in ${age(t - (nxt - t))})`);
  }
  for (const [name, problem] of Object.entries(broken)) print(`${name}: BROKEN, never fires until fixed: ${problem}`);
}

/** Why jobs cannot fire right now, or may not, as one line for `sc cron list`; null if they can. */
async function cronBlocker(): Promise<string | null> {
  const h = await watch.health();
  if (!h.running) return `WARNING: ${h.problem}.`;
  if (!h.current) return `WARNING: ${h.problem}.`;
  if (!(await chef.liveIncumbent())) {
    return "WARNING: sous chef is not running, so nothing fires: jobs fire only while it runs. Each due " +
      "job fires once when it is back (`souschef`).";
  }
  return null;
}

async function cmdSlack(args: Args): Promise<void> {
  const rest = (args.rest as string[] | null) ?? [];
  const action = s(args, "action");
  if (action === "setup") {
    if (!(args.url && args.key_file && args.user)) {
      throw new SCError("usage: sc slack setup --url <relay url> --key-file <path> --user <your Slack user id>");
    }
    const done = await slack.setup(String(args.url), String(args.key_file), String(args.user));
    print(`wrote ${done.path} (mode 600, gitignored); ${done.checked}`);
    return;
  }
  if (action === "send") {
    const text = await textArg(rest);
    const session = s(args, "session");
    const sent = await slack.send(text, session);
    let where = `${ownerName()}'s DM with the bot`;
    if (session) {
      where = sent.thread === "new" ? `a new update thread for ${session}` : `the update thread for ${session}`;
    }
    print(`sent to ${where} (conversation ${String(sent.conversation_id)}, message ${String(sent.message_id)})`);
    return;
  }
  if (action === "ask") {
    if (rest.length < 2) throw new SCError('usage: sc slack ask <session> <key> ["<the question, reworded>"]');
    const sent = await slack.ask(rest[0]!, rest[1]!, rest.slice(2).join(" ") || null);
    const who = ownerName();
    print(`asked in a new thread in ${who}'s DM (message ${String(sent.message_id)}); ${who}'s reply there comes back ` +
      "under [slack] in `sc events`, labelled with the question");
    return;
  }
  if (action === "reply") {
    if (rest.length < 2) throw new SCError('usage: sc slack reply <n> "<text>" (n: the #n under [slack] in `sc events`)');
    const text = await textArg(rest.slice(1));
    const sent = await slack.reply(rest[0]!, text);
    print(`replied in the thread (conversation ${String(sent.conversation_id)}, thread ${String(sent.parent_id)})`);
    return;
  }
  if (action === "read") {
    if (rest.length !== 1) throw new SCError("usage: sc slack read <n> [--before N] (n: the #n under [slack] in `sc events`)");
    print((await slack.read(rest[0]!, args.before as number | null)).join("\n"));
    return;
  }
  print((await slack.statusLines(true)).join("\n"));
}

async function cmdWorktree(args: Args): Promise<void> {
  const wt = await worktrees.create(s(args, "repo")!, s(args, "branch")!, s(args, "dir")!, s(args, "base"));
  print(`created ${wt.path} on branch ${wt.branch} from origin/${wt.base} (not pushed, no upstream)`);
  if (wt.env_linked.length) print(`  linked env files from .local/: ${wt.env_linked.join(", ")}`);
  else if (wt.has_local) print("  .local/ has no .env files, so none were linked");
  else print("  the repo has no .local/ folder, so no env files were linked; the session may need them");
  print("  dependencies are not installed; the session installs them if it needs to");
  print(`  next: sc spawn --cwd ${wt.path} ...`);
}

async function cmdOwner(args: Args): Promise<void> {
  if (args.action === "set") {
    const given = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
    if (args.name === "" || [args.name, args.branch_prefix, args.chef_permissions].every((v) => given(v) === null)) {
      throw new SCError(ops.OWNER_SET_USAGE);
    }
    ops.setOwner({ name: given(args.name), branchPrefix: given(args.branch_prefix),
      chefPermissions: given(args.chef_permissions) });
    print(`saved ${path.basename(ownerPath())} (tracked in git; commit it to keep it)`);
  }
  const o = owner();
  if (!o) {
    print(NO_OWNER);
    return;
  }
  print(`owner: ${o.name}`);
  print(`branch prefix: ${o.branch_prefix || "(none)"}`);
  print(`sessions waiting on the owner show as: waiting on: ${o.lower}`);
  print(`sous chef's own permission mode: ${o.chef_permissions} (a new sous chef starts in it; ` +
    "change it with sc owner set --chef-permissions)");
}

async function cmdSessions(): Promise<void> {
  print(await summary.sessionsTable());
}

async function cmdStatus(args: Args): Promise<void> {
  const rec = records.resolve(s(args, "id")!);
  const rt = runtimes.get(rec.runtime);
  const log = events.readAll(rec.id);
  const st = await rt.status(rec);
  // The same turn times the watcher uses: the runtime's own when it keeps them, else turns.json.
  const turns = (st.turns ?? records.turns(rec.id)) as Dict;
  print(`${rec.id} (${rec.kind}: ${rec.title})`);
  print(`  running: ${st.alive ? "yes" : "no"}${truthy(st.busy) && !truthy(st.prompt) ? " (busy)" : ""}` +
    `${truthy(rec.stopped_by_sc) ? " (stopped by sous chef)" : ""}`);
  if (truthy(st.prompt)) print(`  HELD AT A PROMPT: ${st.prompt} (answer it in the session: ${rt.attachCommand(rec)})`);
  const activity = st.alive ? (st.activity as Dict | null | undefined) : null;
  if (truthy(activity)) {
    if (truthy(activity!.detail)) print(`  doing: ${String(activity!.detail)}`);
    if (get(activity, "in_flight", null) !== null) {
      print(`  subagents and background commands in flight: ${String(activity!.in_flight)}`);
    }
    for (const r of (or(activity!.running, []) as Dict[])) {
      const since = truthy(r.since) ? `, started ${age(r.since as number)} ago` : "";
      print(`    ${String(r.kind)}: ${String(r.label)}${since}`);
    }
  }
  print(`  permissions: ${String(or(rec.permissions, runtimes.DEFAULT_PERMISSIONS))}`);
  print(`  waiting on: ${events.showWaiting(events.waitingOn(log))}`);
  print(`  attach: ${rt.attachCommand(rec)}`);
  print(`  cwd: ${rec.cwd}${truthy(rec.own_worktree) ? " (worktree created for this session)" : ""}`);
  print(`  brief: ${path.join(records.sessionDir(rec.id), "brief.md")}`);
  const report = path.join(records.sessionDir(rec.id), "report.md");
  if (isFile(report)) print(`  report: ${report}`);
  if (truthy(rec.thread)) print(`  thread: memory/threads/${String(rec.thread)}.md`);
  for (const field of ["last_prompt_at", "last_stop_at"]) {
    if (truthy(turns[field])) print(`  ${field.replace(/_/g, " ")}: ${age(turns[field] as number)} ago`);
  }
  print(`  unhandled inbox messages: ${inbox.unhandled(rec.id).length}`);
  print("  recent events:");
  const n = args.n as number;
  // log[-n:] as Python slices it: the last n, all of it for 0, and from index |n| for a negative n.
  const from = -n < 0 ? Math.max(log.length - n, 0) : Math.min(-n, log.length);
  for (const e of log.slice(from)) {
    const key = e.key ? ` key=${e.key}` : "";
    print(`    #${e.seq} ${e.state}${key} (${e.author}, ${age(e.ts)} ago): ${e.text}`);
  }
  for (const q of events.openQuestions(log)) print(`  OPEN QUESTION key=${q.key}: ${q.text}`);
}

async function cmdAttach(args: Args): Promise<void> {
  const rec = records.resolve(s(args, "id")!);
  print(runtimes.get(rec.runtime).attachCommand(rec));
}

async function cmdStop(args: Args): Promise<void> {
  const rec = records.resolve(s(args, "id")!);
  await ops.stop(rec);
  print(`stopped ${rec.id}; its conversation is kept (resume with \`sc resume ${rec.id}\`)`);
}

async function cmdResume(args: Args): Promise<void> {
  const rec = records.resolve(s(args, "id")!);
  await ops.resume(rec);
  print(`resumed ${rec.id}; attach: ${runtimes.get(rec.runtime).attachCommand(rec)}`);
}

async function cmdMark(args: Args): Promise<void> {
  const rec = records.resolve(s(args, "id")!);
  await ops.mark(rec, s(args, "waiting_on")!, (args.text as string[]).join(" "));
  print(`${rec.id} is now waiting on: ${events.showWaiting(events.waitingOn(events.readAll(rec.id)))}`);
}

async function cmdCleanup(args: Args): Promise<void> {
  const rec = records.resolve(s(args, "id")!);
  await ops.cleanup(rec, Boolean(args.force));
  print(`cleaned up ${rec.id}: stopped if running, record moved to state/archive/${rec.id}`);
}

async function cmdKinds(args: Args): Promise<void> {
  const rt = runtimes.get(s(args, "runtime") || runtimes.DEFAULT);
  for (const name of kinds.names()) {
    const k = kinds.load(name);
    const perms = k.permissions ? `  (permissions: ${k.permissions})` : "";
    let skill = "";
    if (k.skill) {
      // No working directory here, so only the skills every session gets are checked.
      const missing = (await rt.skillAvailable(k.skill, null)) === false;
      skill = `  skill: ${k.skill}` + (missing ? " (not found in your skills)" : "");
    }
    const source = k.source === "user" ? (k.replaces_core ? "  [user, replaces core]" : "  [user]") : "";
    print(`${name.padEnd(14)} starts waiting on ${events.showWaiting(k.starts_waiting_on).padEnd(6)}  ` +
      `${k.description}${perms}${skill}${source}`);
    if (k.skill && !kinds.namesSkill(k.body, k.skill)) {
      print(`  warning: ${k.path} declares the skill '${k.skill}' but its instructions never name ` +
        `/${k.skill}; make them match`);
    }
  }
}

async function cmdSummary(): Promise<void> {
  print(await summary.build());
}

async function cmdWatch(args: Args): Promise<number | void> {
  if (args.once) {
    for (const a of (await watch.cycle()).actions) print(a);
    return;
  }
  if (args.ensure) {
    const result = await watch.ensure();
    if (result.note) {
      const line = `sc watch: ${result.note}`;
      if (result.running) print(line);
      else printErr(line);
    }
    print(result.running ? "watcher running" : "watcher failed to start; see state/watch.log");
    return;
  }
  return watch.runForever();
}

async function cmdChef(args: Args): Promise<void> {
  if (args.take) {
    const claudeSid = process.env.CLAUDE_CODE_SESSION_ID;
    if (!claudeSid) {
      throw new SCError("CLAUDE_CODE_SESSION_ID is not set, so there is no session to register. " +
        "Run `sc chef --take` from inside the Claude session that should be sous chef.");
    }
    const prev = chef.register(claudeSid, process.env.SC_CHEF_RUNTIME || "claude-bg");
    const was = prev && prev.session_id !== claudeSid ? ` (taken from ${String(prev.session_id).slice(0, 8)})` : "";
    print(`this session (${claudeSid.slice(0, 8)}) is now sous chef${was}`);
    print("if the previous one is still running, stop it: two sous chefs share one set of files");
    return;
  }
  const info = chef.current();
  if (!info) {
    print("no sous chef session registered yet");
    return;
  }
  print(`sous chef session: ${info.session_id} (runtime ${info.runtime}, registered ${age(info.registered_at)} ago)`);
  const rt = runtimes.get(info.runtime);
  let row: Dict | undefined;
  try {
    const rows = await rt.listing();
    row = Object.hasOwn(rows, info.session_id) ? rows[info.session_id] : undefined;
  } catch (e) {
    if (!(e instanceof SCError)) throw e;
    print(`  could not check whether it is running: ${e.message}`);
    return;
  }
  if (row && truthy(row.pid)) {
    print(`  running (pid ${String(row.pid)}), so wake-ups can reach it`);
  } else {
    print("  NOT running, so wake-ups cannot reach it; events wait on disk until it starts " +
      "(`souschef`), and `sc events` still lists them");
  }
}

// --- session commands ------------------------------------------------------

async function cmdReport(args: Args): Promise<void> {
  const event = await ops.report(s(args, "state")!, (args.text as string[]).join(" "), s(args, "key"));
  const key = event.key ? ` (key ${event.key})` : "";
  print(`reported ${event.state}${key} as event #${event.seq}`);
  if (event.woke_sous_chef === false) print("sous chef could not be woken just now; it will see this when it next looks.");
}

async function cmdInbox(args: Args): Promise<void> {
  const rec = await ops.currentSessionRecord();
  if (args.action === "ack") {
    if (args.seq === null) throw new SCError("usage: sc inbox ack <n>");
    inbox.ack(rec.id, args.seq as number);
    print(`message ${String(args.seq)} marked handled`);
    return;
  }
  const msgs = inbox.unhandled(rec.id);
  if (!msgs.length) {
    print("Inbox is empty.");
    return;
  }
  for (const m of msgs) {
    const extra = m.resolves ? ` (answers your question ${m.resolves})` : "";
    print(`--- message ${m.seq} from ${m.from}, ${age(m.ts)} ago${extra}\n${m.text}\n`);
  }
  print("After acting on a message, run: sc inbox ack <n>");
}

// --- the parser ------------------------------------------------------------

const PERMISSIONS_HELP = "what the session may do without asking: " +
  Object.entries(runtimes.PERMISSIONS).map(([k, v]) => `${k}: ${v}`).join("; ") +
  ` (default: the kind's permissions, shown by \`sc kinds\`, else ${runtimes.DEFAULT_PERMISSIONS})`;

const COMMANDS: (Command & { fn: (args: Args) => Promise<number | void> })[] = [
  { name: "spawn", help: "launch a session; task text on stdin or --task-file", fn: cmdSpawn, args: [
    { flags: ["--kind"], dest: "kind", required: true, help: "see `sc kinds`" },
    { flags: ["--title"], dest: "title", required: true, help: "short human title" },
    { flags: ["--cwd"], dest: "cwd", required: true, help: "directory the session starts in" },
    { flags: ["--task-file"], dest: "task_file", help: "file holding the task text (otherwise stdin)" },
    { flags: ["--thread"], dest: "thread", help: "memory thread slug this work belongs to" },
    { flags: ["--model"], dest: "model", help: "model alias, e.g. opus or sonnet (default: Claude Code's default)" },
    { flags: ["--effort"], dest: "effort", help: "low, medium, high, xhigh or max" },
    { flags: ["--permissions"], dest: "permissions", choices: Object.keys(runtimes.PERMISSIONS), help: PERMISSIONS_HELP },
    { flags: ["--runtime"], dest: "runtime", hidden: true },
  ] },
  { name: "send", help: "message a session (text, or - for stdin)", fn: cmdSend, args: [
    { dest: "id" },
    { dest: "text", nargs: "+" },
    { flags: ["--resolves"], dest: "resolves", metavar: "KEY", help: "this message answers the open question with KEY" },
  ] },
  { name: "events", help: "show unread events and open questions; `sc events ack <token>` after", fn: cmdEvents, args: [
    { dest: "action", nargs: "?", choices: ["ack"] },
    { dest: "token", nargs: "?" },
  ] },
  { name: "cron", help: "scheduled jobs the watcher fires while sous chef runs: list (default), add, remove, run (fire now)",
    fn: cmdCron, args: [
      { dest: "action", nargs: "?", choices: ["list", "add", "remove", "run"], default: "list" },
      { dest: "name", nargs: "?", help: "job name, kebab-case, e.g. email-check" },
      { flags: ["--at"], dest: "at", group: "schedule", help: "times of day, local, 24-hour: 09:00,16:00" },
      { flags: ["--every"], dest: "every", group: "schedule", help: "interval: 30m, 6h, 1d" },
      { flags: ["--target"], dest: "target", choices: cron.TARGETS,
        help: "chef: sous chef does it; worker: a session is launched for it (or, if the previous " +
          "run's session is still going, sent the task in its inbox)" },
      { flags: ["--kind"], dest: "kind", help: "worker only: as for sc spawn" },
      { flags: ["--cwd"], dest: "cwd", help: "worker only: as for sc spawn" },
      { flags: ["--title"], dest: "title", help: "worker only: session title (default: the job name)" },
      { flags: ["--model"], dest: "model", help: "worker only: as for sc spawn" },
      { flags: ["--effort"], dest: "effort", help: "worker only: as for sc spawn" },
      { flags: ["--thread"], dest: "thread", help: "worker only: as for sc spawn" },
      { flags: ["--memory"], dest: "memory", help: "the memory file holding the job's context, e.g. memory/email.md; " +
        "`sc events` prints its '## Slack me' section under the job's events" },
      { flags: ["--task-file"], dest: "task_file", help: "file holding the task text (otherwise stdin)" },
      { flags: ["--runtime"], dest: "runtime", hidden: true },
    ] },
  { name: "context", help: "how full sous chef's context is, and when it is warned: show (default), set, off, check",
    fn: cmdContext, args: [
      { dest: "action", nargs: "?", choices: ["set", "off", "check"] },
      { flags: ["--warn-at"], dest: "warn_at", type: "float", help: "warn once usage reaches this percentage of the window" },
      { flags: ["--rearm-below"], dest: "rearm_below", type: "float",
        help: "warn again only after usage fell below this percentage (default: 10 under --warn-at)" },
      { flags: ["--window"], dest: "window", action: "append", metavar: "MODEL=TOKENS",
        help: "the context window of a model, e.g. claude-opus-5=1m; repeatable" },
      { flags: ["--transcript"], dest: "transcript", help: "(check) the transcript to read; default: sous chef's own" },
    ] },
  { name: "slack", help: "Slack through the relay: status (default), setup, send, ask, reply, read", fn: cmdSlack, args: [
    { dest: "action", nargs: "?", choices: ["status", "setup", "send", "ask", "reply", "read"], default: "status" },
    { dest: "rest", nargs: "*", help: "send: the text (or - for stdin); ask: <session> <key> [text]; " +
      "reply: <n> <text>; read: <n> (n: the #n under [slack] in `sc events`)" },
    { flags: ["--url"], dest: "url", help: "setup: the relay's address" },
    { flags: ["--key-file"], dest: "key_file", help: "setup: a file holding your relay key (kept out of shell history)" },
    { flags: ["--user"], dest: "user", help: "setup: your Slack user id, e.g. U0123ABCDE" },
    { flags: ["--session"], dest: "session", help: "send: post into this session's update thread instead of a new message" },
    { flags: ["--before"], dest: "before", type: "int",
      help: "read: how many messages before a top-level tag (default 10, max 100)" },
  ] },
  { name: "worktree", help: "create a branch and worktree in a repo, for a session to work in", fn: cmdWorktree, args: [
    { flags: ["--repo"], dest: "repo", required: true, help: "repo root (the folder holding .bare/ or the bare repo)" },
    { flags: ["--branch"], dest: "branch", required: true, help: "new branch, e.g. yourname/ABC-123-short-slug" },
    { flags: ["--dir"], dest: "dir", required: true, help: "short kebab-case folder name, e.g. org-invite" },
    { flags: ["--base"], dest: "base", help: "base branch on origin (default: origin's default branch)" },
  ] },
  { name: "setup", help: "install: connect this code folder to your data folder (install.sh runs it); safe to run again",
    fn: (args) => setup.runSetup(args as unknown as setup.SetupArgs), args: [
      { flags: ["--data"], dest: "data", help: `your data folder (default ${setup.DEFAULT_DATA})` },
      { flags: ["--clone"], dest: "clone", metavar: "URL", help: "make the data folder by cloning this git URL" },
      { flags: ["--git"], dest: "git", action: "boolean_optional", help: "a new data folder: track it in git (default: yes)" },
      { flags: ["--push-url"], dest: "push_url", metavar: "URL",
        help: "push the data folder to this empty repo (never created for you)" },
      { flags: ["--name"], dest: "name", help: "your name, when the data folder has no owner yet" },
      { flags: ["--branch-prefix"], dest: "branch_prefix",
        help: "your branch prefix, e.g. sam/, when the data folder has no owner yet" },
      { flags: ["--chef-permissions"], dest: "chef_permissions", choices: ["auto", "bypass"],
        help: "the permission mode sous chef's own session starts in, when the data folder has not chosen one " +
          "(default: auto)" },
      { flags: ["--bin-dir"], dest: "bin_dir", help: `where to link sc and souschef (default ${setup.DEFAULT_BIN})` },
      { flags: ["--yes"], dest: "yes", action: "store_true", help: "ask nothing: take the flags, else the defaults" },
    ] },
  { name: "owner", help: "who this sous chef works for: show (default), set", fn: cmdOwner, args: [
    { dest: "action", nargs: "?", choices: ["show", "set"], default: "show" },
    { flags: ["--name"], dest: "name", help: "set: the owner's name, as sessions and Slack labels show it" },
    { flags: ["--branch-prefix"], dest: "branch_prefix", help: 'set: the owner\'s branch prefix, e.g. sam/ ("" for none)' },
    { flags: ["--chef-permissions"], dest: "chef_permissions", choices: ["auto", "bypass"],
      help: "set: the permission mode sous chef's own session starts in (a running sous chef keeps its mode " +
        "until souschef --new)" },
  ] },
  { name: "sessions", help: "list active sessions", fn: cmdSessions, args: [] },
  { name: "status", help: "details for one session", fn: cmdStatus, args: [
    { dest: "id" },
    { flags: ["-n"], dest: "n", type: "int", default: 10, help: "number of recent events to show" },
  ] },
  { name: "attach", help: "print the command the owner runs to open a session", fn: cmdAttach, args: [{ dest: "id" }] },
  { name: "stop", help: "stop a session (conversation kept)", fn: cmdStop, args: [{ dest: "id" }] },
  { name: "resume", help: "start a stopped session again", fn: cmdResume, args: [{ dest: "id" }] },
  { name: "mark", help: "record who a session is waiting on after handling its events", fn: cmdMark, args: [
    { dest: "id" },
    { dest: "waiting_on", help: "owner (or the owner's name), " +
      sorted([...ops.WAITING_VALUES].filter((v) => v !== "owner")).join(", ") },
    { dest: "text", nargs: "+", help: "why" },
  ] },
  { name: "cleanup", help: "stop and archive a finished session; refuses if work looks unlanded", fn: cmdCleanup, args: [
    { dest: "id" },
    { flags: ["--force"], dest: "force", action: "store_true",
      help: "skip the unlanded-work check (only with the owner's OK)" },
  ] },
  { name: "kinds", help: "list session kinds, the skill each runs, and whether it is found", fn: cmdKinds, args: [
    { flags: ["--runtime"], dest: "runtime", hidden: true },
  ] },
  { name: "summary", help: "print the startup summary", fn: cmdSummary, args: [] },
  { name: "chef", help: "show which Claude session is registered as sous chef", fn: cmdChef, args: [
    { flags: ["--take"], dest: "take", action: "store_true",
      help: "make THIS session sous chef, even if a running one holds it" },
  ] },
  { name: "watch", help: "run the watcher (normally started automatically)", fn: cmdWatch, args: [
    { flags: ["--ensure"], dest: "ensure", action: "store_true", group: "mode",
      help: "start it in the background if not running" },
    { flags: ["--once"], dest: "once", action: "store_true", group: "mode", help: "run one cycle and print what it did" },
  ] },
  { name: "report", help: "(inside a session) report an event to sous chef", fn: cmdReport, args: [
    { dest: "state", help: Object.keys(events.SESSION_STATES).join(", ") },
    { dest: "text", nargs: "*" },
    { flags: ["--key"], dest: "key", help: "question key; needs-decision and blocked get one automatically" },
  ] },
  { name: "inbox", help: "(inside a session) read messages from sous chef; `sc inbox ack <n>` after", fn: cmdInbox, args: [
    { dest: "action", nargs: "?", choices: ["ack"] },
    { dest: "seq", nargs: "?", type: "int" },
  ] },
  { name: "hook", help: "(internal) Claude Code hook handlers",
    fn: (args) => hooks.run(args as unknown as hooks.HookArgs), args: [
      { dest: "hook_name", choices: sorted(Object.keys(hooks.HANDLERS)) },
      { flags: ["--session"], dest: "session" },
    ] },
];

export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parse({ prog: "sc", description: "Sous chef: memory and session manager.", commands: COMMANDS }, argv,
      (text) => process.stdout.write(text), (text) => process.stderr.write(text));
  } catch (e) {
    if (e instanceof ArgExit) return e.code;
    throw e;
  }
  const command = COMMANDS.find((c) => c.name === args.command)!;
  try {
    const result = await command.fn(args);
    return typeof result === "number" ? result : 0;
  } catch (e) {
    if (e instanceof SCError) {
      printErr(`sc: ${e.message}`);
      return 1;
    }
    throw e;
  }
}
