// Behaviour tests for sc, run against the real command line with the fake runtime: installing
// (install.sh and `sc setup`), the owner's worker instructions in briefs, and finding the data
// folder through the `my` link.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodeCopyTest, type Env, git, GIT_ENV, type Out, read, readJson, ROOT, run, ScTest } from "./helpers.js";

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

/** Python's `str.index()`: fails when the text is not there. */
function pyIndex(text: string, sub: string): number {
  const i = text.indexOf(sub);
  if (i < 0) expect.fail(`substring not found: ${sub}`);
  return i;
}

function isSymlink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDir(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/** Python's `Path.rglob("*")`, files only, as a map of path to content. */
function filesUnder(dir: string, skip: (rel: string[]) => boolean): Map<string, Buffer> {
  const found = new Map<string, Buffer>();
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (isFile(full) && !skip(full.split(path.sep))) found.set(full, fs.readFileSync(full));
    }
  };
  walk(dir);
  return found;
}

// `install.sh` and `sc setup`, run from a copy of the core with every question answered by a flag.
describe("SetupTests", () => {
  let t: CodeCopyTest;
  let data: string;
  let bin: string;
  let stubs: string;
  let env: Env;
  beforeEach(() => {
    t = new CodeCopyTest();
    data = path.join(t.tmp, "data");
    bin = path.join(t.tmp, "localbin");
    stubs = path.join(t.tmp, "stubs");
    fs.mkdirSync(stubs);
    fs.writeFileSync(path.join(stubs, "claude"), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(stubs, "claude"), 0o755);
    env = { SC_TEST_HOME: "", ...GIT_ENV, PATH: `${stubs}:${process.env.PATH}` };
  });
  afterEach(() => t.cleanup());

  async function install(flags: string[] = [], o: { ok?: boolean; env?: Env } = {}): Promise<Out> {
    const args = ["--data", data, "--bin-dir", bin, "--yes", ...flags];
    const out = await run(path.join(t.code, "install.sh"), args, { env: { ...t.baseEnv, ...env, ...(o.env ?? {}) } });
    if ((o.ok ?? true) && out.code !== 0) expect.fail(`install.sh failed (${out.code}): ${out.stdout}${out.stderr}`);
    return out;
  }

  function g(folder: string, ...args: string[]): string {
    return git(folder, args, { env: GIT_ENV });
  }

  it("a new data folder in git gets starter files links and one commit", async () => {
    const out = (await install(["--name", "Sam", "--branch-prefix", "sam/", "--git"])).stdout;
    expect(out).toContain("made a new data folder");
    expect(fs.readlinkSync(path.join(t.code, "my"))).toBe(data);
    expect(readJson(path.join(data, "owner.json"))).toEqual({ name: "Sam", branch_prefix: "sam/", chef_permissions: "auto" });
    expect(out).toContain("sous chef's own session will start in permission mode auto");
    for (const rel of ["memory/focus.md", "memory/threads/index.md", "memory/working-with-sam.md",
      "instructions.md", "worker-instructions.md", ".gitignore"]) {
      expect(isFile(path.join(data, rel)), rel).toBe(true);
    }
    expect(isDir(path.join(data, "cron")) && isDir(path.join(data, "kinds"))).toBe(true);
    expect(splitlines(g(data, "log", "--oneline")).length).toBe(1);
    expect(fs.readlinkSync(path.join(bin, "sc"))).toBe(path.join(fs.realpathSync(t.code), "bin", "sc"));
    expect(fs.readlinkSync(path.join(bin, "souschef"))).toBe(path.join(fs.realpathSync(t.code), "bin", "souschef"));
    const settings = readJson(path.join(t.code, ".agents", "settings.local.json"));
    expect(settings.permissions.additionalDirectories).toEqual([fs.realpathSync(data)]);
    // The installed sous chef runs on it: the summary opens with the owner and their instructions.
    const summary = (await t.copySc(["summary"], { env })).stdout;
    expect(summary.startsWith("Owner: Sam. Branch prefix: sam/.")).toBe(true);
    expect(summary).toContain("- My feedback on how you work is in `my/memory/working-with-sam.md`.");
    expect(summary).not.toContain("<!--");
    fs.mkdirSync(path.join(data, "state"), { recursive: true });
    fs.writeFileSync(path.join(data, "state", "x.json"), "{}");
    fs.writeFileSync(path.join(data, ".env"), "SC_RELAY_KEY=secret\n");
    expect(g(data, "status", "--porcelain")).toBe("");
    // A starter worker-instructions.md holds only a comment, so briefs leave the section out.
    const sid = words((await t.copySc(["spawn", "--kind", "general", "--title", "t", "--cwd", t.work, "--runtime",
      "fake"], { stdin: "do it", env })).stdout)[1]!;
    expect(read(path.join(data, "state", "sessions", sid, "brief.md"))).not.toContain("Instructions from your owner");
  });

  it("a new data folder without git", async () => {
    await install(["--name", "Sam", "--branch-prefix", "", "--no-git"]);
    expect(fs.existsSync(path.join(data, ".git"))).toBe(false);
    expect(isFile(path.join(data, "memory", "focus.md"))).toBe(true);
  });

  it("a new folder needs an owner name when nothing can be asked", async () => {
    const out = await install(["--no-git"], { ok: false });
    expect(out.stderr).toContain("pass --name");
    expect(isSymlink(path.join(t.code, "my"))).toBe(false);
  });

  it("an existing data folder is used as it is", async () => {
    fs.mkdirSync(path.join(data, "memory"), { recursive: true });
    fs.writeFileSync(path.join(data, "memory", "focus.md"), "mine\n");
    fs.writeFileSync(path.join(data, "owner.json"), JSON.stringify({ name: "Kim", branch_prefix: "kim/" }));
    const out = (await install(["--name", "Other"])).stdout;
    expect(out).toContain("using the data folder");
    expect(readJson(path.join(data, "owner.json"))).toEqual({ name: "Kim", branch_prefix: "kim/" });
    expect(fs.existsSync(path.join(data, "instructions.md"))).toBe(false);
    expect(read(path.join(data, "memory", "focus.md"))).toBe("mine\n");
    expect(fs.readlinkSync(path.join(t.code, "my"))).toBe(data);
  });

  it("sous chef's own permission mode is the flag's, else auto, and an existing one is kept", async () => {
    await install(["--name", "Sam", "--no-git", "--chef-permissions", "bypass"]);
    expect(readJson(path.join(data, "owner.json")).chef_permissions).toBe("bypass");
    const out = (await install(["--chef-permissions", "auto"])).stdout;
    expect(out).toContain("left sous chef's own permission mode at bypass; change it with sc owner set");
    expect(readJson(path.join(data, "owner.json")).chef_permissions).toBe("bypass");
  });

  it("an existing data folder without a permission mode gets the flag's", async () => {
    fs.mkdirSync(path.join(data, "memory"), { recursive: true });
    fs.writeFileSync(path.join(data, "owner.json"), JSON.stringify({ name: "Kim", branch_prefix: "kim/" }));
    await install(["--chef-permissions", "bypass"]);
    expect(readJson(path.join(data, "owner.json"))).toEqual({ name: "Kim", branch_prefix: "kim/", chef_permissions: "bypass" });
  });

  it("an sc or souschef link to something else is left alone", async () => {
    fs.mkdirSync(bin, { recursive: true });
    const other = path.join(t.tmp, "other-tool", "sc");
    fs.mkdirSync(path.dirname(other));
    fs.writeFileSync(other, "#!/bin/sh\n", { mode: 0o755 });
    fs.symlinkSync(other, path.join(bin, "sc"));
    const out = (await install(["--name", "Sam", "--no-git"])).stdout;
    expect(out).toContain(`left ${path.join(bin, "sc")} alone: it points to ${other}, not this sous chef`);
    expect(fs.readlinkSync(path.join(bin, "sc"))).toBe(other);
    expect(fs.readlinkSync(path.join(bin, "souschef"))).toBe(path.join(fs.realpathSync(t.code), "bin", "souschef"));
  });

  it("an sc link to something that no longer exists is replaced", async () => {
    fs.mkdirSync(bin, { recursive: true });
    fs.symlinkSync(path.join(t.tmp, "moved", "bin", "sc"), path.join(bin, "sc"));
    const out = (await install(["--name", "Sam", "--no-git"])).stdout;
    expect(out).toContain(`replaced ${path.join(bin, "sc")}`);
    expect(fs.readlinkSync(path.join(bin, "sc"))).toBe(path.join(fs.realpathSync(t.code), "bin", "sc"));
  });

  it("a data folder cloned from a repo keeps its owner", async () => {
    const src = path.join(t.tmp, "src");
    const bare = path.join(t.tmp, "data.git");
    fs.mkdirSync(path.join(src, "memory"), { recursive: true });
    fs.writeFileSync(path.join(src, "owner.json"), JSON.stringify({ name: "Kim", branch_prefix: "kim/" }));
    fs.writeFileSync(path.join(src, "memory", "focus.md"), "cloned\n");
    g(src, "init", "-q", "-b", "main");
    g(src, "add", "-A");
    g(src, "commit", "-qm", "data");
    g(t.tmp, "clone", "-q", "--bare", src, bare);
    const out = (await install(["--clone", bare])).stdout;
    expect(out).toContain(`cloned ${bare}`);
    expect(read(path.join(data, "memory", "focus.md"))).toBe("cloned\n");
    expect((await t.copySc(["summary"], { env })).stdout).toContain("Owner: Kim.");
  });

  it("a new git data folder can be pushed to an empty repo", async () => {
    const bare = path.join(t.tmp, "empty.git");
    g(t.tmp, "init", "-q", "--bare", bare);
    await install(["--name", "Sam", "--git", "--push-url", bare]);
    expect(g(bare, "log", "--oneline", "main").split("\n").length - 1).toBe(1);
    expect(g(data, "rev-parse", "--abbrev-ref", "@{upstream}").trim()).toBe("origin/main");
  });

  it("a folder inside another repo is never pushed as that repo", async () => {
    const outer = path.join(t.tmp, "notes");
    const bare = path.join(t.tmp, "empty.git");
    g(t.tmp, "init", "-q", "--bare", bare);
    fs.mkdirSync(path.dirname(path.join(outer, "private.txt")));
    fs.writeFileSync(path.join(outer, "private.txt"), "not for the data repo\n");
    g(outer, "init", "-q", "-b", "main");
    g(outer, "add", "-A");
    g(outer, "commit", "-qm", "outer");
    data = path.join(outer, "sous-chef-data");
    fs.mkdirSync(path.join(data, "memory"), { recursive: true });
    fs.writeFileSync(path.join(data, "owner.json"), JSON.stringify({ name: "Kim", branch_prefix: "kim/" }));
    await install(["--push-url", bare]);
    expect(g(outer, "remote")).toBe("");
    expect(g(bare, "for-each-ref")).toBe("");
  });

  it("running it again changes nothing", async () => {
    await install(["--name", "Sam", "--git"]);
    const skipGit = (parts: string[]): boolean => parts.includes(".git");
    const before = filesUnder(data, skipGit);
    const out = (await install()).stdout;
    expect(out).toContain("using the data folder");
    expect(out).not.toContain("linked");
    expect(filesUnder(data, skipGit)).toEqual(before);
    expect(splitlines(g(data, "log", "--oneline")).length).toBe(1);
  });

  it("a link that points somewhere else is refused and left alone", async () => {
    const other = path.join(t.tmp, "other");
    fs.mkdirSync(other);
    fs.symlinkSync(other, path.join(t.code, "my"));
    const out = await install(["--name", "Sam"], { ok: false });
    expect(out.stderr).toContain(`already points to ${other}`);
    expect(fs.readlinkSync(path.join(t.code, "my"))).toBe(other);
    expect(fs.existsSync(data)).toBe(false);
  });

  it("install names the tools it cannot find", async () => {
    // The real PATH, with every folder holding a claude swapped for links to everything else in it.
    const folders: string[] = [];
    (process.env.PATH ?? "").split(path.delimiter).forEach((entry, n) => {
      let folder = entry;
      if (folder && fs.existsSync(path.join(folder, "claude"))) {
        const tools = path.join(t.tmp, `tools-${n}`);
        fs.mkdirSync(tools);
        for (const name of fs.readdirSync(folder)) {
          if (name !== "claude") fs.symlinkSync(path.join(folder, name), path.join(tools, name));
        }
        folder = tools;
      }
      folders.push(folder);
    });
    const out = await install(["--name", "Sam"], { ok: false, env: { PATH: folders.join(path.delimiter) } });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("not found on your PATH: claude");
    expect(isSymlink(path.join(t.code, "my"))).toBe(false);
  });

  it("the owner file is kept by the data folder and ignored by the core", async () => {
    expect(words(read(path.join(ROOT, ".gitignore")))).toContain("/owner.json");
    await install(["--name", "Sam"]);
    expect(read(path.join(data, ".gitignore"))).not.toContain("owner.json");
  });

  it("env is gitignored in the core and in a new data folder", async () => {
    expect(words(read(path.join(ROOT, ".gitignore")))).toContain("/.env");
    await install(["--name", "Sam"]);
    expect(words(read(path.join(data, ".gitignore")))).toContain(".env");
  });
});

// worker-instructions.md in the data folder reaches every session's brief, between the kind's
// instructions and the task; with no file, or an empty one, the section is left out.
describe("OwnerInstructionsTests", () => {
  let t: ScTest;
  beforeEach(() => { t = new ScTest(); });
  afterEach(() => t.cleanup());

  function brief(sid: string): string {
    return read(path.join(t.home, "state", "sessions", sid, "brief.md"));
  }

  it("the file is added before the task as written", async () => {
    fs.writeFileSync(path.join(t.home, "worker-instructions.md"), "Ask before writing to the tracker. {{owner}} {{task}}\n");
    const b = brief(await t.spawn("general", "Test task", "the task"));
    const section = "## Instructions from your owner\n\nAsk before writing to the tracker. {{owner}} {{task}}\n\n## Task";
    expect(b).toContain(section);
    expect(pyIndex(b, "## Instructions for this kind of session")).toBeLessThan(pyIndex(b, section));
    expect(b.endsWith("## Task\n\nthe task\n")).toBe(true);
  });

  it("no file or an empty one leaves the section out", async () => {
    const without = brief(await t.spawn());
    fs.writeFileSync(path.join(t.home, "worker-instructions.md"), "\n  \n");
    const empty = brief(await t.spawn());
    for (const b of [without, empty]) {
      expect(b).not.toContain("Instructions from your owner");
      expect(b).not.toContain("{{");
      expect(b).not.toContain("\n\n\n");
    }
  });

  it("a cron launched session gets it too", async () => {
    fs.writeFileSync(path.join(t.home, "worker-instructions.md"), "Owner rule for every session.\n");
    await t.registerChef();
    await t.sc(["cron", "add", "scan", "--every", "6h", "--target", "worker", "--kind", "general",
      "--cwd", t.work, "--runtime", "fake"], { stdin: "scan it" });
    await t.sc(["cron", "run", "scan"]);
    const sids = splitlines((await t.sc(["sessions"])).stdout).filter((l) => l.startsWith("- ")).map((l) => words(l)[1]!);
    expect(sids).toHaveLength(1);
    expect(brief(sids[0]!)).toContain("## Instructions from your owner\n\nOwner rule for every session.");
  });
});

// Without SC_TEST_HOME, sous chef finds the owner's data through the `my` link in the code folder,
// and refuses, saying what to run, when the link is missing or broken.
describe("DataLinkTests", () => {
  let t: CodeCopyTest;
  let data: string;
  let env: Env;
  beforeEach(() => {
    t = new CodeCopyTest();
    data = t.home; // the test home is set up like a data folder (owner.json)
    env = { SC_TEST_HOME: "" };
  });
  afterEach(() => t.cleanup());

  function link(target?: string): void {
    fs.symlinkSync(target || data, path.join(t.code, "my"));
  }

  it("the link is used and paths go through it", async () => {
    link();
    expect((await t.copySc(["owner"], { env })).stdout).toContain("Alex");
    const out = await t.copySc(["spawn", "--kind", "general", "--title", "t", "--cwd", t.work,
      "--runtime", "fake"], { stdin: "do it", env });
    const sid = words(out.stdout)[1]!;
    expect(isFile(path.join(data, "state", "sessions", sid, "brief.md"))).toBe(true);
    const brief = read(path.join(data, "state", "sessions", sid, "brief.md"));
    expect(brief).toContain(`${t.code}/my/state/sessions/${sid}/report.md`);
    expect(fs.existsSync(path.join(t.code, "state"))).toBe(false);
  });

  it("a broken link is refused naming its target", async () => {
    link(path.join(t.tmp, "gone"));
    const out = await t.copySc(["sessions"], { env, ok: false });
    expect(out.stderr).toContain(`points to ${path.join(t.tmp, "gone")}, which does not exist`);
    expect(fs.existsSync(path.join(t.tmp, "gone"))).toBe(false);
  });

  it("no link says to run the install", async () => {
    const out = await t.copySc(["sessions"], { env, ok: false });
    expect(out.stderr).toContain(`no data folder: run ${fs.realpathSync(t.code)}/install.sh`);
    expect(fs.existsSync(path.join(t.code, "state"))).toBe(false);
  });

  it("help and the hooks work without a data folder", async () => {
    expect((await t.copySc(["--help"], { env })).stdout).toContain("usage");
    let out = await t.copySc(["hook", "chef-start"], { stdin: JSON.stringify({ session_id: "c", source: "startup" }),
      env: { ...env, SC_WATCH_DISABLE_ENSURE: "1" } });
    const ctx = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain("no data folder");
    expect(ctx).not.toContain("SOUS CHEF STARTUP SUMMARY");
    const guarded = JSON.stringify({ tool_input: { file_path: path.join(t.code, "state", "chef.json") } });
    out = await t.copySc(["hook", "guard-edit"], { stdin: guarded, env });
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect((await t.copySc(["hook", "chef-stop"], { stdin: "{}", env })).stdout).toBe("");
  });

  it("the guard protects state through the link", async () => {
    link();
    for (const target of [path.join(t.code, "my", "state", "chef.json"), path.join(data, "state", "chef.json")]) {
      const out = (await t.copySc(["hook", "guard-edit"], { stdin: JSON.stringify({ tool_input: { file_path: target } }),
        env })).stdout;
      expect(JSON.parse(out).hookSpecificOutput.permissionDecision, target).toBe("deny");
    }
  });

  it("souschef says to run the install", async () => {
    const out = await run(path.join(t.code, "bin", "souschef"), ["--print"], { env: { ...t.baseEnv, ...env } });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain(`no data folder: run ${fs.realpathSync(t.code)}/install.sh`);
  });

  it("a session may not run in the data folder", async () => {
    link();
    const out = await t.copySc(["spawn", "--kind", "general", "--title", "t", "--cwd", data,
      "--runtime", "fake"], { stdin: "do it", env, ok: false });
    expect(out.stderr).toContain("cannot run inside the sous chef data folder");
  });
});
