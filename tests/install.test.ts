// install.sh bringing an install up to date: `npm ci` when the dependencies are missing or
// out of date, `npm run build` when the build is missing or stale; and, piped from the web
// (not run from a core checkout), cloning the core first. npm is a stub that only records
// how it was called, so nothing is installed or built.
// Needs a build: `npm run build` first (npm test does).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
let tmp: string;
let core: string;
let stubs: string;

beforeEach(() => {
  if (!fs.existsSync(path.join(ROOT, "dist", ".build-stamp"))) throw new Error("no build: run npm run build first");
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "install-")));
  core = path.join(tmp, "core");
  for (const part of ["bin", "src", "dist", "install.sh", "package.json", "package-lock.json", "tsconfig.json",
    "tsconfig.build.json"]) {
    fs.cpSync(path.join(ROOT, part), path.join(core, part), { recursive: true, preserveTimestamps: true });
  }
  // Installed dependencies, as npm ci leaves them: only the file the checks read.
  fs.mkdirSync(path.join(core, "node_modules"));
  fs.writeFileSync(path.join(core, "node_modules", ".package-lock.json"), "{}\n");
  const installed = new Date(fs.statSync(path.join(core, "package-lock.json")).mtimeMs + 1000);
  fs.utimesSync(path.join(core, "node_modules", ".package-lock.json"), installed, installed);
  stubs = path.join(tmp, "stubs");
  fs.mkdirSync(stubs);
  fs.writeFileSync(path.join(stubs, "npm"), `#!/bin/sh\necho "$@" >> "${path.join(tmp, "npm.log")}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(stubs, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function install(): string[] {
  spawnSync(path.join(core, "install.sh"), ["--yes"], {
    encoding: "utf8",
    env: { HOME: tmp, PATH: [stubs, path.dirname(process.execPath), "/usr/bin", "/bin"].join(":") },
  });
  const log = path.join(tmp, "npm.log");
  return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
}

/** A pull that changed package-lock.json: new content, a later time than the installed dependencies. */
function changeLock(): void {
  fs.appendFileSync(path.join(core, "package-lock.json"), "\n");
  const later = new Date(fs.statSync(path.join(core, "node_modules", ".package-lock.json")).mtimeMs + 60_000);
  fs.utimesSync(path.join(core, "package-lock.json"), later, later);
}

describe("install.sh", () => {
  it("reinstalls after an interrupted build when a pull also changed package-lock.json", () => {
    fs.rmSync(path.join(core, "dist", ".build-stamp"));
    changeLock();
    expect(install()).toEqual(["ci", "run build"]);
  });

  it("reinstalls when dist/ is missing and package-lock.json changed", () => {
    fs.rmSync(path.join(core, "dist"), { recursive: true });
    changeLock();
    expect(install()).toEqual(["ci", "run build"]);
  });

  it("only builds after an interrupted build when the dependencies are current", () => {
    fs.rmSync(path.join(core, "dist", ".build-stamp"));
    expect(install()).toEqual(["run build"]);
  });

  it("installs when the dependencies are missing", () => {
    fs.rmSync(path.join(core, "node_modules"), { recursive: true });
    expect(install()).toEqual(["ci", "run build"]);
  });

  it("does neither for an install that is up to date", () => {
    fs.rmSync(path.join(core, "node_modules"), { recursive: true });
    fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(core, "node_modules"));
    expect(install()).toEqual([]);
  });
});

// `curl ... | bash`: the script arrives on stdin, so $0 is the shell, not install.sh.
describe("install.sh piped", () => {
  let dir: string;
  beforeEach(() => {
    // The core as a git repo with a main branch, standing in for GitHub; node_modules is not tracked.
    fs.writeFileSync(path.join(core, ".gitignore"), "node_modules/\n");
    for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@example.com",
      "commit", "-qm", "core"]]) {
      expect(spawnSync("git", ["-C", core, ...args]).status).toBe(0);
    }
    dir = path.join(tmp, "home", ".sous-chef");
  });

  function piped(env: Record<string, string> = {}) {
    return spawnSync("bash", ["-s", "--", "--yes"], {
      encoding: "utf8", cwd: tmp, input: fs.readFileSync(path.join(core, "install.sh"), "utf8"),
      env: { HOME: path.join(tmp, "home"), SOUS_CHEF_REPO: core,
        PATH: [stubs, path.dirname(process.execPath), "/usr/bin", "/bin"].join(":"), ...env },
    });
  }

  function npmLog(): string[] {
    const log = path.join(tmp, "npm.log");
    return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
  }

  it("clones the core into ~/.sous-chef and runs the clone's own install.sh", () => {
    const out = piped();
    expect(out.stdout).toContain(`cloning ${core} into ${dir}`);
    expect(fs.existsSync(path.join(dir, "bin", "sc"))).toBe(true);
    expect(spawnSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).stdout.trim()).toBe("main");
    // The clone has no node_modules, so its install.sh installs and builds there.
    expect(out.stdout).toContain("using Node");
    expect(npmLog()).toEqual(["ci", "run build"]);
  });

  it("clones into SOUS_CHEF_DIR when it is set", () => {
    const other = path.join(tmp, "elsewhere");
    piped({ SOUS_CHEF_DIR: other });
    expect(fs.existsSync(path.join(other, "install.sh"))).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("uses a core already there as it is, without updating it", () => {
    expect(spawnSync("git", ["clone", "-q", core, dir]).status).toBe(0);
    fs.writeFileSync(path.join(dir, "marker"), "mine\n");
    const out = piped();
    expect(out.stdout).toContain(`using the sous chef core already at ${dir} (not updated`);
    expect(out.stdout).not.toContain("cloning");
    expect(fs.readFileSync(path.join(dir, "marker"), "utf8")).toBe("mine\n");
    expect(npmLog()).toEqual(["ci", "run build"]);
  });

  it("refuses a folder there that is not a sous chef core and leaves it alone", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "notes.txt"), "not sous chef\n");
    const out = piped();
    expect(out.status).toBe(1);
    expect(out.stderr).toContain(`${dir} exists and is not a sous chef core`);
    expect(fs.readdirSync(dir)).toEqual(["notes.txt"]);
    expect(npmLog()).toEqual([]);
  });
});
