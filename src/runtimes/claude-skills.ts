// Where Claude Code reads skills from, and whether a skill is there. Skills are files, and
// Claude Code has no command that lists them; docs/domains/sessions.md ("Where Claude Code
// reads skills from") says which parts were checked against Claude Code and how.
//
// This stays in sous chef whatever runs the sessions (TRV-1143 finding 9): `sc spawn`
// and `sc kinds` use it through the Claude runtime's skillAvailable and skillPlaces.

import fs from "node:fs";
import path from "node:path";
import { Dict, expanduser, isDir, isFile, listDir, partition, readText, resolvePath, splitlines, strip } from "../py.js";

/**
 * Claude Code's managed settings folder, per platform (read from Claude Code 2.1.285's
 * code). Its .claude/skills holds the organisation's managed skills. Tests pass their own.
 */
export const MANAGED_DIR = process.platform === "darwin" ? "/Library/Application Support/ClaudeCode"
  : "/etc/claude-code";

/** Claude Code's user folder: CLAUDE_CONFIG_DIR when set, else ~/.claude. */
export function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || expanduser("~/.claude");
}

function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** A folder and each of its parents, up to /. */
function withParents(start: string): string[] {
  const out = [start];
  let cur = start;
  while (path.dirname(cur) !== cur) {
    cur = path.dirname(cur);
    out.push(cur);
  }
  return out;
}

/** The nearest folder at or above `start` holding .git (a folder, or a file in a linked worktree), or null. */
function repoRoot(start: string): string | null {
  for (const folder of withParents(start)) {
    if (exists(path.join(folder, ".git"))) return folder;
  }
  return null;
}

/** The main checkout of a linked git worktree, or null (a bare repo has none). */
function mainCheckout(worktree: string): string | null {
  let common: string;
  try {
    let gitdir = strip(readText(path.join(worktree, ".git")));
    if (!gitdir.startsWith("gitdir:")) return null;
    gitdir = resolvePath(path.resolve(worktree, strip(gitdir.slice("gitdir:".length))));
    common = resolvePath(path.resolve(gitdir, strip(readText(path.join(gitdir, "commondir")))));
  } catch {
    return null;
  }
  return path.basename(common) === ".git" ? path.dirname(common) : null;
}

/**
 * The folders whose .claude/ a session in `cwd` loads skills from.
 *
 * `cwd` and each parent up to the repo root (the worktree root in a linked worktree),
 * or up to / outside a repo. A linked worktree with no .claude/skills at its root
 * also gets the main checkout's (Claude Code 2.1.277 and later).
 */
export function projectDirs(cwd: string): string[] {
  const start = resolvePath(expanduser(cwd));
  const root = repoRoot(start);
  const dirs: string[] = [];
  for (const folder of withParents(start)) {
    dirs.push(folder);
    if (folder === root) break;
  }
  if (root !== null && isFile(path.join(root, ".git")) && !isDir(path.join(root, ".claude", "skills"))) {
    const main = mainCheckout(root);
    if (main !== null) dirs.push(main);
  }
  return dirs;
}

/** Folders matching <base>/<a>/<b>/... one level per "*", as a pathlib glob of one "*" per level (dot names included). */
function globDirs(base: string, depth: number): string[] {
  let level = [base];
  for (let i = 0; i < depth; i++) {
    level = level.flatMap((d) => listDir(d).map((n) => path.join(d, n)));
  }
  return level;
}

/** Root folders of the installed and synced plugins, each of which may have skills/ and commands/. */
function pluginDirs(config: string): string[] {
  const plugins = path.join(config, "plugins");
  const dirs = new Set<string>([...globDirs(path.join(plugins, "cache"), 3), ...globDirs(path.join(plugins, "synced"), 2)]);
  try {
    const installed = JSON.parse(readText(path.join(plugins, "installed_plugins.json"))) as Dict;
    const byName = installed.plugins ?? {};
    if (typeof byName === "object" && byName !== null && !Array.isArray(byName)) {
      for (const entries of Object.values(byName as Dict)) {
        for (const entry of Array.isArray(entries) ? entries : []) {
          if (entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.installPath === "string") {
            dirs.add(path.normalize(entry.installPath));
          }
        }
      }
    }
  } catch {
    // no installed plugins file, or one that cannot be read: only the folders count
  }
  return [...dirs].filter(isDir).sort();
}

function frontMatterName(skillMd: string): string | null {
  let text: string;
  try {
    text = readText(skillMd);
  } catch {
    return null;
  }
  if (!text.startsWith("---\n")) return null;
  const [head] = partition(text.slice(4), "\n---");
  for (const line of splitlines(head)) {
    const [key, , value] = partition(line, ":");
    if (strip(key) === "name") return strip(strip(value), "'\"") || null;
  }
  return null;
}

/** A skill called `name` in this skills folder: <name>/SKILL.md, or any SKILL.md whose front matter names it. */
function hasSkill(skillsDir: string, name: string): boolean {
  if (isFile(path.join(skillsDir, name, "SKILL.md"))) return true;
  return listDir(skillsDir).some((n) => {
    const md = path.join(skillsDir, n, "SKILL.md");
    return exists(md) && frontMatterName(md) === name;
  });
}

/**
 * Whether a session in `cwd` can run the skill `name`: true, false, or null (cannot tell).
 *
 * Looks for <name>/SKILL.md (or a SKILL.md whose front matter `name` is `name`) in every
 * folder Claude Code reads skills from on disk, and for a legacy command <name>.md:
 *   user       <config>/skills, and <config>/skills/synced/<org>/ (skills synced from claude.ai)
 *   project    .claude/skills in cwd and each parent up to the repo root (see projectDirs)
 *   managed    <managed>/.claude/skills
 *   plugins    skills/ in each installed or synced plugin under <config>/plugins
 *   commands   <config>/commands, .claude/commands in the project folders, plugins' commands/
 * <config> is CLAUDE_CONFIG_DIR, else ~/.claude. Without a cwd (`sc kinds`), project
 * folders are not checked. A name with a colon (plugin:skill, anthropic-skills:docx)
 * is not checked and gives null, as do names with a slash.
 */
export function skillAvailable(name: string, cwd: string | null = null, managedDir = MANAGED_DIR): boolean | null {
  if (!name || name.includes(":") || name.includes("/") || name === "." || name === "..") return null;
  const config = configDir();
  const projects = cwd ? projectDirs(cwd) : [];
  const plugins = pluginDirs(config);
  const skillDirs = [path.join(config, "skills"), ...globDirs(path.join(config, "skills", "synced"), 1),
    ...projects.map((p) => path.join(p, ".claude", "skills")), path.join(managedDir, ".claude", "skills"),
    ...plugins.map((p) => path.join(p, "skills"))];
  const commandDirs = [path.join(config, "commands"), ...projects.map((p) => path.join(p, ".claude", "commands")),
    ...plugins.map((p) => path.join(p, "commands"))];
  if (skillDirs.some((d) => isDir(d) && hasSkill(d, name))) return true;
  return commandDirs.some((d) => isFile(path.join(d, `${name}.md`)));
}

/** Where skillAvailable looks, in words, for a refusal message. */
export function skillPlaces(cwd: string | null = null, managedDir = MANAGED_DIR): string[] {
  const config = configDir();
  const places = [path.join(config, "skills")];
  if (cwd) places.push(...projectDirs(cwd).map((p) => path.join(p, ".claude", "skills")));
  places.push(path.join(managedDir, ".claude", "skills"), `plugins under ${path.join(config, "plugins")}`);
  return places;
}
