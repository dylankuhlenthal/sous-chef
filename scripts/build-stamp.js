// Writes dist/.build-stamp, the last step of `npm run build`, so the stamp exists only after
// a complete build. It records a SHA-1 of every source file the build read (src/ and the
// two tsconfig files), and of package-lock.json when the installed dependencies match it.
// bin/sc compares a source file newer than the stamp against it, so a checkout that only
// gave files fresh modification times is not mistaken for a change (docs/decisions/0023).
// No times are recorded, so an identical rebuild writes an identical stamp and does not
// restart the watcher.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
// The lock file's SHA-1 vouches for the installed dependencies only when they were
// installed from it: npm writes node_modules/.package-lock.json on every install, so an
// install older than package-lock.json (a pull, then a build without npm ci) records
// nothing, and the launcher goes on refusing until npm ci runs.
function mtime(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}
const lockPath = path.join(core, "package-lock.json");
const installed = mtime(path.join(core, "node_modules", ".package-lock.json"));
const lock = mtime(lockPath) !== null && installed !== null && installed >= mtime(lockPath) ? sha1(lockPath) : null;
fs.writeFileSync(path.join(core, "dist", ".build-stamp"), JSON.stringify({ files, lock }, null, 2) + "\n");
