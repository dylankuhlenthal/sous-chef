// The launchers' build check (bin/sc, bin/souschef; docs/decisions/0023): a copy of the
// built core is run after making its build missing or stale, and must refuse with the fix
// to run, exit 1 (never 2), except at `hook chef-start`, which says it to sous chef.
// Needs a build: `npm run build` first (npm test does).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");

/** A Node 20 from nvm, if this machine has one: Node 20 can run the launcher, older ones cannot load it. */
function oldNode(): string | null {
  const nvm = path.join(os.homedir(), ".nvm", "versions", "node");
  const v20 = fs.existsSync(nvm) ? fs.readdirSync(nvm).filter((v) => v.startsWith("v20.")).sort() : [];
  return v20.length ? path.join(nvm, v20[v20.length - 1]!, "bin", "node") : null;
}
let tmp: string;
let core: string;

beforeEach(() => {
  if (!fs.existsSync(path.join(ROOT, "dist", ".build-stamp"))) throw new Error("no build: run npm run build first");
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-"));
  core = path.join(fs.realpathSync(tmp), "core");
  for (const part of ["bin", "src", "dist", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json"]) {
    fs.cpSync(path.join(ROOT, part), path.join(core, part), { recursive: true, preserveTimestamps: true });
  }
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(core, "node_modules"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(program: "sc" | "souschef", ...args: string[]) {
  const r = spawnSync(path.join(core, "bin", program), args, { encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Give a file a modification time a minute after the stamp's, as a pull would. */
function touchLater(rel: string): void {
  const later = new Date(fs.statSync(path.join(core, "dist", ".build-stamp")).mtimeMs + 60_000);
  fs.utimesSync(path.join(core, rel), later, later);
}

describe("the launchers", () => {
  it("run a complete build", () => {
    const r = run("sc", "--help");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^usage: sc /);
    expect(run("souschef", "--help").code).toBe(0);
  });

  it("refuse without dist/", () => {
    fs.rmSync(path.join(core, "dist"), { recursive: true });
    const r = run("sc", "--help");
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`sc: ${core} has no build (dist/ is missing); run: cd ${core} && npm ci && npm run build\n`);
  });

  it("refuse a build that did not finish (no stamp)", () => {
    fs.rmSync(path.join(core, "dist", ".build-stamp"));
    const r = run("sc", "--help");
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`sc: ${core} has no build (dist/.build-stamp is missing, so the last build did not finish); ` +
      `run: cd ${core} && npm ci && npm run build\n`);
  });

  it("refuse a build older than a changed source file, naming it", () => {
    fs.appendFileSync(path.join(core, "src", "main.ts"), "\n// changed\n");
    touchLater("src/main.ts");
    const r = run("sc", "--help");
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`sc: the build in ${core}/dist is older than the source (src/main.ts); ` +
      `run: cd ${core} && npm run build\n`);
    const s = run("souschef", "--help");
    expect(s.code).toBe(1);
    expect(s.stderr).toMatch(/^souschef: the build in .* is older than the source \(src\/main\.ts\)/);
  });

  it("refuse a changed tsconfig", () => {
    fs.appendFileSync(path.join(core, "tsconfig.build.json"), "\n");
    touchLater("tsconfig.build.json");
    expect(run("sc", "--help").stderr).toContain("older than the source (tsconfig.build.json)");
  });

  it("run when a source file only has a newer time, as after a fresh checkout", () => {
    touchLater("src/main.ts");
    touchLater("tsconfig.json");
    expect(run("sc", "--help").code).toBe(0);
  });

  it("refuse dependencies older than a changed package-lock.json", () => {
    fs.appendFileSync(path.join(core, "package-lock.json"), "\n");
    touchLater("package-lock.json");
    const r = run("sc", "--help");
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`sc: the dependencies in ${core}/node_modules are older than package-lock.json; ` +
      `run: cd ${core} && npm ci && npm run build\n`);
  });

  it("run when package-lock.json only has a newer time", () => {
    touchLater("package-lock.json");
    expect(run("sc", "--help").code).toBe(0);
  });

  /** `npm run build` in the copy, as after a checkout; the dependencies are the checkout's own, linked. */
  function rebuild(): void {
    fs.cpSync(path.join(ROOT, "scripts"), path.join(core, "scripts"), { recursive: true, preserveTimestamps: true });
    const r = spawnSync("npm", ["run", "build"], { cwd: core, encoding: "utf8", timeout: 120_000 });
    if (r.status !== 0) throw new Error(`npm run build failed: ${r.stdout}${r.stderr}`);
  }

  it("run after a rebuild when package-lock.json only has a newer time, as after a checkout", () => {
    touchLater("package-lock.json");
    rebuild();
    const stamp = JSON.parse(fs.readFileSync(path.join(core, "dist", ".build-stamp"), "utf8")) as { lock: string | null };
    expect(stamp.lock).toMatch(/^[0-9a-f]{40}$/);
    expect(run("sc", "--help").code).toBe(0);
  }, 180_000);

  it("refuse after a rebuild when package-lock.json changed and npm ci has not run", () => {
    const lockFile = path.join(core, "package-lock.json");
    const lock = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { packages: Record<string, { version: string }> };
    lock.packages["node_modules/proper-lockfile"]!.version = "4.1.1";
    fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + "\n");
    touchLater("package-lock.json");
    rebuild();
    const r = run("sc", "--help");
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`sc: the dependencies in ${core}/node_modules are older than package-lock.json; ` +
      `run: cd ${core} && npm ci && npm run build\n`);
  }, 180_000);

  it("refuse after a rebuild when a root dependency was added to package-lock.json, optional or not, and npm ci has not run", () => {
    const lockFile = path.join(core, "package-lock.json");
    const original = fs.readFileSync(lockFile, "utf8");
    type Lock = { packages: Record<string, Record<string, unknown>> };
    const refusal = `sc: the dependencies in ${core}/node_modules are older than package-lock.json; ` +
      `run: cd ${core} && npm ci && npm run build\n`;
    // An optional dependency this machine would install, with its package entry.
    const optional = JSON.parse(original) as Lock;
    optional.packages[""]!.optionalDependencies = { "left-pad": "^1.3.0" };
    optional.packages["node_modules/left-pad"] = { version: "1.3.0", optional: true, license: "WTFPL",
      resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      integrity: "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQEXQo6fh7Ri78DaaM7ffbOBR95ebdC7/QTGv8JC0nIHhjJw==" };
    fs.writeFileSync(lockFile, JSON.stringify(optional, null, 2) + "\n");
    touchLater("package-lock.json");
    rebuild();
    expect(run("sc", "--help").stderr).toBe(refusal);
    // Only the root entry names it (the dependency is already installed elsewhere in the tree).
    const rootOnly = JSON.parse(original) as Lock;
    rootOnly.packages[""]!.devDependencies = { ...(rootOnly.packages[""]!.devDependencies as object), "no-such-dep": "^1.0.0" };
    fs.writeFileSync(lockFile, JSON.stringify(rootOnly, null, 2) + "\n");
    touchLater("package-lock.json");
    rebuild();
    expect(run("sc", "--help").stderr).toBe(refusal);
  }, 240_000);

  it("say what is wrong to sous chef at hook chef-start, exiting 0", () => {
    fs.rmSync(path.join(core, "dist", ".build-stamp"));
    const r = run("sc", "hook", "chef-start");
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toBe(`Sous chef cannot start: ${core} has no build ` +
      `(dist/.build-stamp is missing, so the last build did not finish); run: cd ${core} && npm ci && npm run build. ` +
      "Tell the person you are working with, and do nothing as sous chef until it is fixed.");
    expect(r.stdout).toMatch(/^\{"hookSpecificOutput": \{"hookEventName": "SessionStart", "additionalContext": /);
  });

  it.skipIf(oldNode() === null)("refuse Node older than 22", () => {
    const node = oldNode()!;
    const r = spawnSync(node, [path.join(core, "bin", "sc"), "--help"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^sc: sous chef needs Node 22 or later; this is Node v20\.\S+ at \S+\n$/);
  });

  it.skipIf(oldNode() === null)("say Node older than 22 to sous chef at hook chef-start, exiting 0", () => {
    const node = oldNode()!;
    const r = spawnSync(node, [path.join(core, "bin", "sc"), "hook", "chef-start"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toMatch(new RegExp("^Sous chef cannot start: sous chef needs " +
      "Node 22 or later; this is Node v20\\.\\S+ at \\S+\\. Tell the person you are working with, and do nothing " +
      "as sous chef until it is fixed\\.$"));
  });

  it("refuse other hooks with exit 1, never 2", () => {
    fs.rmSync(path.join(core, "dist", ".build-stamp"));
    const r = run("sc", "hook", "guard-edit");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("has no build");
  });
});
