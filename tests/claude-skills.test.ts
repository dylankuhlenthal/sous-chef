// The Claude runtime's skill check (src/runtimes/claude-skills.ts), against a temporary folder tree.
//
// Each test builds the folders Claude Code reads skills from (a config folder standing in
// for ~/.claude, a managed folder, a repo with a project folder inside) and asks whether a
// skill is there. Nothing here runs Claude Code; docs/domains/sessions.md says what was
// checked against Claude Code itself. Ported one for one from tests/test_claude_skills.py,
// which tests the Python runtime and runs only when the sc under test is the Python one.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { skillAvailable, skillPlaces } from "../src/runtimes/claude-skills.js";

let tmp: string;
let base: string;
let config: string;
let managed: string;
let repo: string;
let project: string;
let outside: string;
let savedConfig: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skills-"));
  base = fs.realpathSync(tmp);
  config = path.join(base, "config");
  managed = path.join(base, "managed");
  repo = path.join(base, "repo");
  project = path.join(repo, "packages", "app");
  outside = path.join(base, "outside");
  for (const d of [config, managed, project, outside]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(repo, ".git"));
  savedConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
});

afterEach(() => {
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function skill(skillsDir: string, folder: string, name?: string): void {
  const p = path.join(skillsDir, folder, "SKILL.md");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `---\n${name ? `name: ${name}\n` : ""}description: a test skill\n---\nDo it.\n`);
}

function available(name: string, cwd?: string): boolean | null {
  return skillAvailable(name, cwd ?? null, managed);
}

function git(...args: string[]): void {
  execFileSync("git", args, { stdio: "ignore" });
}

describe("skillAvailable", () => {
  it("finds a user skill with or without a cwd", () => {
    skill(path.join(config, "skills"), "build");
    expect(available("build")).toBe(true);
    expect(available("build", outside)).toBe(true);
    expect(available("shape")).toBe(false);
  });

  it("follows a user skills folder that is a symlink", () => {
    const real = path.join(tmp, "agents-skills");
    skill(real, "build");
    fs.symlinkSync(real, path.join(config, "skills"));
    expect(available("build")).toBe(true);
  });

  it("finds a skill synced from claude.ai by its plain name", () => {
    skill(path.join(config, "skills", "synced", "org-123"), "docx");
    expect(available("docx")).toBe(true);
  });

  it("counts a front matter name as well as the folder name", () => {
    skill(path.join(config, "skills"), "deploy-staging", "deploy");
    expect(available("deploy")).toBe(true);
    expect(available("deploy-staging")).toBe(true);
  });

  it("finds a project skill only with a cwd in that project", () => {
    skill(path.join(project, ".claude", "skills"), "local-only");
    expect(available("local-only", project)).toBe(true);
    expect(available("local-only")).toBe(false);
    expect(available("local-only", outside)).toBe(false);
  });

  it("finds a skill in a parent up to the repo root", () => {
    skill(path.join(repo, ".claude", "skills"), "root-skill");
    expect(available("root-skill", project)).toBe(true);
  });

  it("does not find a skill above the repo root", () => {
    skill(path.join(tmp, ".claude", "skills"), "above-repo");
    expect(available("above-repo", project)).toBe(false);
    // Outside any repo, every parent counts.
    expect(available("above-repo", outside)).toBe(true);
  });

  it("gives a linked worktree without skills the main checkout's", () => {
    skill(path.join(repo, ".claude", "skills"), "main-skill");
    git("init", "-q", "-b", "main", repo);
    git("-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    const wt = path.join(tmp, "wt");
    git("-C", repo, "worktree", "add", "-q", wt, "-b", "x");
    expect(available("main-skill", wt)).toBe(true);
    // With its own .claude/skills, the worktree no longer gets the main checkout's.
    skill(path.join(wt, ".claude", "skills"), "wt-skill");
    expect(available("main-skill", wt)).toBe(false);
    expect(available("wt-skill", wt)).toBe(true);
  });

  it("finds a managed skill", () => {
    skill(path.join(managed, ".claude", "skills"), "policy-skill");
    expect(available("policy-skill")).toBe(true);
  });

  it("finds installed and synced plugin skills", () => {
    const plugin = path.join(config, "plugins", "cache", "market", "tools", "1.0.0");
    skill(path.join(plugin, "skills"), "from-cache");
    const elsewhere = path.join(tmp, "installed-elsewhere");
    skill(path.join(elsewhere, "skills"), "from-install-path");
    fs.writeFileSync(path.join(config, "plugins", "installed_plugins.json"), JSON.stringify(
      { version: 2, plugins: { "x@y": [{ scope: "user", installPath: elsewhere }] } }));
    skill(path.join(config, "plugins", "synced", "org_1", "helpers~g2", "skills"), "from-synced");
    for (const name of ["from-cache", "from-install-path", "from-synced"]) {
      expect(available(name), name).toBe(true);
    }
  });

  it("does not count a plugin that is only in a marketplace as installed", () => {
    skill(path.join(config, "plugins", "marketplaces", "official", "plugins", "p", "skills"), "not-installed");
    expect(available("not-installed")).toBe(false);
  });

  it("finds legacy commands", () => {
    fs.mkdirSync(path.join(config, "commands"));
    fs.writeFileSync(path.join(config, "commands", "user-cmd.md"), "Do it.\n");
    fs.mkdirSync(path.join(repo, ".claude", "commands"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".claude", "commands", "project-cmd.md"), "Do it.\n");
    expect(available("user-cmd")).toBe(true);
    expect(available("project-cmd", project)).toBe(true);
    expect(available("project-cmd")).toBe(false);
  });

  it("cannot tell for a name with a colon or slash", () => {
    skill(path.join(config, "skills"), "docx");
    for (const name of ["anthropic-skills:docx", "plugin:skill", "apps/web:deploy", "a/b", ""]) {
      expect(available(name), name).toBeNull();
    }
  });
});

describe("skillPlaces", () => {
  it("names the project in a refusal", () => {
    const places = skillPlaces(project, managed);
    expect(places).toContain(path.join(config, "skills"));
    expect(places).toContain(path.join(project, ".claude", "skills"));
    expect(places).toContain(path.join(repo, ".claude", "skills"));
    expect(skillPlaces(null, managed)).not.toContain(path.join(project, ".claude", "skills"));
  });
});
