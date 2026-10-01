// JSON as Python's json module writes and reads it (src/pyjson.ts). The expected strings
// were produced by Python 3.11's json.dumps and json.loads.
import { describe, expect, it } from "vitest";
import { dumps, JSONDecodeError, loads } from "../src/pyjson.js";

const value = { b: { z: 1, a: [1, 2.5, "é😀"] }, a: null, c: true, t: 1800000000.5, e: {}, l: [] };

describe("dumps", () => {
  it("sorts keys at every level, with Python's separators and \\u escapes", () => {
    expect(dumps(value, { sortKeys: true })).toBe(
      '{"a": null, "b": {"a": [1, 2.5, "\\u00e9\\ud83d\\ude00"], "z": 1}, "c": true, "e": {}, "l": [], "t": 1800000000.5}');
  });

  it("indents files by two spaces", () => {
    expect(dumps(value, { sortKeys: true, indent: 2 })).toBe(
      '{\n  "a": null,\n  "b": {\n    "a": [\n      1,\n      2.5,\n      "\\u00e9\\ud83d\\ude00"\n    ],\n' +
      '    "z": 1\n  },\n  "c": true,\n  "e": {},\n  "l": [],\n  "t": 1800000000.5\n}');
  });

  it("escapes control characters and DEL", () => {
    expect(dumps({ x: 'tab\there "q" \\ \x01 \x7f' })).toBe('{"x": "tab\\there \\"q\\" \\\\ \\u0001 \\u007f"}');
  });

  it("keeps insertion order unless asked to sort", () => {
    expect(dumps({ b: 1, a: 2 })).toBe('{"b": 1, "a": 2}');
  });

  it("writes a whole-number float without .0 (the one known difference)", () => {
    expect(dumps({ ts: 1800000000.0 })).toBe('{"ts": 1800000000}');
  });
});

describe("loads", () => {
  const cases: [string, string][] = [
    ["", "Expecting value: line 1 column 1 (char 0)"],
    ["[1,", "Expecting value: line 1 column 4 (char 3)"],
    ['{"a" 1}', "Expecting ':' delimiter: line 1 column 6 (char 5)"],
    ['{"a":1 "b":2}', "Expecting ',' delimiter: line 1 column 8 (char 7)"],
    ["[1] x", "Extra data: line 1 column 5 (char 4)"],
    ["{1:2}", "Expecting property name enclosed in double quotes: line 1 column 2 (char 1)"],
    ['"abc', "Unterminated string starting at: line 1 column 1 (char 0)"],
    ['"\\q"', "Invalid \\escape: line 1 column 2 (char 1)"],
    ["\n\n  nope", "Expecting value: line 3 column 3 (char 4)"],
  ];
  it.each(cases)("refuses %j with Python's message", (text, message) => {
    expect(() => loads(text)).toThrow(JSONDecodeError);
    expect(() => loads(text)).toThrow(message);
  });

  it("reads what dumps wrote, and Python's NaN and Infinity", () => {
    expect(loads(dumps(value, { sortKeys: true, indent: 2 }))).toEqual(value);
    expect(loads("[NaN, Infinity, -Infinity]")).toEqual([NaN, Infinity, -Infinity]);
    expect(loads('"\\ud83d\\ude00"')).toBe("😀");
  });
});
