// Python-compatible helpers: the places where a line-by-line port from the Python sc
// would behave differently in JavaScript. Each one does what the Python built-in it is
// named after does, for the inputs sous chef gives it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --- truthiness ----------------------------------------------------------------

/** Python's truthiness: None, False, 0, "", [] and {} are false; everything else is true. */
export function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (typeof value === "number" && Number.isNaN(value)) return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

/** Python's `a or b`. */
export function or<T, U>(a: T, b: U): T | U {
  return truthy(a) ? a : b;
}

/** A plain JSON object (Python dict), as read from a file. */
export type Dict = Record<string, unknown>;

export function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python's dict.get(key, default): the default only when the key is absent. */
export function get<T = unknown>(d: unknown, key: string, dflt?: T): T {
  if (isDict(d) && Object.prototype.hasOwnProperty.call(d, key)) return d[key] as T;
  return dflt as T;
}

// --- strings -------------------------------------------------------------------

// Python's str.isspace() characters (the Unicode White_Space property plus the
// separators Python counts): what str.split(), str.strip() and isspace() use.
const WS = "\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0           " +
  "     　";
const WS_SET = new Set(WS);

export function isspace(ch: string): boolean {
  return WS_SET.has(ch);
}

/** str.isspace() for a whole string: true when it is non-empty and every character is whitespace. */
export function isAllSpace(text: string): boolean {
  return text.length > 0 && [...text].every(isspace);
}

function stripSet(chars?: string): (ch: string) => boolean {
  if (chars === undefined) return isspace;
  const set = new Set(chars);
  return (ch) => set.has(ch);
}

export function lstrip(text: string, chars?: string): string {
  const drop = stripSet(chars);
  const cps = [...text];
  let i = 0;
  while (i < cps.length && drop(cps[i]!)) i++;
  return cps.slice(i).join("");
}

export function rstrip(text: string, chars?: string): string {
  const drop = stripSet(chars);
  const cps = [...text];
  let j = cps.length;
  while (j > 0 && drop(cps[j - 1]!)) j--;
  return cps.slice(0, j).join("");
}

/** str.strip(): Python's whitespace by default, or the given characters. */
export function strip(text: string, chars?: string): string {
  return rstrip(lstrip(text, chars), chars);
}

/** str.split() with no separator: runs of whitespace, no empty strings. */
export function splitWs(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of text) {
    if (isspace(ch)) {
      if (cur) out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// str.splitlines() line boundaries.
const LINE_BREAKS = new Set(["\n", "\r", "\v", "\f", "\x1c", "\x1d", "\x1e", "\x85", " ", " "]);

/** str.splitlines(): splits on every line boundary Python knows, drops a final empty line. */
export function splitlines(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (LINE_BREAKS.has(ch)) {
      out.push(cur);
      cur = "";
      if (ch === "\r" && text[i + 1] === "\n") i++;
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** str.partition(sep). */
export function partition(text: string, sep: string): [string, string, string] {
  const i = text.indexOf(sep);
  return i < 0 ? [text, "", ""] : [text.slice(0, i), sep, text.slice(i + sep.length)];
}

/** str.rpartition(sep). */
export function rpartition(text: string, sep: string): [string, string, string] {
  const i = text.lastIndexOf(sep);
  return i < 0 ? ["", "", text] : [text.slice(0, i), sep, text.slice(i + sep.length)];
}

/** len(str): code points, not UTF-16 units. */
export function len(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/** str[start:end] by code points (end may be undefined). */
export function slice(text: string, start: number, end?: number): string {
  return [...text].slice(start, end).join("");
}

// Characters str.isprintable() rejects: categories Cc, Cf, Cs, Co, Cn, Zl, Zp, and Zs
// other than the plain space.
const NOT_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]|(?! )\p{Zs}/u;

/** str.isprintable(). An empty string is printable. */
export function isprintable(text: string): boolean {
  return !NOT_PRINTABLE.test(text);
}

/** str.capitalize(): first character upper case, the rest lower case. */
export function capitalize(text: string): string {
  const cps = [...text];
  if (!cps.length) return text;
  return cps[0]!.toUpperCase() + cps.slice(1).join("").toLowerCase();
}

/** Code-point order, as Python compares strings. */
export function cmp(a: string, b: string): number {
  const ai = [...a];
  const bi = [...b];
  for (let i = 0; i < Math.min(ai.length, bi.length); i++) {
    const x = ai[i]!.codePointAt(0)!;
    const y = bi[i]!.codePointAt(0)!;
    if (x !== y) return x - y;
  }
  return ai.length - bi.length;
}

/** sorted() for strings. */
export function sorted(items: Iterable<string>): string[] {
  return [...items].sort(cmp);
}

/** repr() of a str, as Python prints it inside error messages ('x', or "x" when it holds a quote). */
export function repr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += "\\" + quote;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20 || cp === 0x7f) out += "\\x" + cp.toString(16).padStart(2, "0");
    else if (!isprintable(ch)) {
      out += cp <= 0xff ? "\\x" + cp.toString(16).padStart(2, "0")
        : cp <= 0xffff ? "\\u" + cp.toString(16).padStart(4, "0") : "\\U" + cp.toString(16).padStart(8, "0");
    } else out += ch;
  }
  return out + quote;
}

// --- numbers ---------------------------------------------------------------------

/** Floor division, as Python's //. */
export function floordiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** int(x) for a number: truncates toward zero. */
export function int(x: number): number {
  return Math.trunc(x);
}

/** "{:,}" for a whole number. */
export function commas(n: number): string {
  const neg = n < 0;
  const digits = String(Math.abs(Math.trunc(n)));
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return (neg ? "-" : "") + out;
}

/**
 * "{:.Nf}" exactly as Python formats it: the double's exact binary value rounded half to even.
 * (Number.prototype.toFixed rounds an exact tie up, so 0.25 gives "0.3" where Python gives "0.2".)
 */
export function fixed(x: number, digits: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  const neg = x < 0 || Object.is(x, -0);
  const { mantissa, exponent } = decompose(Math.abs(x));
  // |x| = mantissa * 2^exponent; scale by 10^digits and round half to even.
  let num = mantissa * 10n ** BigInt(digits);
  let q: bigint;
  if (exponent >= 0) {
    q = num << BigInt(exponent);
  } else {
    const den = 1n << BigInt(-exponent);
    q = num / den;
    const r = num - q * den;
    const twice = 2n * r;
    if (twice > den || (twice === den && q % 2n === 1n)) q += 1n;
  }
  num = q;
  let s = num.toString();
  if (digits > 0) {
    s = s.padStart(digits + 1, "0");
    s = s.slice(0, -digits) + "." + s.slice(-digits);
  }
  return (neg ? "-" : "") + s;
}

function decompose(x: number): { mantissa: bigint; exponent: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const biased = (hi >>> 20) & 0x7ff;
  const frac = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (biased === 0) return { mantissa: frac, exponent: -1074 };
  return { mantissa: frac | (1n << 52n), exponent: biased - 1075 };
}

/** str(float) / repr(float): the shortest round-trip form, with ".0" on whole numbers. */
export function floatRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const abs = Math.abs(x);
  if (abs !== 0 && (abs >= 1e16 || abs < 1e-4)) {
    // Python switches to exponent form at 1e16 and below 1e-4: d.ddde+XX, two exponent digits at least.
    const [m, e] = x.toExponential().split("e") as [string, string];
    const sign = e.startsWith("-") ? "-" : "+";
    const digits = e.replace(/^[+-]/, "").padStart(2, "0");
    return `${m}e${sign}${digits}`;
  }
  const s = String(x);
  return Number.isInteger(x) ? `${s === "-0" ? "-0" : s}.0` : s;
}

/** float(text) as Python parses it, or null when Python would raise ValueError. */
export function parseFloatPy(text: string): number | null {
  const t = strip(text).replace(/(\d)_(?=\d)/g, "$1");
  if (/^[+-]?(inf|infinity)$/i.test(t)) return t.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(t)) return NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return null;
  return Number(t);
}

/** int(text) as Python parses a base-10 string, or null when Python would raise ValueError. */
export function parseIntPy(text: string): number | null {
  const t = strip(text);
  if (!/^[+-]?\d+(_\d+)*$/.test(t)) return null;
  return Number(t.replace(/_/g, ""));
}

// --- paths -----------------------------------------------------------------------

/** os.path.expanduser for "~" and "~/..." (Python reads HOME). */
export function expanduser(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    const home = process.env.HOME || os.homedir();
    return home + p.slice(1);
  }
  return p;
}

/**
 * pathlib.Path(p) as a string: repeated slashes collapsed, "." parts and a trailing slash
 * dropped, ".." kept. Path("") is ".".
 */
export function pathStr(p: string): string {
  if (!p) return ".";
  const abs = p.startsWith("/");
  const parts = p.split("/").filter((x) => x && x !== ".");
  const joined = parts.join("/");
  if (abs) return "/" + joined;
  return joined || ".";
}

/** Path.resolve(): absolute, with symlinks followed even where the path does not exist yet. */
export function resolvePath(p: string): string {
  const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  const parts = abs.split("/").filter((x) => x && x !== ".");
  let current = "/";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === "..") {
      current = path.dirname(current);
      continue;
    }
    const next = current === "/" ? `/${part}` : `${current}/${part}`;
    let real: string | null = null;
    try {
      real = fs.realpathSync(next);
    } catch {
      real = null;
    }
    if (real === null) {
      // From the first part that does not exist, the rest is taken as written.
      let rest = next;
      for (const later of parts.slice(i + 1)) {
        rest = later === ".." ? path.dirname(rest) : `${rest}/${later}`;
      }
      return rest;
    }
    current = real;
  }
  return current;
}

/** Whether `parent` is one of Path(child).parents (both already resolved or written the same way). */
export function isUnder(child: string, parent: string): boolean {
  if (child === parent) return false;
  const base = parent.endsWith("/") ? parent : parent + "/";
  return child.startsWith(base) || (parent === "/" && child.startsWith("/"));
}

/** Path.is_file(): exists (following links) and is a regular file. */
export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Path.is_dir(). */
export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Path.exists() (follows links). */
export function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Path.is_symlink(). */
export function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Path.stem. */
export function stem(p: string): string {
  const base = path.basename(p);
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(0, i) : base;
}

/** Names in a folder (sorted by code point), or [] when it is not a folder. */
export function listDir(p: string): string[] {
  try {
    return sorted(fs.readdirSync(p));
  } catch {
    return [];
  }
}

/** Path(folder).glob("*<suffix>") names, sorted. pathlib's "*" also matches names starting with a dot. */
export function glob(folder: string, suffix: string): string[] {
  return listDir(folder).filter((n) => n.endsWith(suffix));
}

/** Every file under a folder (following no links into folders), as relative paths sorted by code point. */
export function walkFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) visit(path.join(dir, e.name), childRel);
      else out.push(childRel);
    }
  };
  visit(root, "");
  return sorted(out);
}

// --- shell -----------------------------------------------------------------------

const SHELL_UNSAFE = /[^\w@%+=:,./-]/;

/** shlex.quote: the text unchanged when it is safe in a shell word, else single-quoted. */
export function shellQuote(text: string): string {
  if (!text) return "''";
  if (!SHELL_UNSAFE.test(text)) return text;
  return "'" + text.replace(/'/g, "'\"'\"'") + "'";
}
