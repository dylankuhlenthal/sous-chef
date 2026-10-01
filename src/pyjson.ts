// JSON written and read the way Python's json module does it, so state files keep their
// format and a Python sc (a rollback) and a TypeScript one read each other's files.
//
// dumps matches json.dumps: keys sorted at every level when asked, indent=2 for files,
// ", " and ": " on one line otherwise, non-ASCII escaped as \uXXXX. The one known
// difference is numbers: a whole number Python holds as a float (1800000000.0) is
// written without ".0" (1800000000). Both read back the same in either language.
//
// loads matches json.loads, including its error messages ("Expecting value: line 1
// column 1 (char 0)"), which reach people in refusals such as "<file> is not valid JSON".

import { cmp, floatRepr } from "./py.js";

/** json.JSONDecodeError: a ValueError in Python, so callers catch it where Python catches ValueError. */
export class JSONDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JSONDecodeError";
  }
}

export interface DumpOptions {
  sortKeys?: boolean;
  indent?: number;
}

function escapeString(text: string): string {
  let out = '"';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ch = text[i]!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (c < 0x20 || c > 0x7e) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

function number(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "Infinity";
  if (n === -Infinity) return "-Infinity";
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return String(n === 0 ? 0 : n);
  return floatRepr(n);
}

/** json.dumps(value, sort_keys=..., indent=...). */
export function dumps(value: unknown, opts: DumpOptions = {}): string {
  const { sortKeys = false, indent } = opts;
  const itemSep = indent === undefined ? ", " : ",";
  const enc = (v: unknown, level: number): string => {
    if (v === null || v === undefined) return "null";
    if (v === true) return "true";
    if (v === false) return "false";
    if (typeof v === "number") return number(v);
    if (typeof v === "string") return escapeString(v);
    const nl = indent === undefined ? "" : "\n" + " ".repeat(indent * (level + 1));
    const close = indent === undefined ? "" : "\n" + " ".repeat(indent * level);
    if (Array.isArray(v)) {
      if (!v.length) return "[]";
      return "[" + nl + v.map((x) => enc(x, level + 1)).join(itemSep + nl) + close + "]";
    }
    if (typeof v === "object") {
      let keys = Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined);
      if (!keys.length) return "{}";
      if (sortKeys) keys = keys.sort(cmp);
      const items = keys.map((k) => escapeString(k) + ": " + enc((v as Record<string, unknown>)[k], level + 1));
      return "{" + nl + items.join(itemSep + nl) + close + "}";
    }
    throw new TypeError(`Object of type ${typeof v} is not JSON serializable`);
  };
  return enc(value, 0);
}

// --- loads ----------------------------------------------------------------------

const NUMBER = /(-?(?:0|[1-9]\d*))(\.\d+)?([eE][-+]?\d+)?/y;
const WS = /[ \t\n\r]*/y;

function where(doc: string, pos: number): string {
  const line = doc.slice(0, pos).split("\n").length;
  const col = pos - doc.lastIndexOf("\n", pos - 1);
  return `line ${line} column ${col} (char ${pos})`;
}

function fail(msg: string, doc: string, pos: number): never {
  throw new JSONDecodeError(`${msg}: ${where(doc, pos)}`);
}

function skip(doc: string, pos: number): number {
  WS.lastIndex = pos;
  WS.exec(doc);
  return WS.lastIndex;
}

const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

function scanString(doc: string, end: number): [string, number] {
  // `end` is just after the opening quote.
  const begin = end - 1;
  let out = "";
  for (;;) {
    if (end >= doc.length) fail("Unterminated string starting at", doc, begin);
    const ch = doc[end]!;
    if (ch === '"') return [out, end + 1];
    if (ch === "\\") {
      const esc = doc[end + 1];
      if (esc === undefined) fail("Unterminated string starting at", doc, begin);
      if (esc !== "u") {
        const v = ESCAPES[esc];
        if (v === undefined) fail("Invalid \\escape", doc, end);
        out += v;
        end += 2;
        continue;
      }
      const hex = doc.slice(end + 2, end + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("Invalid \\uXXXX escape", doc, end + 1);
      let cp = parseInt(hex, 16);
      end += 6;
      if (cp >= 0xd800 && cp <= 0xdbff && doc.slice(end, end + 2) === "\\u") {
        const hex2 = doc.slice(end + 2, end + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex2)) fail("Invalid \\uXXXX escape", doc, end + 1);
        const lo = parseInt(hex2, 16);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
          end += 6;
        }
      }
      out += String.fromCodePoint(cp);
      continue;
    }
    if (ch.charCodeAt(0) < 0x20) fail("Invalid control character at", doc, end);
    out += ch;
    end++;
  }
}

function scanValue(doc: string, pos: number): [unknown, number] {
  const ch = doc[pos];
  if (ch === '"') return scanString(doc, pos + 1);
  if (ch === "{") return scanObject(doc, pos + 1);
  if (ch === "[") return scanArray(doc, pos + 1);
  if (ch === "n" && doc.startsWith("null", pos)) return [null, pos + 4];
  if (ch === "t" && doc.startsWith("true", pos)) return [true, pos + 4];
  if (ch === "f" && doc.startsWith("false", pos)) return [false, pos + 5];
  if (ch === "N" && doc.startsWith("NaN", pos)) return [NaN, pos + 3];
  if (ch === "I" && doc.startsWith("Infinity", pos)) return [Infinity, pos + 8];
  if (ch === "-" && doc.startsWith("-Infinity", pos)) return [-Infinity, pos + 9];
  NUMBER.lastIndex = pos;
  const m = NUMBER.exec(doc);
  if (m && m.index === pos) return [Number(m[0]), pos + m[0].length];
  return fail("Expecting value", doc, pos);
}

function scanObject(doc: string, pos: number): [unknown, number] {
  const out: Record<string, unknown> = {};
  pos = skip(doc, pos);
  if (doc[pos] === "}") return [out, pos + 1];
  for (;;) {
    if (doc[pos] !== '"') fail("Expecting property name enclosed in double quotes", doc, pos);
    const [key, afterKey] = scanString(doc, pos + 1);
    pos = skip(doc, afterKey);
    if (doc[pos] !== ":") fail("Expecting ':' delimiter", doc, pos);
    pos = skip(doc, pos + 1);
    const [value, afterValue] = scanValue(doc, pos);
    out[key] = value;
    pos = skip(doc, afterValue);
    if (doc[pos] === "}") return [out, pos + 1];
    if (doc[pos] !== ",") fail("Expecting ',' delimiter", doc, pos);
    pos = skip(doc, pos + 1);
  }
}

function scanArray(doc: string, pos: number): [unknown, number] {
  const out: unknown[] = [];
  pos = skip(doc, pos);
  if (doc[pos] === "]") return [out, pos + 1];
  for (;;) {
    const [value, after] = scanValue(doc, pos);
    out.push(value);
    pos = skip(doc, after);
    if (doc[pos] === "]") return [out, pos + 1];
    if (doc[pos] !== ",") fail("Expecting ',' delimiter", doc, pos);
    pos = skip(doc, pos + 1);
  }
}

/** json.loads(text). Raises JSONDecodeError with Python's message. */
export function loads(text: string): unknown {
  if (text.startsWith("﻿")) fail("Unexpected UTF-8 BOM (decode using utf-8-sig)", text, 0);
  const start = skip(text, 0);
  const [value, end] = scanValue(text, start);
  const rest = skip(text, end);
  if (rest !== text.length) fail("Extra data", text, rest);
  return value;
}
