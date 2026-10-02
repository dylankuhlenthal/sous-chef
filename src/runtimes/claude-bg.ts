// Claude Code background sessions (`claude --bg`), reached through Porch used as a library
// (docs/decisions/0026). The runtime name `claude-bg` is what records and chef.json store.
//
// What goes through Porch (the package in package.json, pinned to a tag, docs/decisions/0025):
// - listing and status: `porch.list(harness, {all: true})` and `porch.observe`, which read
//   `claude agents --json`, Claude Code's job files and Porch's own session records. How an
//   observation becomes sous chef's Status is `statusOf` below, and the table in
//   docs/domains/sessions.md ("The Claude runtime").
// - waking: `porch.deliver(..., {from: "sous chef"})`. Porch puts `[from sous chef] ` before
//   every message, so a wake-up arrives as `[from sous chef] sous chef: ...`.
// - launching: `porch.launchPlan`, which merges Porch's six hooks (and
//   `crossSessionInbound: accept`) into the one `--settings` sous chef passes. Sous chef
//   then runs the plan itself, to read the short id Claude Code prints.
// - turn times, for sessions launched with Porch's hooks (`detail.hasInsidePart`); older
//   sessions still write turns.json through `sc hook worker-prompt`/`worker-stop`.
// - `sc report` setting the session's Porch self status (`reportStatus`).
//
// What stays in sous chef, run directly: resume (`claude --bg --resume <session id>` with no
// other flags: with any flag Claude Code starts a copy under a new id, so resume never goes
// through launchPlan), stop (`claude stop <short id>`), attach, and reading the short id from
// `backgrounded · <short id> ·`. The skill lookup is claude-skills.ts.
//
// Sous chef never sets PORCH_HOME: a worker's `sc report` runs in the worker's environment,
// which can be stale (docs/decisions/0007), so only Porch's default folder (~/.porch) is
// certain to be the one its hooks write to.

import {
  type HarnessIO, notRunning, type Observation, Porch, PorchError, type PorchOptions, realIO, runLaunchPlan,
  type SelfStatus, signalExitCode,
} from "@dylankuhlenthal/porch";
import { Dict, or, truthy } from "../py.js";
import { run, RunResult } from "../proc.js";
import { SCError, sleep } from "../util.js";
import { skillAvailable, skillPlaces } from "./claude-skills.js";
import { Activity, Listing, Runtime, Status, WakeError } from "./types.js";

export const NAME = "claude-bg";
/** The label Porch puts before every wake-up: `[from sous chef] `. */
export const WAKE_FROM = "sous chef";

const BACKGROUNDED = /backgrounded\s+·\s+([0-9a-f]+)\s+·/;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** The short id from `claude --bg` output. It may carry terminal colour codes. */
export function parseShortId(output: string): string | null {
  const m = BACKGROUNDED.exec(output.replace(ANSI, ""));
  return m ? m[1]! : null;
}

function tail(r: RunResult): string {
  return (r.stdout + r.stderr).replace(ANSI, "").trim().slice(-400);
}

// sc's permission values (runtimes.PERMISSIONS) as Claude Code's --permission-mode.
// A record from before permissions were recorded has none, and ran in auto mode.
export const PERMISSION_MODES: Record<string, string> = {
  "auto": "auto", "accept-edits": "acceptEdits", "bypass": "bypassPermissions", "ask": "manual",
};

export function permissionMode(rec: Dict): string {
  const value = String(or(rec.permissions, "auto"));
  if (!Object.hasOwn(PERMISSION_MODES, value)) {
    throw new SCError(`the Claude runtime has no permission mode for '${value}' ` +
      `(known: ${Object.keys(PERMISSION_MODES).join(", ")})`);
  }
  return PERMISSION_MODES[value]!;
}

// The hook commands Porch's own hooks replace for a session launched through Porch: they
// record turn times in turns.json, which Porch's record now holds. The commands stay in sc
// for sessions launched before the switch-over: Claude Code keeps a session's launch
// settings across resume, so such a session calls them for the rest of its life.
const OLD_TURN_HOOKS = [" hook worker-prompt ", " hook worker-stop "];

/** `settings` without the UserPromptSubmit and Stop entries that run `sc hook worker-prompt`/`worker-stop`. */
export function withoutOldTurnHooks(settings: Dict): Dict {
  const hooks = { ...(or(settings.hooks, {}) as Record<string, unknown[]>) };
  for (const event of ["UserPromptSubmit", "Stop"]) {
    if (!Array.isArray(hooks[event])) continue;
    const kept = hooks[event].filter((entry) => !(((entry as Dict).hooks as Dict[] | undefined) ?? [])
      .some((h) => typeof h.command === "string" && OLD_TURN_HOOKS.some((c) => (h.command as string).includes(c))));
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  return { ...settings, hooks };
}

/** The arguments sous chef gives `porch launch claude` for a worker (Porch adds its hooks to the one --settings). */
export function launchArgs(rec: Dict, prompt: string, settings: Dict): string[] {
  const args = ["--bg", "-n", String(rec.handle_name), "--permission-mode", permissionMode(rec),
    "--settings", JSON.stringify(withoutOldTurnHooks(settings))];
  if (truthy(rec.model)) args.push("--model", String(rec.model));
  if (truthy(rec.effort)) args.push("--effort", String(rec.effort));
  args.push(prompt);
  return args;
}

/** The arguments for sous chef's own session: no settings of sous chef's, so Porch's are the only launch settings. */
export function namedArgs(name: string, prompt: string, permissions: string): string[] {
  return ["--bg", "-n", name, "--permission-mode", permissionMode({ permissions }), ...(prompt ? [prompt] : [])];
}

// `sc report` states as Porch self statuses. note and resolved change nothing.
export const SELF_STATUS: Record<string, SelfStatus | null> = {
  "needs-decision": "needs-input", "waiting": "needs-input",
  "blocked": "blocked", "paused": "blocked",
  "working": "working",
  "done": "done", "nothing-new": "done",
  "failed": "failed",
  "note": null, "resolved": null,
};

/** An ISO 8601 time as epoch seconds, or null. */
function seconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms / 1000;
}

// Claude Code's subagent kind, in sc's words. Any other kind is passed on as it is.
const RUNNING_KINDS: Record<string, string> = { agent: "subagent" };

/** Porch's `detail.activity` in the shape runtimes/types.ts promises, or null. */
function activityOf(value: unknown): Activity | null {
  if (typeof value !== "object" || value === null) return null;
  const a = value as Dict;
  const running = (Array.isArray(a.running) ? a.running : []).map((r: Dict) => ({
    kind: Object.hasOwn(RUNNING_KINDS, String(r.kind)) ? RUNNING_KINDS[String(r.kind)]! : String(r.kind),
    label: String(r.label),
    since: seconds(r.since),
  }));
  return { detail: typeof a.detail === "string" ? a.detail : null,
    in_flight: typeof a.inFlight === "number" ? a.inFlight : null, running };
}

/** Who the watcher's `gone` event says reported a stopped session (Status.stopped.source). */
const SOURCE = "Porch";

const NOT_FOUND: Status = { alive: false, busy: null, pid: null, prompt: null, activity: null,
  stopped: { source: SOURCE, status: "not found", reason: null } };

/**
 * A Porch observation as sous chef's Status (null: Porch does not know the session).
 *
 * Alive is Porch's own rule (`notRunning`): `ended` and `gone` are not running, whatever
 * ended them. `ended` never means "sous chef stopped it": only rec.stopped_by_sc says that.
 * A session held at a prompt is busy, as the runtime contract says; `starting` and
 * `unknown` give busy null, which no caller treats as idle.
 */
export function statusOf(obs: Observation | null | undefined): Status {
  if (!obs) return { ...NOT_FOUND };
  const detail = (obs.detail ?? {}) as Dict;
  const turns = detail.hasInsidePart === true
    ? { last_prompt_at: seconds(detail.lastTurnStart), last_stop_at: seconds(detail.lastTurnEnd) } : undefined;
  if (notRunning(obs.status)) {
    return { alive: false, busy: null, pid: null, prompt: null, activity: null, ...(turns ? { turns } : {}),
      stopped: { source: SOURCE, status: obs.status, reason: obs.endReason } };
  }
  let prompt: string | null = null;
  if (obs.status === "waiting-on-prompt") {
    prompt = typeof detail.prompt === "string" && detail.prompt ? detail.prompt : "a dialog";
    if (typeof detail.promptNeeds === "string" && detail.promptNeeds) prompt = `${prompt} (${detail.promptNeeds})`;
  }
  const busy = obs.status === "busy" || obs.status === "waiting-on-prompt" ? true : obs.status === "idle" ? false : null;
  return { alive: true, busy, pid: detail.pid ?? null, prompt, activity: activityOf(detail.activity),
    ...(turns ? { turns } : {}) };
}

/** The listing row for an observation: what code outside the runtime reads, plus the observation. */
function rowOf(obs: Observation): Dict {
  const detail = (obs.detail ?? {}) as Dict;
  const listed = ((obs.raw ?? {}) as Dict).listing as Dict | null | undefined;
  return { id: detail.shortId ?? null, sessionId: obs.session, name: detail.name ?? null,
    kind: listed && typeof listed.kind === "string" ? listed.kind : null, pid: detail.pid ?? null,
    alive: !notRunning(obs.status), obs };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface ClaudeRuntimeOptions {
  /** Porch's harness name. Tests use "fake" with Porch's fake adapter. */
  harness?: string;
  /** Passed to `new Porch` (tests: a temporary PORCH_HOME, canned io, the fake adapter). */
  porch?: PorchOptions;
  /** How to wait between polls (tests make it instant). */
  wait?: (seconds: number) => Promise<void>;
}

export function createClaudeRuntime(options: ClaudeRuntimeOptions = {}): Runtime {
  const harness = options.harness ?? "claude";
  const wait = options.wait ?? sleep;
  // Porch reads a missing `claude` as "no session is running", which would show every
  // recorded session as stopped. Its io is watched for that one answer, so sous chef can
  // refuse instead, as it did when it ran `claude agents` itself.
  let claudeMissing = false;
  const baseIO: HarnessIO = options.porch?.io ?? realIO;
  const io: HarnessIO = {
    async run(cmd, args, opts) {
      const r = await baseIO.run(cmd, args, opts);
      if (args[0] === "agents" && r.code === null && /ENOENT/.test(r.stderr)) claudeMissing = true;
      return r;
    },
    readFile: (file) => baseIO.readFile(file),
  };
  let porchInstance: Porch | null = null;
  // One Porch per process, made on first use.
  const porch = (): Porch => (porchInstance ??= new Porch({ ...options.porch, io }));

  /** Ask Porch something; refuses when Porch found no `claude` to ask, whatever it answered. */
  async function asked<T>(fn: () => Promise<T>): Promise<T> {
    claudeMissing = false;
    const missing = () => new SCError("'claude' is not on PATH");
    let out: T;
    try {
      out = await fn();
    } catch (e) {
      throw claudeMissing ? missing() : e;
    }
    if (claudeMissing) throw missing();
    return out;
  }

  /** Porch's observation of one session, or null when Porch does not know it. */
  async function observe(id: string): Promise<Observation | null> {
    try {
      return await asked(() => porch().observe(id, harness));
    } catch (e) {
      if (e instanceof PorchError && e.code === "not-found") return null;
      if (e instanceof SCError) throw e;
      throw new SCError(message(e));
    }
  }

  function lookup(rows: Listing, ...keys: unknown[]): Observation | null {
    for (const key of keys) {
      if (typeof key === "string" && key && Object.hasOwn(rows, key)) return rows[key]!.obs as Observation;
    }
    return null;
  }

  /**
   * The observation of the session a record names, for both `status` and `wake`, so the two
   * always agree (null: Porch knows neither id).
   *
   * By session id first, then by short id when that session is not running. After `/clear`
   * Claude Code goes on in the same process under a new session id, and Porch shows the old
   * id as ended (reason `clear`) while the short id is still running, as the Python runtime
   * read it. A stopped session with nothing running under its short id stays stopped.
   */
  async function resolve(rec: Dict, rows: Listing | null | undefined): Promise<Observation | null> {
    const handle = or(rec.handle, {}) as Dict;
    const sid = typeof handle.session_id === "string" && handle.session_id ? handle.session_id : null;
    const short = typeof handle.short_id === "string" && handle.short_id ? handle.short_id : null;
    const running = (obs: Observation | null) => obs !== null && !notRunning(obs.status);
    if (rows) {
      const bySid = lookup(rows, sid);
      const byShort = lookup(rows, short);
      return running(bySid) || !running(byShort) ? (bySid ?? byShort) : byShort;
    }
    const bySid = sid ? await observe(sid) : null;
    if (running(bySid) || !short) return bySid;
    const byShort = await observe(short);
    return running(byShort) ? byShort : (bySid ?? byShort);
  }

  /**
   * Run Claude Code (`command` is the launch plan's for a launch). `shown` names the
   * command in a timeout message: a launch's arguments start with the whole settings JSON.
   */
  async function claude(args: string[], cwd: string | undefined, env: NodeJS.ProcessEnv, timeout = 90,
                        command = "claude", shown = args.slice(0, 2).join(" ")): Promise<RunResult> {
    const r = await run(command, args, { cwd, env, timeout });
    if (r.error) throw new SCError("'claude' is not on PATH");
    if (r.timedOut) throw new SCError(`timed out running: claude ${shown} ...`);
    return r;
  }

  async function plan(args: string[]) {
    try {
      return await porch().launchPlan(harness, args);
    } catch (e) {
      throw new SCError(`could not prepare the launch: ${message(e)}`);
    }
  }

  /** Deliver through Porch; returns null when delivered, else [not-running?, reason]. */
  async function deliver(id: string, text: string): Promise<[boolean, string] | null> {
    let r;
    try {
      r = await asked(() => porch().deliver(id, text, { from: WAKE_FROM, harness }));
    } catch (e) {
      throw new WakeError(message(e));
    }
    if (r.result === "delivered") return null;
    return [r.result === "not-running", r.reason ?? r.result];
  }

  const runtime: Runtime = {
    NAME,

    async listing() {
      let result;
      try {
        result = await asked(() => porch().list(harness, { all: true }));
      } catch (e) {
        if (e instanceof SCError) throw e;
        throw new SCError(message(e));
      }
      // A listing that failed (not a single unreadable record) must not read as "nothing
      // is running": the watcher skips its checks for the cycle instead.
      const failed = result.errors.find((e) => e.harness === harness && !e.message.startsWith("unreadable session record"));
      if (failed) throw new SCError(failed.message);
      const rows: Listing = {};
      for (const obs of result.sessions) {
        const row = rowOf(obs);
        // A short id is keyed once: a running session's row is never replaced by a stopped
        // one that Porch remembers under the same short id.
        const short = row.id;
        if (typeof short === "string" && short && !(Object.hasOwn(rows, short) && rows[short]!.alive && !row.alive)) {
          rows[short] = row;
        }
        rows[obs.session] = row;
      }
      return rows;
    },

    async status(rec, rows) {
      return statusOf(await resolve(rec, rows));
    },

    async launch(rec, prompt, env, settings) {
      const p = await plan(launchArgs(rec, prompt, settings));
      const out = await claude(p.args, rec.cwd as string, { ...process.env, ...env }, 90, p.command, "--bg -n");
      let short = parseShortId(out.stdout + out.stderr);
      if (!short) {
        // The output was not understood, but the session may still have started:
        // look for it by its unique name before reporting a failure.
        const named = Object.values(await this.listing()).find((r) => r.name === rec.handle_name && truthy(r.id));
        if (!named) throw new SCError(`claude --bg did not start the session (exit ${out.code}): ${tail(out)}`);
        short = named.id as string;
      }
      // The full session id appears in the listing shortly after launch. Only a listed
      // session counts: Porch also finds a stopped session it remembers by short id.
      for (let i = 0; i < 20; i++) {
        const obs = await observe(short);
        if (obs && ((obs.raw ?? {}) as Dict).listing) return { short_id: short, session_id: obs.session };
        await wait(1);
      }
      return { short_id: short, session_id: null };
    },

    async resume(rec, env) {
      // `settings` is unused: the session kept its own, and so did its permission mode.
      const handle = or(rec.handle, {}) as Dict;
      if (!truthy(handle.session_id)) {
        throw new SCError(`${rec.id as string} has no recorded Claude session id, so it cannot be resumed`);
      }
      // No flags besides --resume: with flags, Claude Code starts a copy under a new id.
      const out = await claude(["--bg", "--resume", handle.session_id as string], rec.cwd as string,
        { ...process.env, ...env });
      const short = parseShortId(out.stdout + out.stderr);
      if (!short) throw new SCError(`resume failed: ${tail(out)}`);
      for (let i = 0; i < 15; i++) {
        if ((await this.status(rec)).alive) return;
        await wait(1);
      }
      if (short !== handle.short_id) await claude(["stop", short], undefined, process.env, 60);
      throw new SCError(`resume did not bring back ${rec.id as string} (Claude Code started ${short} instead, now stopped)`);
    },

    async stop(rec) {
      const short = (or(rec.handle, {}) as Dict).short_id;
      if (!truthy(short)) throw new SCError(`${rec.id as string} has no runtime handle`);
      for (let attempt = 0; attempt < 2; attempt++) {
        await claude(["stop", short as string], undefined, process.env, 60);
        for (let i = 0; i < 10; i++) {
          if (!(await this.status(rec)).alive) return;
          await wait(1);
        }
      }
      throw new SCError(`${rec.id as string} is still running after two stop attempts`);
    },

    async wake(rec, text, rows) {
      const handle = or(rec.handle, {}) as Dict;
      const recorded = or(handle.session_id, handle.short_id);
      if (typeof recorded !== "string" || !recorded) {
        throw new WakeError(`${rec.id as string} is not running (no runtime handle)`);
      }
      // Deliver to the session `status` resolves to: after `/clear` that is the new session
      // id running under the same short id, not the recorded one, which Porch shows as ended.
      // A session that is not running keeps the recorded id, so the reason Porch gives is
      // unchanged. Porch's deliver reads `claude agents` twice on its own, so without the
      // caller's rows the recorded id is tried first and a listing is read only when Porch
      // says it is not running (rare: after `/clear`, or a session that really stopped).
      const running = (obs: Observation | null) => (obs && !notRunning(obs.status) ? obs.session : null);
      const lookUp = async (listing: Listing | null | undefined) => {
        try {
          return running(await resolve(rec, listing ?? await this.listing()));
        } catch (e) {
          throw new WakeError(message(e));
        }
      };
      const fail = ([stopped, reason]: [boolean, string]) =>
        new WakeError(stopped ? `${rec.id as string} is not running (${reason})` : reason);
      if (rows) {
        const failed = await deliver((await lookUp(rows)) ?? recorded, text);
        if (failed !== null) throw fail(failed);
        return;
      }
      const failed = await deliver(recorded, text);
      if (failed === null) return;
      if (!failed[0]) throw fail(failed);
      const other = await lookUp(null);
      if (other === null || other === recorded) throw fail(failed);
      const again = await deliver(other, text);
      if (again !== null) throw fail(again);
    },

    async statusSessionId(sessionId, rows) {
      if (rows) return statusOf(lookup(rows, sessionId));
      return statusOf(await observe(sessionId));
    },

    async wakeSessionId(sessionId, text) {
      const failed = await deliver(sessionId, text);
      if (failed === null) return;
      const [stopped, reason] = failed;
      throw new WakeError(stopped ? `Claude session ${sessionId.slice(0, 8)} is not running` : reason);
    },

    async reportStatus(_rec, state, text) {
      const mapped = Object.hasOwn(SELF_STATUS, state) ? SELF_STATUS[state] : null;
      if (!mapped) return;
      try {
        await porch().statusSet(mapped, text);
      } catch (e) {
        throw new Error(`porch status not updated: ${message(e)}`);
      }
    },

    async startNamed(name, prompt, cwd, env, permissions) {
      const p = await plan(namedArgs(name, prompt, permissions));
      const out = await claude(p.args, cwd, env, 90, p.command, "--bg -n");
      const short = parseShortId(out.stdout + out.stderr);
      if (!short) throw new SCError(`could not start ${name}: ${tail(out)}`);
      return short;
    },

    async resumeSessionId(sessionId, cwd, env) {
      // No flags besides --resume: with flags, Claude Code starts a copy under a new id.
      const out = await claude(["--bg", "--resume", sessionId], cwd, env);
      const short = parseShortId(out.stdout + out.stderr);
      if (!short) return null;
      for (let i = 0; i < 15; i++) {
        const rows = await this.listing();
        const row = Object.hasOwn(rows, sessionId) ? rows[sessionId] : undefined;
        if (row && truthy(row.pid)) return (truthy(row.id) ? row.id : short) as string;
        await wait(1);
      }
      await this.stopShort(short); // a copy, not the session asked for
      return null;
    },

    async stopShort(shortId) {
      await claude(["stop", shortId], undefined, process.env, 60);
    },

    async attachExec(shortId, cwd, env) {
      process.chdir(cwd);
      // A child on this terminal, with Porch's signal handling (Node has no execve).
      let outcome;
      try {
        outcome = await runLaunchPlan({ command: "claude", args: ["attach", shortId] }, env);
      } catch (e) {
        throw new SCError(message(e));
      }
      return outcome.signal ? signalExitCode(outcome.signal) : (outcome.code ?? 1);
    },

    attachCommand(rec) {
      const short = or((or(rec.handle, {}) as Dict).short_id, "<unknown>");
      return `claude attach ${String(short)}`;
    },

    async skillAvailable(name, cwd) {
      return skillAvailable(name, cwd);
    },

    skillPlaces(cwd) {
      return skillPlaces(cwd);
    },
  };
  return runtime;
}

export const claudeBg: Runtime = createClaudeRuntime();
