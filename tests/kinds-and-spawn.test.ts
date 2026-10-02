// Behaviour tests for sc, run against the real command line with the fake runtime: spawning
// sessions, permission modes, and kinds (user kinds, skills, the listing, the owner in a kind).
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyCode, coreKindNames } from "./core-paths.js";
import { CodeCopyTest, type Out, read, readJson, ROOT, run, ScTest, write } from "./helpers.js";

/** Python's `str.splitlines()`: no trailing empty line. */
function splitlines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Python's `str.split()`: any whitespace, no empty items. */
function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

describe("SpawnTests", () => {
  let t: ScTest;
  beforeEach(() => { t = new ScTest(); });
  afterEach(() => t.cleanup());

  it("spawn writes record brief and launched event", async () => {
    const sid = await t.spawn(t.ownerKind(), "Companybrain idea", "shape the companybrain idea");
    const sdir = path.join(t.home, "state", "sessions", sid);
    const rec = readJson(path.join(sdir, "record.json"));
    expect(rec.kind).toBe("pairing");
    expect(rec.handle.session_id).toBe(`fake-${sid}`);
    const brief = read(path.join(sdir, "brief.md"));
    expect(brief).toContain("shape the companybrain idea");
    expect(brief).toContain("Never merge into `main` or `staging`");
    expect(brief).not.toContain("{{");
    expect(t.events(sid)[0].state).toBe("launched");
    expect((await t.sc(["sessions"])).stdout).toContain("waiting on: alex");
  });

  it("spawn passes identity env and hooks to the runtime", async () => {
    const sid = await t.spawn();
    const launched = t.fakeState().sessions[sid];
    expect(Object.keys(launched.env)).not.toContain("SC_SESSION_ID");
    expect(launched.env.PATH.split(":")).toContain(path.join(ROOT, "bin"));
    expect(Object.keys(launched.settings.hooks).sort())
      .toEqual(["PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
  });

  it("spawn refuses sous chef folder empty task and unknown kind", async () => {
    let out = await t.sc(["spawn", "--kind", "general", "--title", "x", "--cwd", t.home,
      "--runtime", "fake"], { stdin: "task", ok: false });
    expect(out.stderr).toContain("inside the sous chef data folder");
    out = await t.sc(["spawn", "--kind", "general", "--title", "x", "--cwd", path.join(ROOT, "kinds"),
      "--runtime", "fake"], { stdin: "task", ok: false });
    expect(out.stderr).toContain("inside the sous chef code folder");
    out = await t.sc(["spawn", "--kind", "general", "--title", "x", "--cwd", t.work,
      "--runtime", "fake"], { stdin: "", ok: false });
    expect(out.stderr).toContain("task text is empty");
    out = await t.sc(["spawn", "--kind", "nope", "--title", "x", "--cwd", t.work,
      "--runtime", "fake"], { stdin: "task", ok: false });
    expect(out.stderr).toContain("unknown kind");
  });
});

describe("PermissionsTests", () => {
  let t: ScTest;
  beforeEach(() => { t = new ScTest(); });
  afterEach(() => t.cleanup());

  function record(sid: string): any { // eslint-disable-line @typescript-eslint/no-explicit-any
    return readJson(path.join(t.home, "state", "sessions", sid, "record.json"));
  }

  it("spawn defaults to auto and records it", async () => {
    const sid = await t.spawn();
    expect(record(sid).permissions).toBe("auto");
    expect(t.fakeState().sessions[sid].permissions).toBe("auto");
    expect((await t.sc(["status", sid])).stdout).toContain("permissions: auto");
  });

  it("a chosen permission reaches the runtime and survives stop and resume", async () => {
    const out = await t.sc(["spawn", "--kind", "general", "--title", "fresh dir", "--cwd", t.work,
      "--runtime", "fake", "--permissions", "bypass"], { stdin: "build it" });
    expect(out.stdout).toContain("permissions: bypass");
    const sid = words(out.stdout)[1]!;
    expect(record(sid).permissions).toBe("bypass");
    expect(t.fakeState().sessions[sid].permissions).toBe("bypass");
    await t.sc(["stop", sid]);
    await t.sc(["resume", sid]);
    expect(record(sid).permissions).toBe("bypass");
    expect(t.fakeState().sessions[sid].permissions).toBe("bypass");
    expect((await t.sc(["status", sid])).stdout).toContain("permissions: bypass");
  });

  it("an unknown permission is refused and nothing is launched", async () => {
    const out = await t.sc(["spawn", "--kind", "general", "--title", "x", "--cwd", t.work,
      "--runtime", "fake", "--permissions", "bypassPermissions"], { stdin: "t", ok: false });
    expect(out.stderr).toContain("invalid choice");
    expect(fs.existsSync(path.join(t.home, "state", "fake-runtime.json"))).toBe(false);
  });
});

// A kind's `permissions` front matter sets the default for its sessions; `--permissions` overrides it.
// These run a copy of the code with their own kind files, so they do not depend on the shipped kinds.
describe("KindPermissionsTests", () => {
  let t: CodeCopyTest;
  beforeEach(() => {
    t = new CodeCopyTest();
    writeKind("loose", "permissions: bypass\n");
    writeKind("careful", "permissions: auto\n");
    writeKind("plain", "");
  });
  afterEach(() => t.cleanup());

  function writeKind(name: string, extra: string): void {
    fs.writeFileSync(path.join(t.code, "kinds", `${name}.md`),
      `---\ndescription: ${name} kind\nstarts_waiting_on: agent\n${extra}---\nDo the task.\n`);
  }

  async function spawnKind(kind: string, ...flags: string[]): Promise<[string, string]> {
    const out = await t.copySc(["spawn", "--kind", kind, "--title", "t", "--cwd", t.work,
      "--runtime", "fake", ...flags], { stdin: "do it" });
    const sid = words(out.stdout)[1]!;
    return [readJson(path.join(t.home, "state", "sessions", sid, "record.json")).permissions, sid];
  }

  it("a kinds permissions is the default for its sessions", async () => {
    const [perms, sid] = await spawnKind("loose");
    expect(perms).toBe("bypass");
    expect(t.fakeState().sessions[sid].permissions).toBe("bypass");
  });

  it("an explicit flag overrides the kind both ways", async () => {
    expect((await spawnKind("loose", "--permissions", "auto"))[0]).toBe("auto");
    expect((await spawnKind("careful", "--permissions", "bypass"))[0]).toBe("bypass");
  });

  it("a kind without the field keeps the global default", async () => {
    expect((await spawnKind("plain"))[0]).toBe("auto");
    expect((await spawnKind("plain", "--permissions", "ask"))[0]).toBe("ask");
    expect(splitlines((await t.copySc(["kinds", "--runtime", "fake"])).stdout)
      .filter((l) => l.startsWith("plain"))[0]!).not.toContain("permissions");
  });

  it("sc kinds shows a kinds permissions", async () => {
    const line = splitlines((await t.copySc(["kinds", "--runtime", "fake"])).stdout).filter((l) => l.startsWith("loose"))[0]!;
    expect(line).toContain("(permissions: bypass)");
  });

  it("an unknown value in a kind is refused when loaded or listed", async () => {
    writeKind("broken", "permissions: bypassPermissions\n");
    let out = await t.copySc(["spawn", "--kind", "broken", "--title", "t", "--cwd", t.work,
      "--runtime", "fake"], { stdin: "do it", ok: false });
    expect(out.stderr).toContain("kinds/broken.md: permissions must be one of");
    expect(fs.existsSync(path.join(t.home, "state", "fake-runtime.json"))).toBe(false);
    out = await t.copySc(["kinds", "--runtime", "fake"], { ok: false });
    expect(out.stderr).toContain("kinds/broken.md: permissions must be one of");
  });

  // Run against the core as published: the owner's kinds are theirs, in my/kinds (decision 0020).
  it("the core ships only general and investigate neither in bypass", async () => {
    expect(coreKindNames()).toEqual(["general", "investigate"]);
    const code = copyCode(path.join(t.tmp, "core"), ROOT);
    const out = splitlines((await run(path.join(code, "bin", "sc"), ["kinds", "--runtime", "fake"],
      { env: t.env() })).stdout);
    expect(out.filter((l) => l && l[0] !== " ").map((l) => words(l)[0])).toEqual(["general", "investigate"]);
    for (const line of out) {
      expect(line).not.toContain("bypass");
    }
  });
});

// Kinds come from the user kinds folder (kinds/ under the data home) first, then the core's kinds/.
describe("UserKindsTests", () => {
  let t: ScTest;
  beforeEach(() => { t = new ScTest(); });
  afterEach(() => t.cleanup());

  function brief(sid: string): string {
    return read(path.join(t.home, "state", "sessions", sid, "brief.md"));
  }

  async function listed(): Promise<string[]> {
    return splitlines((await t.sc(["kinds", "--runtime", "fake"])).stdout)
      .filter((l) => l && l[0] !== " ").map((l) => words(l)[0]!);
  }

  it("a user kind replaces the core kind of the same name", async () => {
    t.userKind("general", { body: "The user's own general instructions." });
    const sid = await t.spawn("general");
    expect(brief(sid)).toContain("The user's own general instructions.");
    expect(brief(sid)).not.toContain("Do the task as described.");
    expect((await listed()).filter((k) => k === "general").length).toBe(1);
  });

  it("a user only kind is listed and spawns", async () => {
    t.userKind("triage", { body: "Triage the thing." });
    expect(await listed()).toContain("triage");
    expect(await listed()).toContain("general");
    expect(brief(await t.spawn("triage"))).toContain("Triage the thing.");
  });

  it("a kind name that is not kebab case is an unknown kind", async () => {
    fs.mkdirSync(path.join(t.home, "kinds"));
    fs.writeFileSync(path.join(t.home, "kinds", "Bad_Name.md"), "---\ndescription: x\n---\nx\n");
    fs.writeFileSync(path.join(t.work, "outside.md"), "---\ndescription: outside\n---\nx\n");
    expect(await listed()).not.toContain("Bad_Name");
    for (const name of ["Bad_Name", "../work/outside", "../kinds/general", "general/", "x.y", ""]) {
      const out = await t.sc(["spawn", "--kind", name, "--title", "x", "--cwd", t.work,
        "--runtime", "fake"], { stdin: "task", ok: false });
      expect(out.stderr, name).toContain("unknown kind");
    }
    expect(fs.existsSync(path.join(t.home, "state", "sessions"))).toBe(false);
  });
});

// A kind may declare the skill it runs; `sc spawn` refuses when the runtime says it is missing.
describe("KindSkillTests", () => {
  let t: ScTest;
  beforeEach(() => { t = new ScTest(); });
  afterEach(() => t.cleanup());

  function spawnOut(kind: string, o: { runtime?: string; env?: Record<string, string>; ok?: boolean } = {}): Promise<Out> {
    return t.sc(["spawn", "--kind", kind, "--title", "t", "--cwd", t.work, "--runtime", o.runtime ?? "fake"],
      { stdin: "do it", env: o.env, ok: o.ok ?? true });
  }

  it("a missing skill is refused before anything is written", async () => {
    t.userKind("drafting", { extra: "skill: draft-it\n", body: "Run the `/draft-it` skill." });
    t.fakeSkills({ missing: ["draft-it"] });
    const out = await spawnOut("drafting", { ok: false });
    expect(out.stderr).toContain("kind 'drafting' needs the skill 'draft-it', which is not in your skills");
    expect(out.stderr).toContain(`add your own version of the kind in ${path.join(t.home, "kinds")}`);
    expect(fs.existsSync(path.join(t.home, "state", "sessions"))).toBe(false);
    expect(t.fakeState().sessions).toEqual({});
    expect((await t.sc(["summary"])).stdout).toContain("Nothing waiting.");
  });

  it("a skill that is found or cannot be told launches", async () => {
    t.userKind("drafting", { extra: "skill: draft-it\n", body: "Run the `/draft-it` skill." });
    t.userKind("namespaced", { extra: "skill: team:draft\n", body: "Run the `/team:draft` skill." });
    t.fakeSkills({ unknown: ["team:draft"] });
    await t.spawn("drafting");
    await t.spawn("namespaced");
    expect(Object.keys(t.fakeState().sessions).length).toBe(2);
    // The check is made with the session's own working directory.
    expect(t.fakeState().skill_checks).toContainEqual(["draft-it", fs.realpathSync(t.work)]);
  });

  it("a kind without a skill is not checked", async () => {
    await t.spawn();
    const state = t.fakeState();
    expect(Object.hasOwn(state, "skill_checks") ? state.skill_checks : []).toEqual([]);
  });

  it("a skill value with a slash or space is refused", async () => {
    for (const value of ["/draft-it", "draft it"]) {
      t.userKind("drafting", { extra: `skill: ${value}\n` });
      const out = await spawnOut("drafting", { ok: false });
      expect(out.stderr).toContain(`${path.join(t.home, "kinds", "drafting.md")}: skill must be a bare skill name`);
    }
  });

  it("the claude runtime refuses a skill that is not on disk without running claude", async () => {
    const config = path.join(t.tmp, "claude-config");
    fs.mkdirSync(path.join(config, "skills", "present-skill"), { recursive: true });
    fs.writeFileSync(path.join(config, "skills", "present-skill", "SKILL.md"), "---\nname: present-skill\n---\nx\n");
    t.userKind("drafting", { extra: "skill: zz-no-such-skill-for-tests\n" });
    const out = await spawnOut("drafting", { runtime: "claude-bg", env: { CLAUDE_CONFIG_DIR: config }, ok: false });
    expect(out.stderr).toContain("needs the skill 'zz-no-such-skill-for-tests'");
    expect(out.stderr).toContain(path.join(config, "skills"));
    expect(fs.existsSync(path.join(t.home, "state", "sessions"))).toBe(false);
  });
});

// What `sc kinds` shows about a kind's skill and where the kind comes from.
describe("KindListingTests", () => {
  let t: ScTest;
  beforeEach(() => { t = new ScTest(); });
  afterEach(() => t.cleanup());

  async function line(name: string, out?: string): Promise<string> {
    out = out !== undefined ? out : (await t.sc(["kinds", "--runtime", "fake"])).stdout;
    return splitlines(out).filter((l) => l.startsWith(name + " "))[0]!;
  }

  it("a declared skill is shown and marked when missing", async () => {
    t.userKind("drafting", { extra: "skill: draft-it\n", body: "Run the `/draft-it` skill." });
    expect((await line("drafting")).endsWith("  skill: draft-it  [user]")).toBe(true);
    t.fakeSkills({ missing: ["draft-it"] });
    expect(await line("drafting")).toContain("skill: draft-it (not found in your skills)  [user]");
    expect(await line("general")).not.toContain("skill");
    // No working directory: only what every session gets is checked.
    expect(t.fakeState().skill_checks).toContainEqual(["draft-it", null]);
  });

  it("user kinds are marked and an override says so", async () => {
    t.userKind("triage");
    t.userKind("general", { body: "Mine." });
    expect((await line("triage")).endsWith("[user]")).toBe(true);
    expect((await line("general")).endsWith("[user, replaces core]")).toBe(true);
    expect((await line("investigate")).endsWith("]")).toBe(false);
  });

  it("a kind whose instructions never name its skill gets a warning", async () => {
    t.userKind("drafting", { extra: "skill: draft-it\n", body: "Run the `/draft-it` skill." });
    t.userKind("drifted", { extra: "skill: draft-it\n", body: "Run the `/old-name` skill." });
    const out = (await t.sc(["kinds", "--runtime", "fake"])).stdout;
    const warnings = splitlines(out).filter((l) => l.startsWith("  warning:"));
    expect(warnings).toEqual([`  warning: ${path.join(t.home, "kinds", "drifted.md")} declares the skill 'draft-it' ` +
      "but its instructions never name /draft-it; make them match"]);
  });

  it("a longer skill name in the instructions does not count", async () => {
    t.userKind("shaping", { extra: "skill: shape\n", body: "Run the `/shape-lite` skill." });
    t.userKind("namespaced", { extra: "skill: shape\n", body: "Run `/shape:deep`." });
    t.userKind("ends", { extra: "skill: shape\n", body: "Run /shape." });
    const out = (await t.sc(["kinds", "--runtime", "fake"])).stdout;
    expect(out).toContain("shaping.md declares the skill 'shape'");
    expect(out).toContain("namespaced.md declares the skill 'shape'");
    expect(out).not.toContain("ends.md");
  });

  it("the shipped kinds that declare a skill name it in their instructions", async () => {
    expect((await t.sc(["kinds", "--runtime", "fake"])).stdout).not.toContain("warning");
  });

  it("the claude runtime checks the user skills folder", async () => {
    const config = path.join(t.tmp, "claude-config");
    fs.mkdirSync(path.join(config, "skills", "draft-it"), { recursive: true });
    fs.writeFileSync(path.join(config, "skills", "draft-it", "SKILL.md"), "---\nname: draft-it\n---\nx\n");
    t.userKind("drafting", { extra: "skill: draft-it\n", body: "Run `/draft-it`." });
    t.userKind("missing", { extra: "skill: zz-no-such-skill-for-tests\n", body: "Run `/zz-no-such-skill-for-tests`." });
    const out = (await t.sc(["kinds", "--runtime", "claude-bg"], { env: { CLAUDE_CONFIG_DIR: config } })).stdout;
    expect(await line("drafting", out)).toContain("skill: draft-it  [user]");
    expect(await line("missing", out)).toContain("skill: zz-no-such-skill-for-tests (not found in your skills)");
  });
});

// When sous chef's data home is its code root (how the owner runs it: no SC_TEST_HOME),
// `sc kinds` lists each kind in kinds/ once and every one of them can be spawned.
describe("SameFolderKindsTests", () => {
  let t: CodeCopyTest;
  beforeEach(() => { t = new CodeCopyTest(); });
  afterEach(() => t.cleanup());

  it("each kind is listed once and spawns", async () => {
    fs.copyFileSync(path.join(t.home, "owner.json"), path.join(t.code, "owner.json"));
    const env = { SC_TEST_HOME: t.code };
    const shipped = fs.readdirSync(path.join(t.code, "kinds")).filter((f) => f.endsWith(".md"))
      .map((f) => path.parse(f).name).sort();
    const listed = splitlines((await t.copySc(["kinds", "--runtime", "fake"], { env })).stdout)
      .filter((l) => l && l[0] !== " ").map((l) => words(l)[0]);
    expect(listed).toEqual(shipped);
    expect((await t.copySc(["kinds", "--runtime", "fake"], { env })).stdout).not.toContain("[user");
    for (const name of shipped) {
      const out = await t.copySc(["spawn", "--kind", name, "--title", "t", "--cwd", t.work,
        "--runtime", "fake"], { stdin: "do it", env });
      const sid = words(out.stdout)[1]!;
      const record = readJson(path.join(t.code, "state", "sessions", sid, "record.json"));
      expect(record.kind).toBe(name);
    }
  });

  it("a refusal says to change the kind file when there is no separate user kinds folder", async () => {
    fs.copyFileSync(path.join(t.home, "owner.json"), path.join(t.code, "owner.json"));
    fs.writeFileSync(path.join(t.code, "kinds", "drafting.md"),
      "---\ndescription: d\nstarts_waiting_on: agent\nskill: draft-it\n---\nRun `/draft-it`.\n");
    fs.mkdirSync(path.join(t.code, "state"));
    fs.writeFileSync(path.join(t.code, "state", "fake-runtime.json"),
      JSON.stringify({ sessions: {}, wakes: [], missing_skills: ["draft-it"] }));
    const out = await t.copySc(["spawn", "--kind", "drafting", "--title", "t", "--cwd", t.work, "--runtime", "fake"],
      { stdin: "do it", env: { SC_TEST_HOME: t.code }, ok: false });
    expect(out.stderr).toMatch(/Install it, or change the kind file \S*\/code\/kinds\/drafting\.md\./);
    expect(out.stderr).not.toContain("add your own version");
  });
});

// A kind file may name the owner as `owner` or by name; it runs a copy of the code with its own kinds.
describe("OwnerKindTests", () => {
  let t: ScTest;
  let code: string;
  beforeEach(() => {
    t = new ScTest();
    code = copyCode(path.join(t.tmp, "code"), ROOT);
  });
  afterEach(() => t.cleanup());

  async function copySc(args: string[], o: { ok?: boolean } = {}): Promise<Out> {
    const out = await run(path.join(code, "bin", "sc"), args, { stdin: "do it", env: t.env() });
    if ((o.ok ?? true) && out.code !== 0) expect.fail(`sc ${args.join(" ")} failed: ${out.stdout}${out.stderr}`);
    return out;
  }

  it("starts waiting on takes the owners name", async () => {
    write(path.join(code, "kinds", "pair.md"),
      "---\ndescription: pair with {{owner}}\nstarts_waiting_on: Alex\n---\nWork with {{owner}}.\n");
    expect((await copySc(["kinds", "--runtime", "fake"])).stdout).toContain("pair           starts waiting on alex    pair with Alex");
    const out = await copySc(["spawn", "--kind", "pair", "--title", "t", "--cwd", t.work, "--runtime", "fake"]);
    const sid = words(out.stdout)[1]!;
    expect(JSON.parse(splitlines(read(path.join(t.home, "state", "sessions", sid, "events.jsonl")))[0]!)
      .waiting_on).toBe("owner");
    write(path.join(code, "kinds", "pair.md"), "---\nstarts_waiting_on: sam\n---\nx\n");
    expect((await copySc(["kinds", "--runtime", "fake"], { ok: false })).stderr)
      .toContain("starts_waiting_on must be owner or agent, not 'sam'");
  });
});
