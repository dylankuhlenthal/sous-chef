// The core names nobody: no core file names the first owner.
//
// Sous chef's code, kinds, templates, docs and tests take the owner's name from owner.json
// (decision 0018). This searches every file on the core's path list (core-paths.ts),
// ignoring case, for the first owner's name, branch prefix and Slack id, so a new mention
// fails the suite. The tests run as a neutral owner, Alex.
//
// Not searched, on purpose:
//   docs/decisions/   records of who decided what, left as written (decision 0020)
//   this file         it has to name what it searches for (the Slack id only as a hash)
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as corePaths from "./core-paths.js";
import { ROOT } from "./helpers.js";

const SEARCH = /dylan|dyl\//i;
// The first owner's Slack user id is an identifier, not a name, so it is not written
// here: anything shaped like a Slack user id is compared by its SHA-256.
const SLACK_ID = /\bU[A-Z0-9]{8,}\b/g;
const SLACK_ID_SHA256 = "b57ff6249e9bddf5ad6321be7f364e8b994faabfe55abdd09b88ed6b35f789b3";
const EXCLUDED_DIRS = ["docs/decisions/"];
// This file, which has to name what it searches for.
const EXCLUDED_FILES = ["tests/owner-neutral.test.ts", "tests/test_owner_neutral.py"];
// Stored values from before the owner was a setting, which the code must still read.
// Each is one named constant, so the old value appears exactly once.
const ALLOWED: [string, string][] = [
  ["lib/sc/events.py", 'LEGACY_OWNER = "dylan"'],
  ["lib/sc/slack.py", 'LEGACY_FROM_OWNER = "from_dylan"'],
  ["src/events.ts", 'export const LEGACY_OWNER = "dylan";'],
  ["src/slack.ts", 'export const LEGACY_FROM_OWNER = "from_dylan";'],
  ["tests/stored_values.py", 'LEGACY_OWNER = "dylan"'],
  ["tests/stored_values.py", 'LEGACY_FROM_OWNER = "from_dylan"'],
  ["tests/stored-values.ts", 'export const LEGACY_OWNER = "dylan";'],
  ["tests/stored-values.ts", 'export const LEGACY_FROM_OWNER = "from_dylan";'],
];
// The pinned Porch dependency (docs/decisions/0025): its package name and GitHub source
// carry its author's account, which is not the core naming its owner. The package name is
// allowed wherever the code imports it; the GitHub source only in the two package files.
// Only these exact forms, so any other mention still fails.
const PORCH_PACKAGE = /@dylankuhlenthal\/porch\b/g;
const PORCH_FILES = ["package.json", "package-lock.json"];
const PORCH_SOURCE = /github:dylankuhlenthal\/porch#[\w.-]+|github\.com\/dylankuhlenthal\/porch\.git#[0-9a-f]{40}/g;

/** Lines as Python's str.splitlines() splits them. */
const LINE_BREAKS = new Set(["\n", "\r", "\v", "\f", "\x1c", "\x1d", "\x1e", "\x85", "\u2028", "\u2029"]);
function splitlines(text: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!LINE_BREAKS.has(ch)) {
      line += ch;
      continue;
    }
    if (ch === "\r" && text[i + 1] === "\n") i++;
    lines.push(line);
    line = "";
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** A file's text, or null when it is not UTF-8 (a binary file). */
function readText(file: string): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file));
  } catch {
    return null;
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Every file on the core's path list (core-paths.ts), minus the exclusions; null when git cannot list them. */
function coreFiles(): string[] | null {
  let files: string[];
  try {
    files = corePaths.coreFiles(ROOT);
  } catch {
    return null;
  }
  return files.filter((f) => !EXCLUDED_DIRS.some((d) => f.startsWith(d)) && !EXCLUDED_FILES.includes(f)
    && isFile(path.join(ROOT, f)));
}

describe("OwnerNeutralTests", () => {
  it("no core file names the first owner", (ctx) => {
    const files = coreFiles();
    if (files === null) return ctx.skip();
    const found: string[] = [];
    expect(files).toContain("AGENTS.md");
    expect(files).toContain("bin/sc");
    const allowed = new Set(ALLOWED.map(([rel, line]) => JSON.stringify([rel, line])));
    for (const rel of files) {
      const text = readText(path.join(ROOT, rel));
      if (text === null) continue;
      splitlines(text).forEach((line, i) => {
        let checked = line.replace(PORCH_PACKAGE, "");
        if (PORCH_FILES.includes(rel)) checked = checked.replace(PORCH_SOURCE, "");
        if (SEARCH.test(checked) && !allowed.has(JSON.stringify([rel, line.trim()]))) {
          found.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
        }
        if ([...line.matchAll(SLACK_ID)].some((m) => crypto.createHash("sha256").update(m[0]).digest("hex") === SLACK_ID_SHA256)) {
          found.push(`${rel}:${i + 1}: the first owner's Slack user id`);
        }
      });
      if (SEARCH.test(rel)) found.push(`${rel}: the file name`);
    }
    expect(found, "core files name the first owner; use the owner (owner.json) instead").toEqual([]);
  });

  it("each legacy value is still there once", () => {
    for (const [rel, line] of ALLOWED) {
      expect(splitlines(fs.readFileSync(path.join(ROOT, rel), "utf8")).map((l) => l.trim()).filter((l) => l === line).length,
        rel).toBe(1);
    }
  });
});

// The owner's files. None may be tracked in the core, and the core's .gitignore lists each.
const PERSONAL = ["my", "state/", ".env", "memory/", "cron/", "context.json", "owner.json", "instructions.md",
  "worker-instructions.md", ".agents/settings.local.json"];

describe("CoreContentsTests", () => {
  it("no personal file is on the core path list and each is ignored", () => {
    const files = corePaths.coreFiles(ROOT);
    for (const name of PERSONAL) {
      expect(files.filter((f) => f === name.replace(/\/$/, "") || f.startsWith(name)), name).toEqual([]);
      const probe = name.endsWith("/") ? name + "x" : name;
      const out = spawnSync("git", ["-C", ROOT, "check-ignore", "-q", "--no-index", probe]);
      expect(out.status, `the core's .gitignore does not ignore ${name}`).toBe(0);
    }
  });

  it("every tracked file is core", () => {
    const outside = corePaths.listedFiles(ROOT).filter((f) => !corePaths.isCore(f));
    expect(outside, "add these to the core path list (tests/core-paths.ts) or the owner's data").toEqual([]);
  });
});
