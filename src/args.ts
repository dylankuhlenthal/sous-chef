// A small command-line parser written for sc and souschef: what Python's argparse did
// for them, without a dependency (docs/decisions/0022 lists the runtime dependencies).
//
// It does what sc relies on: subcommands; positionals before, after or between options
// (argparse's intermixed parsing); --opt value and --opt=value; unique prefixes of long
// options; store_true, --git/--no-git pairs; int and float values; choices; nargs ?, *
// and +; required options; mutually exclusive groups; hidden options; "-" as a
// positional; -h/--help at both levels. Errors print the usage and
// "<prog>: error: <message>" to stderr and exit with 2, in argparse's words. Help keeps
// every description and help string word for word; its layout is argparse's, near enough.

import { parseFloatPy, parseIntPy, repr } from "./py.js";

export interface Arg {
  /** Option strings ("--kind", "-n"). Without them the argument is a positional. */
  flags?: string[];
  dest: string;
  help?: string;
  /** Left out of the usage and the help (argparse.SUPPRESS). */
  hidden?: boolean;
  metavar?: string;
  required?: boolean;
  choices?: string[];
  type?: "int" | "float";
  action?: "store" | "store_true" | "append" | "boolean_optional";
  /** Positionals only. */
  nargs?: "?" | "*" | "+";
  default?: unknown;
  /** Arguments sharing a group name are mutually exclusive. */
  group?: string;
}

export interface Command {
  name: string;
  help?: string;
  args: Arg[];
}

export interface ParserSpec {
  prog: string;
  description?: string;
  /** Top-level arguments (souschef), or none when there are commands (sc). */
  args?: Arg[];
  commands?: Command[];
}

export type Parsed = Record<string, unknown> & { command?: string };

/** The parser printed help (exit 0) or an error (exit 2). The caller exits with `code`. */
export class ArgExit extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

const HELP: Arg = { flags: ["-h", "--help"], dest: "help", help: "show this help message and exit" };
const NEGATIVE = /^-\d+$|^-\d*\.\d+$/;

function isOption(a: Arg): boolean {
  return Boolean(a.flags && a.flags.length);
}

function defaultMetavar(a: Arg): string {
  if (a.metavar) return a.metavar;
  if (a.choices) return `{${a.choices.join(",")}}`;
  return isOption(a) ? a.dest.toUpperCase() : a.dest;
}

function width(): number {
  const cols = Number(process.env.COLUMNS) || 80;
  return Math.max(cols - 2, 11);
}

function wrap(text: string, w: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    if (cur && cur.length + 1 + word.length > w) {
      lines.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

// --- usage and help -------------------------------------------------------------

function usagePart(a: Arg, args: Arg[], done: Set<Arg>): string | null {
  if (a.hidden || done.has(a)) return null;
  if (a.group) {
    const members = args.filter((b) => b.group === a.group && !b.hidden);
    members.forEach((b) => done.add(b));
    return `[${members.map((b) => optionUsage(b)).join(" | ")}]`;
  }
  done.add(a);
  if (isOption(a)) {
    const u = optionUsage(a);
    return a.required ? u : `[${u}]`;
  }
  const m = defaultMetavar(a);
  if (a.nargs === "?") return `[${m}]`;
  if (a.nargs === "*") return `[${m} ...]`;
  if (a.nargs === "+") return `${m} [${m} ...]`;
  return m;
}

function optionUsage(a: Arg): string {
  const flag = a.flags![0]!;
  if (a.action === "store_true") return flag;
  if (a.action === "boolean_optional") return `${flag} | --no-${flag.slice(2)}`;
  return `${flag} ${defaultMetavar(a)}`;
}

function usage(prog: string, args: Arg[], commands?: Command[]): string {
  const done = new Set<Arg>();
  const opts = [HELP, ...args.filter(isOption)].map((a) => a === HELP ? "[-h]" : usagePart(a, args, done))
    .filter((x): x is string => x !== null);
  const pos = args.filter((a) => !isOption(a)).map((a) => usagePart(a, args, done))
    .filter((x): x is string => x !== null);
  if (commands) pos.push(`{${commands.map((c) => c.name).join(",")}}`, "...");
  const head = `usage: ${prog} `;
  const parts = [...opts, ...pos];
  const w = width();
  if (head.length + parts.join(" ").length <= w) return head + parts.join(" ");
  const indent = " ".repeat(head.length);
  const lines: string[] = [];
  let cur = "";
  for (const part of parts) {
    if (cur && head.length + cur.length + 1 + part.length > w) {
      lines.push(cur);
      cur = part;
    } else {
      cur = cur ? `${cur} ${part}` : part;
    }
  }
  if (cur) lines.push(cur);
  return head + lines.join("\n" + indent);
}

function invocation(a: Arg): string {
  if (!isOption(a)) return defaultMetavar(a);
  if (a.action === "store_true" || a === HELP) return a.flags!.join(", ");
  if (a.action === "boolean_optional") return `${a.flags![0]}, --no-${a.flags![0]!.slice(2)}`;
  const m = defaultMetavar(a);
  return a.flags!.map((f) => `${f} ${m}`).join(", ");
}

function helpText(spec: { prog: string; description?: string }, args: Arg[], commands?: Command[]): string {
  const w = width();
  const rows: [string, string | undefined, number][] = [];
  const positionals = args.filter((a) => !isOption(a) && !a.hidden);
  for (const a of positionals) rows.push([invocation(a), a.help, 2]);
  if (commands) {
    rows.push([`{${commands.map((c) => c.name).join(",")}}`, undefined, 2]);
    for (const c of commands) rows.push([c.name, c.help, 4]);
  }
  const options = [HELP, ...args.filter((a) => isOption(a) && !a.hidden)];
  const optRows: [string, string | undefined, number][] = options.map((a) => [invocation(a), a.help, 2]);
  const maxLen = Math.max(...[...rows, ...optRows].map(([inv, , ind]) => inv.length + ind));
  const helpPos = Math.min(maxLen + 2, 24);
  const fmt = ([inv, help, ind]: [string, string | undefined, number]) => {
    const pad = " ".repeat(ind);
    if (help === undefined) return pad + inv;
    const lines = wrap(help, Math.max(w - helpPos, 11));
    const first = inv.length + ind + 2 <= helpPos ? (pad + inv).padEnd(helpPos) + lines[0]
      : pad + inv + "\n" + " ".repeat(helpPos) + lines[0];
    return [first, ...lines.slice(1).map((l) => " ".repeat(helpPos) + l)].join("\n");
  };
  const out = [usage(spec.prog, args, commands)];
  if (spec.description) out.push(wrap(spec.description, w).join("\n"));
  if (rows.length) out.push("positional arguments:\n" + rows.map(fmt).join("\n"));
  out.push("options:\n" + optRows.map(fmt).join("\n"));
  return out.join("\n\n") + "\n";
}

// --- parsing ----------------------------------------------------------------------

class ParseError extends Error {}

function argName(a: Arg): string {
  if (isOption(a)) return a.flags!.join("/");
  return a.metavar ?? (a.choices ? `{${a.choices.join(",")}}` : a.dest);
}

function convert(a: Arg, value: string): unknown {
  let v: unknown = value;
  if (a.type === "int") {
    v = parseIntPy(value);
    if (v === null) throw new ParseError(`argument ${argName(a)}: invalid int value: ${repr(value)}`);
  } else if (a.type === "float") {
    v = parseFloatPy(value);
    if (v === null) throw new ParseError(`argument ${argName(a)}: invalid float value: ${repr(value)}`);
  }
  if (a.choices && !a.choices.includes(value)) {
    throw new ParseError(`argument ${argName(a)}: invalid choice: ${repr(value)} ` +
      `(choose from ${a.choices.map((c) => repr(c)).join(", ")})`);
  }
  return v;
}

function looksLikeOption(token: string, flags: Map<string, Arg>): boolean {
  if (!token.startsWith("-") || token === "-") return false;
  if (flags.has(token) || flags.has(token.split("=")[0]!)) return true;
  if (NEGATIVE.test(token)) return false;
  if (token.includes(" ")) return false;
  return true;
}

function minArgs(a: Arg): number {
  return a.nargs === "?" || a.nargs === "*" ? 0 : 1;
}

function maxArgs(a: Arg): number {
  return a.nargs === "*" || a.nargs === "+" ? Infinity : 1;
}

function parseArgs(args: Arg[], argv: string[], out: (s: string) => void,
                   spec: { prog: string; description?: string }): Parsed {
  const options = args.filter(isOption);
  const positionals = args.filter((a) => !isOption(a));
  const flags = new Map<string, Arg>();
  for (const a of [HELP, ...options]) {
    for (const f of a.flags!) flags.set(f, a);
    if (a.action === "boolean_optional") flags.set(`--no-${a.flags![0]!.slice(2)}`, a);
  }
  const result: Parsed = {};
  for (const a of args) {
    if (isOption(a)) result[a.dest] = a.action === "store_true" ? (a.default ?? false) : (a.default ?? null);
  }
  const seen = new Set<Arg>();
  const groupSeen = new Map<string, Arg>();
  const strings: string[] = [];
  const unknown: string[] = [];

  const lookup = (name: string): [Arg | null, string] => {
    const exact = flags.get(name);
    if (exact) return [exact, name];
    if (name.startsWith("--")) {
      const matches = [...flags.keys()].filter((f) => f.startsWith("--") && f.startsWith(name));
      if (matches.length === 1) return [flags.get(matches[0]!)!, matches[0]!];
      if (matches.length > 1) {
        throw new ParseError(`ambiguous option: ${name} could match ${matches.join(", ")}`);
      }
    }
    return [null, name];
  };

  let i = 0;
  let rest = false;
  while (i < argv.length) {
    const token = argv[i]!;
    i++;
    if (rest) {
      strings.push(token);
      continue;
    }
    if (token === "--") {
      rest = true;
      continue;
    }
    if (!looksLikeOption(token, flags)) {
      strings.push(token);
      continue;
    }
    let name = token;
    let explicit: string | null = null;
    if (token.includes("=") && (token.startsWith("--") || flags.has(token.slice(0, token.indexOf("="))))) {
      name = token.slice(0, token.indexOf("="));
      explicit = token.slice(token.indexOf("=") + 1);
    } else if (!token.startsWith("--") && token.length > 2 && !flags.has(token)) {
      name = token.slice(0, 2);
      explicit = token.slice(2);
    }
    const [a, flag] = lookup(name);
    if (!a) {
      unknown.push(token);
      continue;
    }
    if (a === HELP) {
      out(helpText(spec, args));
      throw new ArgExit(0);
    }
    if (a.group) {
      const other = groupSeen.get(a.group);
      if (other && other !== a) {
        throw new ParseError(`argument ${argName(a)}: not allowed with argument ${argName(other)}`);
      }
      groupSeen.set(a.group, a);
    }
    seen.add(a);
    if (a.action === "store_true" || a.action === "boolean_optional") {
      if (explicit !== null) {
        throw new ParseError(`argument ${argName(a)}: ignored explicit argument ${repr(explicit)}`);
      }
      result[a.dest] = a.action === "store_true" ? true : !flag.startsWith("--no-");
      continue;
    }
    let value = explicit;
    if (value === null) {
      const next = argv[i];
      if (next === undefined || next === "--" || looksLikeOption(next, flags)) {
        throw new ParseError(`argument ${argName(a)}: expected one argument`);
      }
      value = next;
      i++;
    }
    const v = convert(a, value);
    if (a.action === "append") {
      const list = (Array.isArray(result[a.dest]) ? result[a.dest] : []) as unknown[];
      result[a.dest] = [...list, v];
    } else {
      result[a.dest] = v;
    }
  }

  // Positionals, matched left to right as argparse does: each takes as many strings as it
  // can while leaving enough for the ones after it.
  let k = positionals.length;
  const mins = positionals.map(minArgs);
  while (k > 0 && mins.slice(0, k).reduce((x, y) => x + y, 0) > strings.length) k--;
  let pos = 0;
  for (let j = 0; j < positionals.length; j++) {
    const a = positionals[j]!;
    if (j >= k) {
      if (a.nargs === "?" || a.nargs === "*") result[a.dest] = a.default ?? (a.nargs === "*" ? [] : null);
      continue;
    }
    const need = mins.slice(j + 1, k).reduce((x, y) => x + y, 0);
    const take = Math.min(maxArgs(a), strings.length - pos - need);
    const taken = strings.slice(pos, pos + take);
    pos += take;
    if (a.nargs === "*" || a.nargs === "+") {
      result[a.dest] = taken.length ? taken.map((s) => convert(a, s)) : (a.default ?? []);
    } else if (a.nargs === "?") {
      result[a.dest] = taken.length ? convert(a, taken[0]!) : (a.default ?? null);
    } else {
      result[a.dest] = convert(a, taken[0]!);
    }
    seen.add(a);
  }
  const missing = args.filter((a) => !seen.has(a) && (isOption(a) ? a.required : minArgs(a) > 0));
  if (missing.length) {
    throw new ParseError(`the following arguments are required: ${missing.map(argName).join(", ")}`);
  }
  const extra = [...unknown, ...strings.slice(pos)];
  if (extra.length) throw new ParseError(`unrecognized arguments: ${extra.join(" ")}`);
  return result;
}

/**
 * Parse argv for this parser. Prints help to stdout (ArgExit 0) or an error to stderr
 * (ArgExit 2) as argparse does.
 */
export function parse(spec: ParserSpec, argv: string[], out: (s: string) => void, err: (s: string) => void): Parsed {
  const fail = (prog: string, args: Arg[], message: string, commands?: Command[]): never => {
    err(`${usage(prog, args, commands)}\n${prog}: error: ${message}\n`);
    throw new ArgExit(2);
  };
  if (!spec.commands) {
    try {
      return parseArgs(spec.args ?? [], argv, out, spec);
    } catch (e) {
      if (e instanceof ParseError) fail(spec.prog, spec.args ?? [], e.message);
      throw e;
    }
  }
  const commands = spec.commands;
  // Before the command only -h/--help is known.
  let i = 0;
  const unknown: string[] = [];
  while (i < argv.length && argv[i]!.startsWith("-") && argv[i] !== "-" && argv[i] !== "--") {
    const t = argv[i]!;
    if (t === "-h" || (t.startsWith("--") && "--help".startsWith(t.split("=")[0]!) && t.length > 2)) {
      out(helpText(spec, [], commands));
      throw new ArgExit(0);
    }
    unknown.push(t);
    i++;
  }
  if (argv[i] === "--") i++;
  const name = argv[i];
  if (name === undefined) fail(spec.prog, [], "the following arguments are required: command", commands);
  const command = commands.find((c) => c.name === name);
  if (!command) {
    fail(spec.prog, [], `argument command: invalid choice: ${repr(name!)} ` +
      `(choose from ${commands.map((c) => repr(c.name)).join(", ")})`, commands);
  }
  const prog = `${spec.prog} ${command!.name}`;
  let parsed: Parsed;
  try {
    parsed = parseArgs(command!.args, argv.slice(i + 1), out, { prog });
  } catch (e) {
    if (e instanceof ParseError) fail(prog, command!.args, e.message);
    throw e;
  }
  if (unknown.length) fail(spec.prog, [], `unrecognized arguments: ${unknown.join(" ")}`, commands);
  parsed.command = command!.name;
  return parsed;
}
