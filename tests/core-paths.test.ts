// The code-copy helper (core-paths.ts copyCode): what a copy of a code root holds.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as corePaths from "./core-paths.js";

describe("CopyCodeTests", () => {
  it("copy code copies built output whole and links node modules", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "core-paths-"));
    try {
      const root = path.join(tmp, "root");
      const dest = path.join(tmp, "copy");
      const files = ["bin/sc", "kinds/general.md", "kinds/mine.md",
        "templates/t.md", "install.sh", "src/a.ts", "dist/a.js", "dist/sub/b.js", "package.json",
        "package-lock.json", "node_modules/pkg/index.js"];
      files.forEach((rel, n) => {
        const file = path.join(root, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, rel);
        fs.utimesSync(file, 1_700_000_000 + n, 1_700_000_000 + n); // a time a fresh copy would not get
      });
      corePaths.copyCode(dest, root);
      corePaths.copyCode(dest, root); // copying again into the same folder works too
      for (const rel of ["bin/sc", "kinds/general.md", "templates/t.md", "install.sh"]) {
        expect(fs.readFileSync(path.join(dest, rel), "utf8")).toBe(rel);
      }
      expect(fs.existsSync(path.join(dest, "kinds/mine.md"))).toBe(false);
      for (const rel of ["src/a.ts", "dist/a.js", "dist/sub/b.js", "package.json", "package-lock.json"]) {
        expect(fs.readFileSync(path.join(dest, rel), "utf8")).toBe(rel);
        expect(fs.statSync(path.join(dest, rel)).mtimeMs, rel).toBe(fs.statSync(path.join(root, rel)).mtimeMs);
      }
      expect(fs.lstatSync(path.join(dest, "node_modules")).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(path.join(dest, "node_modules"))).toBe(path.join(root, "node_modules"));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
