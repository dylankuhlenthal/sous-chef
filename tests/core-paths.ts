// The core's path list: which files belong to the shared sous chef code repo.
//
// Everything else in a sous chef folder is the owner's (their data folder, reached through
// the `my` link). The list is used by:
//
//   copyCode()    tests that run a copy of the code, holding only core files, so they pass
//                 in the core as it is published (decision 0020), plus a built core's output
//   coreFiles()   the checks that no personal file and no owner's name is in the core
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = fs.realpathSync(path.resolve(import.meta.dirname, ".."));

// Folders (ending in /) and single files. A path is core when it is one of the files
// or sits under one of the folders.
export const CORE_PATHS = [
  "bin/", "docs/", "tests/", "templates/", ".agents/",
  "kinds/general.md", "kinds/investigate.md",
  "AGENTS.md", "CLAUDE.md", ".claude", ".gitignore", "README.md", "install.sh",
  "src/", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json", "eslint.config.js",
  "vitest.config.ts", "scripts/", "LICENSE", "SECURITY.md", "CONTRIBUTING.md", ".github/",
] as const;

// Inside a core folder but never core: written per install, gitignored.
export const NOT_CORE = [".agents/settings.local.json"] as const;

// What a running copy of the code needs: copied file by file, core files only.
export const RUNTIME_PATHS = ["bin/", "templates/", "kinds/", "install.sh"] as const;
// A built core's source and output: copied whole when present, not filtered by the path
// list (dist/ is gitignored, so it is never on it), with modification times kept so a
// launcher that compares dist/ with src/ sees the copy as built.
export const BUILD_PATHS = ["src/", "dist/", "package.json", "package-lock.json"] as const;
// Linked, not copied, when present: too big to copy for every test, and never changed by one.
export const LINKED_PATHS = ["node_modules"] as const;

export function isCore(rel: string): boolean {
  if ((NOT_CORE as readonly string[]).includes(rel)) return false;
  return CORE_PATHS.some((p) => (p.endsWith("/") ? rel.startsWith(p) : rel === p));
}

function isFileOrLink(file: string): boolean {
  try {
    const st = fs.lstatSync(file);
    return st.isSymbolicLink() || st.isFile();
  } catch {
    return false;
  }
}

/** git could not list the files (for example, root is not a git checkout). */
export class GitListError extends Error {}

/** Every file git tracks or would track (untracked but not ignored) under root. */
export function listedFiles(root: string = ROOT): string[] {
  const out = spawnSync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" });
  if (out.status !== 0) throw new GitListError(`git could not list the files in ${root}: ${(out.stderr ?? "").trim()}`);
  return out.stdout.split("\n").filter((f) => f !== "" && isFileOrLink(path.join(root, f)));
}

export function coreFiles(root: string = ROOT): string[] {
  return listedFiles(root).filter(isCore);
}

/** Every file (or link to a file) under dir, sorted, as paths under root. */
function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found.sort();
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

function copyFile(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { preserveTimestamps: true, dereference: true, force: true });
}

/**
 * Copy what a running sc needs from the code root `root` into dest, and return dest.
 *
 * RUNTIME_PATHS file by file, core files only (so the owner's kinds, if still in the tree,
 * are left behind); then BUILD_PATHS whole; then LINKED_PATHS as links to root's. Paths root
 * does not have are skipped. Every file keeps its modification time. Walks the folder rather
 * than asking git, so it also works in a copy that is not a git repo.
 */
export function copyCode(dest: string, root: string = ROOT): string {
  fs.mkdirSync(dest, { recursive: true });
  for (const part of RUNTIME_PATHS) {
    const src = path.join(root, part.replace(/\/$/, ""));
    if (isFile(src)) {
      copyFile(src, path.join(dest, path.basename(src)));
      continue;
    }
    if (!isDir(src)) continue;
    for (const file of walk(src)) {
      const rel = path.relative(root, file).split(path.sep).join("/");
      if (isFile(file) && isCore(rel)) copyFile(file, path.join(dest, rel));
    }
  }
  for (const part of BUILD_PATHS) {
    const src = path.join(root, part.replace(/\/$/, ""));
    const to = path.join(dest, part.replace(/\/$/, ""));
    if (isDir(src)) {
      fs.cpSync(src, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, force: true });
    } else if (isFile(src)) {
      copyFile(src, to);
    }
  }
  for (const part of LINKED_PATHS) {
    const link = path.join(dest, part);
    let linked = false;
    try {
      linked = fs.lstatSync(link).isSymbolicLink();
    } catch {
      linked = false;
    }
    if (fs.existsSync(path.join(root, part)) && !linked) fs.symlinkSync(path.join(root, part), link);
  }
  return dest;
}

/** The kinds the core ships, from the path list. */
export function coreKindNames(): string[] {
  return CORE_PATHS.filter((p) => p.startsWith("kinds/")).map((p) => path.parse(p).name).sort();
}
