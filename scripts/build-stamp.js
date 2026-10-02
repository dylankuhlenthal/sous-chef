// Writes dist/.build-stamp, the last step of `npm run build`, so the stamp exists only after
// a complete build. It records a SHA-1 of every source file the build read (src/ and the
// two tsconfig files), and of package-lock.json when the installed dependencies match it.
// bin/sc compares a source file newer than the stamp against it, so a checkout that only
// gave files fresh modification times is not mistaken for a change (docs/decisions/0023;
// the lock file's hash: docs/decisions/0029).
// No times are recorded, so an identical rebuild writes an identical stamp and does not
// restart the watcher.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const core = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function sha1(p) {
  return createHash("sha1").update(fs.readFileSync(p)).digest("hex");
}

function walk(dir, rel, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(path.join(dir, e.name), childRel, out);
    else out.push(childRel);
  }
  return out;
}

const files = {};
for (const rel of [...walk(path.join(core, "src"), "src", []), "tsconfig.json", "tsconfig.build.json"].sort()) {
  if (fs.existsSync(path.join(core, rel))) files[rel] = sha1(path.join(core, rel));
}
// The lock file's SHA-1 vouches for the installed dependencies only when they match it.
// npm writes node_modules/.package-lock.json (its record of what is installed) on every
// install. When that record is newer than package-lock.json, the install came from it.
// When it is older, package-lock.json may only have been rewritten with the same content
// (a checkout gives it a new time), so the two are compared: the same packages, each
// entry the same. Only then is the hash recorded; a package-lock.json whose content really
// changed (a pull, then a build without npm ci) records nothing, and the launcher goes on
// refusing until npm ci runs.
function mtime(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/** Whether a lock entry's `os` or `cpu` list (npm's form, `!` excluding) allows this machine. */
function allows(list, value) {
  if (!Array.isArray(list)) return true;
  if (list.includes(`!${value}`)) return false;
  const wanted = list.filter((v) => typeof v === "string" && !v.startsWith("!"));
  return wanted.length === 0 || wanted.includes(value);
}

/**
 * Whether npm's record of the installed packages names exactly the packages the lock file
 * does. npm leaves out of its record the root package (`""`) and optional packages it did
 * not install (those for other platforms), so those may be missing; every other entry must
 * be there and identical. The root entry cannot be compared, since npm's record has none,
 * so every dependency the root entry declares (of any kind) must be installed, except an
 * optional one whose `os` or `cpu` excludes this machine: a pull that adds a dependency
 * at the root, optional or not, is refused until npm ci. A file that cannot be read counts
 * as no match.
 */
function installedMatches(lockFile, installedFile) {
  let lock;
  let installed;
  try {
    lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    installed = JSON.parse(fs.readFileSync(installedFile, "utf8"));
  } catch {
    return false;
  }
  for (const key of ["name", "version", "lockfileVersion", "requires"]) {
    if (!isDeepStrictEqual(lock[key], installed[key])) return false;
  }
  const want = lock.packages;
  const have = installed.packages;
  if (typeof want !== "object" || want === null || typeof have !== "object" || have === null) return false;
  for (const [key, entry] of Object.entries(have)) {
    if (!Object.hasOwn(want, key) || !isDeepStrictEqual(want[key], entry)) return false;
  }
  for (const [key, entry] of Object.entries(want)) {
    if (key !== "" && !Object.hasOwn(have, key) && entry?.optional !== true) return false;
  }
  const root = want[""] ?? {};
  for (const kind of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const deps = root[kind];
    if (deps === undefined) continue;
    if (typeof deps !== "object" || deps === null) return false;
    for (const name of Object.keys(deps)) {
      const key = `node_modules/${name}`;
      if (Object.hasOwn(have, key)) continue;
      const entry = want[key];
      const otherPlatform = kind === "optionalDependencies" && entry !== undefined &&
        !(allows(entry.os, process.platform) && allows(entry.cpu, process.arch));
      if (!otherPlatform) return false;
    }
  }
  return true;
}

const lockPath = path.join(core, "package-lock.json");
const installedPath = path.join(core, "node_modules", ".package-lock.json");
const lockTime = mtime(lockPath);
const installedTime = mtime(installedPath);
const vouched = lockTime !== null && installedTime !== null &&
  (installedTime >= lockTime || installedMatches(lockPath, installedPath));
const lock = vouched ? sha1(lockPath) : null;
fs.writeFileSync(path.join(core, "dist", ".build-stamp"), JSON.stringify({ files, lock }, null, 2) + "\n");
