// The command-line parser (src/args.ts): argparse's behaviour and wording for what sc uses.
import { describe, expect, it } from "vitest";
import { ArgExit, Command, parse, ParserSpec } from "../src/args.js";

const commands: Command[] = [
  { name: "spawn", args: [
    { flags: ["--kind"], dest: "kind", required: true },
    { flags: ["--title"], dest: "title", required: true },
    { flags: ["--task-file"], dest: "task_file" },
    { flags: ["--permissions"], dest: "permissions", choices: ["auto", "accept-edits", "bypass", "ask"] },
    { flags: ["--runtime"], dest: "runtime", hidden: true },
  ] },
  { name: "send", args: [{ dest: "id" }, { dest: "text", nargs: "+" }, { flags: ["--resolves"], dest: "resolves" }] },
  { name: "report", args: [{ dest: "state" }, { dest: "text", nargs: "*" }, { flags: ["--key"], dest: "key" }] },
  { name: "cron", args: [
    { dest: "action", nargs: "?", choices: ["list", "add"], default: "list" },
    { dest: "name", nargs: "?" },
    { flags: ["--at"], dest: "at", group: "s" },
    { flags: ["--every"], dest: "every", group: "s" },
  ] },
  { name: "status", args: [{ dest: "id" }, { flags: ["-n"], dest: "n", type: "int", default: 10 }] },
  { name: "setup", args: [{ flags: ["--git"], dest: "git", action: "boolean_optional" },
    { flags: ["--yes"], dest: "yes", action: "store_true" }] },
  { name: "context", args: [{ flags: ["--warn-at"], dest: "warn_at", type: "float" },
    { flags: ["--window"], dest: "window", action: "append" }] },
];
const spec: ParserSpec = { prog: "sc", description: "test", commands };

function run(...argv: string[]) {
  let out = "";
  let err = "";
  try {
    const parsed = parse(spec, argv, (s) => (out += s), (s) => (err += s));
    return { parsed, out, err, code: null as number | null };
  } catch (e) {
    if (e instanceof ArgExit) return { parsed: null, out, err, code: e.code };
    throw e;
  }
}

function error(...argv: string[]): string {
  const r = run(...argv);
  expect(r.code).toBe(2);
  const lines = r.err.trimEnd().split("\n");
  expect(r.err.startsWith("usage: ")).toBe(true);
  return lines[lines.length - 1]!;
}

describe("errors, in argparse's words", () => {
  it("an invalid choice", () => {
    expect(error("spawn", "--kind", "k", "--title", "t", "--permissions", "x")).toBe(
      "sc spawn: error: argument --permissions: invalid choice: 'x' (choose from 'auto', 'accept-edits', 'bypass', 'ask')");
  });
  it("unrecognized arguments", () => {
    expect(error("spawn", "--kind", "k", "--title", "t", "--nope", "extra")).toBe(
      "sc spawn: error: unrecognized arguments: --nope extra");
  });
  it("missing required arguments", () => {
    expect(error("spawn")).toBe("sc spawn: error: the following arguments are required: --kind, --title");
    expect(error("send", "x")).toBe("sc send: error: the following arguments are required: text");
    expect(error()).toBe("sc: error: the following arguments are required: command");
  });
  it("mutually exclusive options", () => {
    expect(error("cron", "add", "x", "--at", "09:00", "--every", "6h")).toBe(
      "sc cron: error: argument --every: not allowed with argument --at");
  });
  it("a bad int or float", () => {
    expect(error("status", "x", "-n", "x")).toBe("sc status: error: argument -n: invalid int value: 'x'");
    expect(error("context", "--warn-at", "lots")).toBe("sc context: error: argument --warn-at: invalid float value: 'lots'");
  });
  it("an unknown command", () => {
    expect(error("nope")).toMatch(/^sc: error: argument command: invalid choice: 'nope' \(choose from 'spawn', /);
  });
  it("an option with no value", () => {
    expect(error("spawn", "--kind")).toBe("sc spawn: error: argument --kind: expected one argument");
  });
});

describe("parsing", () => {
  it("takes positionals before, after and between options", () => {
    expect(run("report", "resolved", "--key", "q2", "the", "answer").parsed).toMatchObject(
      { command: "report", state: "resolved", key: "q2", text: ["the", "answer"] });
    expect(run("send", "--resolves", "q1", "id1", "hi", "there").parsed).toMatchObject(
      { id: "id1", text: ["hi", "there"], resolves: "q1" });
  });
  it("takes --opt=value and unique prefixes of long options", () => {
    expect(run("spawn", "--kind=general", "--tit", "t", "--perm", "bypass").parsed).toMatchObject(
      { kind: "general", title: "t", permissions: "bypass" });
    expect(error("spawn", "--t", "x")).toBe("sc spawn: error: ambiguous option: --t could match --title, --task-file");
  });
  it("takes --git and --no-git, store_true, append, int and float", () => {
    expect(run("setup", "--no-git", "--yes").parsed).toMatchObject({ git: false, yes: true });
    expect(run("setup").parsed).toMatchObject({ git: null, yes: false });
    expect(run("context", "--warn-at", "70", "--window", "a=1", "--window", "b=2").parsed).toMatchObject(
      { warn_at: 70, window: ["a=1", "b=2"] });
    expect(run("status", "x", "-n5").parsed).toMatchObject({ n: 5 });
    expect(run("status", "x").parsed).toMatchObject({ n: 10 });
  });
  it("takes - as text, and fills optional positionals with their defaults", () => {
    expect(run("send", "id", "-").parsed).toMatchObject({ text: ["-"] });
    expect(run("cron").parsed).toMatchObject({ action: "list", name: null });
    expect(run("report", "done").parsed).toMatchObject({ text: [] });
  });
  it("prints help at both levels and exits 0", () => {
    const top = run("--help");
    expect(top.code).toBe(0);
    expect(top.out).toMatch(/^usage: sc /);
    const sub = run("spawn", "-h");
    expect(sub.code).toBe(0);
    expect(sub.out).toMatch(/^usage: sc spawn /);
    expect(sub.out).not.toContain("--runtime");
  });
});
