// The Python-compatible helpers (src/py.ts), against what Python itself gives.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commas, fixed, floatRepr, isprintable, len, parseFloatPy, parseIntPy, pathStr, repr, resolvePath, shellQuote, slice,
  splitlines, splitWs, strip, truthy,
} from "../src/py.js";

const tmps: string[] = [];
afterEach(() => {
  for (const t of tmps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});

describe("resolvePath (Path.resolve)", () => {
  it("follows a link in the part that exists and keeps the missing rest as written", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "py-"));
    tmps.push(tmp);
    const real = path.join(tmp, "real");
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(tmp, "link"));
    const realTmp = fs.realpathSync(tmp);
    expect(resolvePath(path.join(tmp, "link", "not", "there"))).toBe(path.join(realTmp, "real", "not", "there"));
    expect(resolvePath(path.join(tmp, "link", "a", "..", "b"))).toBe(path.join(realTmp, "real", "b"));
    expect(resolvePath(path.join(tmp, "link"))).toBe(path.join(realTmp, "real"));
  });

  it("resolves macOS's /var to /private/var where that is a link", () => {
    if (process.platform !== "darwin") return;
    expect(resolvePath("/var/nonexistent-folder-x")).toBe("/private/var/nonexistent-folder-x");
  });

  it("writes a path as pathlib does", () => {
    expect(pathStr("/a//b/./c/")).toBe("/a/b/c");
    expect(pathStr("")).toBe(".");
  });
});

describe("strings", () => {
  it("isprintable rejects format, private use and other space characters, as Python does", () => {
    // Python: [c for c in ["\u200b", "\xa0", "\x85", " ", "a", "\ue000", "\u2000"] if c.isprintable()] == [" ", "a"]
    expect(["\u200b", "\xa0", "\x85", " ", "a", "\ue000", "\u2000"].filter(isprintable)).toEqual([" ", "a"]);
    expect(isprintable("")).toBe(true);
  });

  it("splitlines splits on every boundary Python knows", () => {
    expect(splitlines("a\x85b c\r\nd\x1ce\n")).toEqual(["a", "b", "c", "d", "e"]);
    expect(splitlines("")).toEqual([]);
  });

  it("strip and split use Python's whitespace, not JavaScript's", () => {
    expect(strip("\x1c x \x85")).toBe("x");
    expect(strip("﻿x")).toBe("﻿x"); // Python does not count the BOM as whitespace
    expect(strip("--a-b--", "-")).toBe("a-b");
    expect(splitWs("  a \t b\n")).toEqual(["a", "b"]);
  });

  it("counts and cuts code points, never half an emoji", () => {
    expect(len("a😀b")).toBe(3);
    expect(slice("a😀b", 0, 2)).toBe("a😀");
  });

  it("repr and shell quoting match Python's", () => {
    expect(repr("x")).toBe("'x'");
    expect(repr("it's")).toBe('"it\'s"');
    expect(shellQuote("/a/b")).toBe("/a/b");
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe("'it'\"'\"'s'");
    expect(shellQuote("")).toBe("''");
  });

  it("truthiness counts empty lists and dicts as false", () => {
    expect([null, undefined, 0, "", [], {}, false].some(truthy)).toBe(false);
    expect([1, "a", [0], { a: 1 }, true].every(truthy)).toBe(true);
  });
});

describe("numbers", () => {
  it('formats "{:.1f}" half to even on the binary value, as Python does', () => {
    // Python: f"{0.25:.1f} {0.35:.1f} {2.675:.2f} {65.0:.1f} {99.95:.1f} {0.05:.1f}" == "0.2 0.3 2.67 65.0 100.0 0.1"
    expect([fixed(0.25, 1), fixed(0.35, 1), fixed(2.675, 2), fixed(65, 1), fixed(99.95, 1), fixed(0.05, 1)].join(" "))
      .toBe("0.2 0.3 2.67 65.0 100.0 0.1");
    expect(fixed(-1.25, 1)).toBe("-1.2");
  });

  it("prints floats and thousands as Python does", () => {
    // Python: repr(1e-5), repr(1e16), repr(123.0), repr(0.1), repr(1.5e300)
    expect([1e-5, 1e16, 123, 0.1, 1.5e300].map(floatRepr)).toEqual(["1e-05", "1e+16", "123.0", "0.1", "1.5e+300"]);
    expect(commas(1234567)).toBe("1,234,567");
    expect(commas(999)).toBe("999");
  });

  it("parses numbers as Python's int() and float() do", () => {
    expect(parseIntPy(" 12 ")).toBe(12);
    expect(parseIntPy("1_000")).toBe(1000);
    expect(parseIntPy("1.5")).toBeNull();
    expect(parseFloatPy("1e3")).toBe(1000);
    expect(parseFloatPy("inf")).toBe(Infinity);
    expect(parseFloatPy("x")).toBeNull();
  });
});
