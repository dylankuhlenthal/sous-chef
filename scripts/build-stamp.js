// Writes dist/.build-stamp, the last step of `npm run build`, so the stamp exists only after
// a complete build. It records a SHA-1 of every source file the build read (src/ and the two
// tsconfig files) and of package-lock.json. bin/sc compares a source file newer than the
// stamp against it, so a checkout that only gave files fresh modification times is not
// mistaken for a change (docs/decisions/0023). No times are recorded, so an identical
// rebuild writes an identical stamp and does not restart the watcher.
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
const lock = fs.existsSync(path.join(core, "package-lock.json")) ? sha1(path.join(core, "package-lock.json")) : null;
fs.writeFileSync(path.join(core, "dist", ".build-stamp"), JSON.stringify({ files, lock }, null, 2) + "\n");
