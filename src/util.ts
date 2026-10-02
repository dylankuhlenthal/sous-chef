// Small shared helpers: paths, the owner, clock, atomic JSON files.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumps, JSONDecodeError, loads } from "./pyjson.js";
import { exists, floordiv, isFile, isprintable, isspace, isSymlink, parseFloatPy, pathStr, readText, rstrip, strip } from "./py.js";

// Code (kinds, templates, bin) comes from this checkout, the core. The owner's data
// (state, memory, cron jobs, their own kinds and settings) lives in their data folder,
// reached through one link in the core: <core>/my (gitignored; made by `sc setup`).
// SC_TEST_HOME points the data at a temporary directory for tests only. Neither is a
// variable any session is launched with: Claude Code can start a background session
// in a spare process created with an earlier launch's environment, so a per-session
// variable could point at the wrong home.
//
// The core is the folder above dist/, with links resolved (as Python's Path.resolve()).
export const CODE_ROOT: string = fs.realpathSync(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
export const DATA_LINK = path.join(CODE_ROOT, "my");

/** A refusal or failure with a message meant for the caller. */
export class SCError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SCError";
  }
}

/** Why there is no usable data folder behind <core>/my, as the fix to run, or null. */
export function dataProblem(): string | null {
  if (exists(DATA_LINK)) return null;
  if (isSymlink(DATA_LINK)) {
    return `${DATA_LINK} points to ${fs.readlinkSync(DATA_LINK)}, which does not exist; ` +
      `re-point it at your data folder: ln -sfn <data folder> ${DATA_LINK}`;
  }
  return `no data folder: run ${installScript()}`;
}

export function installScript(): string {
  return path.join(CODE_ROOT, "install.sh");
}

/** Why home() would refuse, or null. Never throws. */
export function homeProblem(): string | null {
  return process.env.SC_TEST_HOME ? null : dataProblem();
}

/**
 * The owner's data folder: SC_TEST_HOME in tests, else <core>/my. Refuses (SCError) without one.
 *
 * The path goes through the link and is not resolved, so paths written into briefs
 * stay valid when the data folder moves and the link is re-pointed.
 */
export function home(): string {
  const test = process.env.SC_TEST_HOME;
  if (test) return pathStr(test);
  const problem = dataProblem();
  if (problem) throw new SCError(problem);
  return DATA_LINK;
}

export function stateDir(): string {
  return path.join(home(), "state");
}

export function sessionsDir(): string {
  return path.join(stateDir(), "sessions");
}

export function archiveDir(): string {
  return path.join(stateDir(), "archive");
}

export function memoryDir(): string {
  return path.join(home(), "memory");
}

/** The core kinds, which ship with the code. */
export function kindsDir(): string {
  return path.join(CODE_ROOT, "kinds");
}

/**
 * The user kinds: kinds that belong to the person running sous chef, in their data folder.
 *
 * Looked up before the core's. When a test points the data home at the code folder,
 * this is the same folder as kindsDir(), and kinds.ts then treats it as the core only.
 */
export function userKindsDir(): string {
  return path.join(home(), "kinds");
}

export function templatesDir(): string {
  return path.join(CODE_ROOT, "templates");
}

export function scBin(): string {
  return path.join(CODE_ROOT, "bin", "sc");
}

// --- the owner ---------------------------------------------------------------
// The person this sous chef works for: their name and branch prefix, and the permission
// mode sous chef's own session starts in, in owner.json at the root of the data folder,
// written by `sc setup` or `sc owner set`. Nothing else opens the file; everything reads
// it through owner().

export const NO_OWNER = "no owner set: run sc owner set --name <name> --branch-prefix <prefix>";

// Who a session can wait on (events.WAITING_ON). `owner` is the person sous chef works for.
// The owner's name in lower case stands for `owner`, so it may not be one of the others.
export const WAITING_VALUES = new Set(["owner", "agent", "sc", "external", "nobody"]);

// The permission modes the owner can choose for sous chef's own session (decision 0031).
// A file without the field means the default.
export const CHEF_PERMISSIONS = ["auto", "bypass"] as const;
export type ChefPermissions = typeof CHEF_PERMISSIONS[number];
export const DEFAULT_CHEF_PERMISSIONS: ChefPermissions = "auto";

export interface Owner {
  name: string;
  lower: string;
  branch_prefix: string;
  chef_permissions: ChefPermissions;
  /** False when owner.json has no chef_permissions, so chef_permissions is the default. */
  chef_permissions_chosen: boolean;
}

/** Why this cannot be sous chef's own permission mode, or null. */
export function chefPermissionsProblem(value: unknown): string | null {
  return (CHEF_PERMISSIONS as readonly unknown[]).includes(value) ? null
    : `sous chef's own permission mode must be one of ${CHEF_PERMISSIONS.join(", ")}`;
}

/** Why this name and branch prefix cannot be the owner's, or null. Checked on write and on every read. */
export function ownerProblem(name: unknown, prefix: unknown): string | null {
  if (typeof name !== "string" || !strip(name) || !isprintable(strip(name))) {
    return "the name must be one line of printable text, e.g. Sam";
  }
  if (WAITING_VALUES.has(strip(name).toLowerCase())) {
    return `'${strip(name)}' cannot be the owner's name: sessions waiting on the owner show their name in ` +
      `lower case, and '${strip(name).toLowerCase()}' already means something else there`;
  }
  if (typeof prefix !== "string" || !isprintable(prefix) || [...prefix].some(isspace)) {
    return 'the branch prefix must be printable text without spaces, e.g. sam/ (or "" for none)';
  }
  return null;
}

export function ownerPath(): string {
  return path.join(home(), "owner.json");
}

/**
 * The owner as {name, lower, branch_prefix, chef_permissions}, or null when owner.json does not exist.
 *
 * `lower` is the name in lower case: how the owner shows as a waiting-on value
 * (events.ts). Throws SCError when the file exists but cannot be used.
 */
export function owner(): Owner | null {
  const p = ownerPath();
  let data: unknown;
  try {
    data = readJson(p);
  } catch (e) {
    if (e instanceof JSONDecodeError) {
      throw new SCError(`${p} is not valid JSON (${e.message}); fix it or rewrite it with \`sc owner set\``);
    }
    throw e;
  }
  if (data === null || data === undefined) return null;
  const isObj = typeof data === "object" && !Array.isArray(data);
  const name = isObj ? (data as Record<string, unknown>).name : undefined;
  const prefix = isObj ? (data as Record<string, unknown>).branch_prefix : undefined;
  if (name === undefined || name === null || prefix === undefined || prefix === null) {
    throw new SCError(`${p} needs a name and a branch_prefix; rewrite it with \`sc owner set\``);
  }
  const stored = (data as Record<string, unknown>).chef_permissions;
  const chefPermissions = stored ?? DEFAULT_CHEF_PERMISSIONS;
  const problem = ownerProblem(name, prefix) ?? chefPermissionsProblem(chefPermissions);
  if (problem) throw new SCError(`${p} cannot be used: ${problem}; rewrite it with \`sc owner set\``);
  const n = strip(name as string);
  return { name: n, lower: n.toLowerCase(), branch_prefix: prefix as string,
    chef_permissions: chefPermissions as ChefPermissions, chef_permissions_chosen: stored !== undefined && stored !== null };
}

/** The owner, or a refusal saying how to set one. For commands that cannot run without one. */
export function requireOwner(): Owner {
  const o = owner();
  if (!o) throw new SCError(NO_OWNER);
  return o;
}

/**
 * The owner's name for text a person reads, or `fallback` when none is set or it is unreadable.
 *
 * Only for wording. Never use it to decide anything: Slack trust is the Slack user id
 * alone (slack.ts), and commands that need an owner call requireOwner().
 */
export function ownerName(fallback = "the owner"): string {
  let o: Owner | null;
  try {
    o = owner();
  } catch (e) {
    if (!(e instanceof SCError)) throw e;
    o = null;
  }
  return o ? o.name : fallback;
}

const COMMENT = /<!--[\s\S]*?-->/g;

/** An owner's instructions file with its <!-- comments --> left out, stripped; "" when there is none. */
export function ownerText(p: string): string {
  return isFile(p) ? strip(readText(p).replace(COMMENT, "")) : "";
}

const PLACEHOLDER = /\{\{(\w+)\}\}/gu;

/**
 * Fill {{key}} placeholders in one pass. A placeholder with no value is left as written.
 *
 * One pass, so text that arrives inside a value (a task, which anyone can write) is
 * never filled in itself: a task saying {{owner}} keeps saying {{owner}}.
 */
export function render(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key]! : whole);
}

/** Current epoch seconds. SC_FAKE_NOW lets tests control the clock. */
export function now(): number {
  const fake = process.env.SC_FAKE_NOW;
  if (fake) {
    const v = parseFloatPy(fake);
    if (v === null) throw new Error(`could not convert string to float: '${fake}'`);
    return v;
  }
  return Date.now() / 1000;
}

/** The real clock, ignoring SC_FAKE_NOW (Python's time.time()). */
export function realNow(): number {
  return Date.now() / 1000;
}

export function iso(ts: number): string {
  const d = new Date(Math.floor(ts) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`;
}

export function age(ts: number): string {
  const secs = Math.max(0, Math.trunc(now() - ts));
  if (secs < 90) return `${secs}s`;
  if (secs < 5400) return `${floordiv(secs, 60)}m`;
  if (secs < 172800) return `${floordiv(secs, 3600)}h`;
  return `${floordiv(secs, 86400)}d`;
}

export function slug(text: string, limit = 32): string {
  const s = strip(text.toLowerCase().replace(/[^a-z0-9]+/g, "-"), "-");
  return rstrip(s.slice(0, limit), "-") || "task";
}

/** Read a JSON file: its value, or `dflt` when it does not exist. Invalid JSON throws JSONDecodeError. */
export function readJson<T = unknown>(p: string, dflt: T | null = null): T | null {
  let text: string;
  try {
    text = readText(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return dflt;
    throw e;
  }
  return loads(text) as T;
}

/** Write via a temp file and rename, so readers never see half a file. Keys sorted, indent 2, as Python wrote. */
export function writeJson(p: string, data: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}.tmp`);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, dumps(data, { sortKeys: true, indent: 2 }) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
}

/** Path.mkdir(parents=True, exist_ok=True). */
export function mkdirs(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

/** Wait this many seconds without blocking the event loop. */
export function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds * 1000)));
}

/** A number from an environment variable, as Python's float(os.environ.get(name, default)). */
export function envFloat(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined) return dflt;
  const v = parseFloatPy(raw);
  if (v === null) throw new Error(`could not convert string to float: '${raw}'`);
  return v;
}
