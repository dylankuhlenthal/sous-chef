// The runtime interface: how a session is actually run (docs/patterns/adding-a-runtime.md).
//
// Everything else in sous chef talks to a session only through the runtime named in its
// record, so adding another agent tool means adding a module in src/runtimes/ that
// provides this interface and listing it in src/runtimes/index.ts.

import type { Dict } from "../py.js";

/** A failed wake-up. Its message says why, since callers print it. */
export class WakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WakeError";
  }
}

// What a session may do without asking a person. Chosen per spawn (`sc spawn --permissions`).
export const PERMISSIONS: Record<string, string> = {
  "auto": "a classifier decides each action; anything it judges risky waits for a person",
  "accept-edits": "file edits go ahead; other actions wait for a person",
  "bypass": "everything goes ahead; nothing ever asks",
  "ask": "every action that needs permission waits for a person",
};
export const DEFAULT_PERMISSIONS = "auto";

/** One thing a session has running, for display only. */
export interface Running {
  kind: string;
  label: string;
  since: number | null;
}

/**
 * What the session says it is doing: its own one-line summary, how many subagents and
 * background commands it started are still running (null: cannot tell), and which.
 */
export interface Activity {
  detail: string | null;
  in_flight: number | null;
  running: Running[];
}

/**
 * A session's runtime status. `busy` null means the runtime cannot tell; no caller may
 * treat that as idle. `prompt` is set while the session is held mid-turn by something
 * only a person can answer (for Claude, a permission prompt or another dialog), saying
 * what; a session held there counts as busy. `activity` is null when the runtime cannot tell.
 */
export interface Status {
  alive: boolean;
  busy: boolean | null;
  pid: unknown;
  prompt: string | null;
  activity?: Activity | Dict | null;
  /**
   * The session's turn times in epoch seconds, only when the runtime keeps its own turn
   * record for this session. Without it, callers use sc's turns.json (records.turns).
   */
  turns?: Turns;
  /** For a session that is not running, what the runtime says about why, when it knows. */
  stopped?: Stopped;
}

/** When the session's last turn started and ended (epoch seconds; null: not yet). */
export interface Turns {
  last_prompt_at: number | null;
  last_stop_at: number | null;
}

/**
 * How the runtime sees a stopped session: who says so (the name the watcher's `gone` event
 * gives, for example "Porch"), its status word, and the reason it gives (null: none).
 */
export interface Stopped {
  source: string;
  status: string;
  reason: string | null;
}

/**
 * One snapshot of all sessions, keyed by the runtime's own ids, for batching. The rows are
 * the runtime's own; code outside the runtime reads only `pid`, `alive`, `kind`, `id` and
 * `name` from them (chef.liveIncumbent, cli's `sc chef`, souschef.decide).
 */
export type Listing = Record<string, Dict>;

export interface Runtime {
  /** The value stored in record.runtime. */
  readonly NAME: string;
  /** Start the session; return a handle dict. */
  launch(rec: Dict, prompt: string, env: Record<string, string>, settings: Dict): Promise<Dict>;
  /** Start a stopped session again. It keeps its permission mode. */
  resume(rec: Dict, env: Record<string, string>, settings: Dict): Promise<void>;
  /** Stop it, verifying it stopped. */
  stop(rec: Dict): Promise<void>;
  status(rec: Dict, rows?: Listing | null): Promise<Status>;
  listing(): Promise<Listing>;
  /** Deliver a short wake-up line; throw WakeError whose message says why. */
  wake(rec: Dict, text: string, rows?: Listing | null): Promise<void>;
  /** Wake any session by the tool's own session id (only if sous chef itself runs on this runtime). */
  wakeSessionId(sessionId: string, text: string, rows?: Listing | null): Promise<void>;
  /** `status` for any session by the tool's own session id (only if sous chef itself runs on this runtime). */
  statusSessionId(sessionId: string, rows?: Listing | null): Promise<Status>;
  /** Start sous chef's own session; return its short id. Used by `souschef`. */
  startNamed(name: string, prompt: string, cwd: string, env: Record<string, string>, permissions: string):
    Promise<string>;
  /** Continue it by the tool's own session id; return its short id, or null if it did not come back. */
  resumeSessionId(sessionId: string, cwd: string, env: Record<string, string>): Promise<string | null>;
  /** Stop it. */
  stopShort(shortId: string): Promise<void>;
  /** Attach this terminal to it; returns the exit code to leave with. */
  attachExec(shortId: string, cwd: string, env: Record<string, string>): Promise<number>;
  /** The command the owner runs to open the session. */
  attachCommand(rec: Dict): string;
  /**
   * Optional: tell the tool the state the session just reported (`sc report`), for a
   * runtime whose tool keeps such a status. Called after the event is written and sous
   * chef is woken. A failure throws an Error whose message is the whole line to print, in
   * the runtime's own words (`sc report` prints it on stderr and changes nothing else).
   */
  reportStatus?(rec: Dict, state: string, text: string): Promise<void>;
  /**
   * Whether a session in cwd can run the skill `name`: true, false, or null when the
   * runtime cannot tell. cwd null means no project (`sc kinds`). Only false refuses a spawn.
   */
  skillAvailable(name: string, cwd: string | null): Promise<boolean | null>;
  /** Where skillAvailable looks, for the refusal message. */
  skillPlaces(cwd: string | null): string[];
}
