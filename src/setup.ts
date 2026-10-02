// `sc setup`: install sous chef for its owner. `install.sh` runs it.
//
// It connects the core (this code folder) to the owner's data folder, through the
// link `<core>/my`, which everything else finds the data by (util.home()). It never
// calls util.home() itself: it runs before the link exists.
//
// Steps, each with a flag so tests (and a careful owner) can answer up front:
//
//   data folder   --data (default ~/.my-sous-chef). An existing sous chef data folder
//                 is used as it is; otherwise --clone <url> clones one, or a new one
//                 is made with starter files.
//   owner         only when the folder has no owner.json: --name, --branch-prefix
//   git           a new folder only: --git / --no-git (git init and a first commit)
//   push          a git data folder with no `origin`: --push-url <url of an empty repo
//                 you made>; setup never creates repos
//   then          the `my` link, `sc` and `souschef` in --bin-dir (default ~/.local/bin),
//                 and .agents/settings.local.json, so a plain `claude` in the core may
//                 edit the data folder as it edits the core (Claude Code only reads it
//                 once the folder is trusted)
//
// Running it again is safe: what is already in place is left alone. It refuses a
// `my` link that points somewhere else, and the old combined layout.

import fs from "node:fs";
import path from "node:path";
import { createInterface, Interface } from "node:readline/promises";
import { print, stdinIsTty } from "./io.js";
import { run } from "./proc.js";
import { dumps, JSONDecodeError, loads } from "./pyjson.js";
import { capitalize, Dict, exists, expanduser, isDict, isSymlink, listDir, pathStr, readText, resolvePath, splitWs, stem, strip } from "./py.js";
import { CODE_ROOT, DATA_LINK, ownerProblem, SCError, slug, writeJson } from "./util.js";

export const DEFAULT_DATA = "~/.my-sous-chef";
export const DEFAULT_BIN = "~/.local/bin";
const MEMORY_FILES = ["focus.md", "threads/index.md", "ideas.md", "pocs.md", "repos.md"];
export const DATA_GITIGNORE = "state/\n.env\n__pycache__/\n";
const SETTINGS_LOCAL = path.join(CODE_ROOT, ".agents", "settings.local.json");

export interface SetupArgs {
  data: string | null;
  clone: string | null;
  git: boolean | null;
  push_url: string | null;
  name: string | null;
  branch_prefix: string | null;
  bin_dir: string | null;
  yes: boolean;
}

/** Answers from flags first; otherwise from the terminal, unless --yes or there is none. */
class Asker {
  interactive: boolean;
  private rl: Interface | null = null;

  constructor(yes: boolean) {
    this.interactive = !yes && stdinIsTty();
  }

  private async input(prompt: string): Promise<string> {
    this.rl ??= createInterface({ input: process.stdin, output: process.stdout });
    return this.rl.question(prompt);
  }

  close(): void {
    this.rl?.close();
  }

  async text(question: string, given: string | null, dflt: string | null = null, requiredFlag: string | null = null):
    Promise<string | null> {
    if (given !== null && given !== undefined) return given;
    if (this.interactive) {
      const shown = dflt ? ` [${dflt}]` : "";
      const answer = strip(await this.input(`${question}${shown}: `));
      return answer || dflt;
    }
    if (dflt === null && requiredFlag) throw new SCError(`${question}: pass ${requiredFlag}`);
    return dflt;
  }

  async yesNo(question: string, given: boolean | null, dflt: boolean): Promise<boolean> {
    if (given !== null && given !== undefined) return given;
    if (this.interactive) {
      const answer = strip(await this.input(`${question} [${dflt ? "Y/n" : "y/N"}]: `)).toLowerCase();
      return !answer ? dflt : answer.startsWith("y");
    }
    return dflt;
  }
}

async function git(folder: string, args: string[], check = true) {
  const out = await run("git", ["-C", folder, ...args], { timeout: 120 });
  if (check && out.code !== 0) {
    throw new SCError(`git ${args.join(" ")} failed in ${folder}: ${strip(out.stderr || out.stdout)}`);
  }
  return out;
}

export function isDataFolder(folder: string): boolean {
  return ["owner.json", "memory", "state", "instructions.md"].some((n) => exists(path.join(folder, n)));
}

/** True when `my` already points at `data`. Refuses a link that points elsewhere. */
function checkLink(data: string): boolean {
  const link = DATA_LINK;
  if (isSymlink(link)) {
    const target = pathStr(expanduser(fs.readlinkSync(link)));
    if (resolvePath(target) === resolvePath(data) && exists(target)) return true;
    throw new SCError(`${link} already points to ${target}. To use ${data} instead, remove the link ` +
      `(rm ${link}) and run setup again; the data behind it is not touched.`);
  }
  if (exists(link)) throw new SCError(`${link} exists and is not a link; move it away and run setup again`);
  return false;
}

function writeIfMissing(p: string, text: string): void {
  if (!exists(p) && !isSymlink(p)) fs.writeFileSync(p, text);
}

function starterFiles(data: string, ownerLower: string): void {
  const feedback = `memory/working-with-${slug(ownerLower)}.md`;
  fs.mkdirSync(path.join(data, "memory", "threads"), { recursive: true });
  for (const rel of MEMORY_FILES) {
    writeIfMissing(path.join(data, "memory", rel), `# ${capitalize(stem(rel).replace(/-/g, " "))}\n`);
  }
  writeIfMissing(path.join(data, feedback), "# Working with me\n\nFeedback on how sous chef works: corrections and " +
    "confirmed approaches, each with why and how to apply it.\n");
  fs.mkdirSync(path.join(data, "cron"), { recursive: true });
  fs.mkdirSync(path.join(data, "kinds"), { recursive: true });
  writeIfMissing(path.join(data, "instructions.md"),
    "<!-- Your own instructions for sous chef, on top of the core's AGENTS.md. Sous chef's startup " +
    "summary shows this file in full. Comments like this one are left out. -->\n\n" +
    `- My feedback on how you work is in \`my/${feedback}\`. Read it on every start.\n`);
  writeIfMissing(path.join(data, "worker-instructions.md"),
    "<!-- Your own instructions for every session sous chef launches, added to each brief under " +
    "\"Instructions from your owner\". With nothing but comments, the section is left out. -->\n");
  writeIfMissing(path.join(data, ".gitignore"), DATA_GITIGNORE);
}

function writeOwner(data: string, name: string | null, prefix: string | null): void {
  const n = strip(name || "");
  const problem = ownerProblem(n, prefix);
  if (problem) throw new SCError(problem);
  writeJson(path.join(data, "owner.json"), { name: n, branch_prefix: prefix });
}

function linkBin(binDir: string, say: (s: string) => void): void {
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of ["sc", "souschef"]) {
    const target = path.join(CODE_ROOT, "bin", name);
    const link = path.join(binDir, name);
    if (isSymlink(link)) {
      if (pathStr(fs.readlinkSync(link)) === target) continue;
      fs.unlinkSync(link);
    } else if (exists(link)) {
      say(`left ${link} alone: it is a file, not a link; run ${target} by its path, or replace it`);
      continue;
    }
    fs.symlinkSync(target, link);
    say(`linked ${link} -> ${target}`);
  }
  if (!(process.env.PATH ?? "").split(":").includes(binDir)) {
    say(`note: ${binDir} is not on your PATH; add it so \`sc\` and \`souschef\` work from any terminal`);
  }
}

/** Let a plain `claude` in the core edit the data folder without asking (Claude Code's additionalDirectories). */
function allowDataFolder(data: string): void {
  let settings: Dict;
  try {
    settings = exists(SETTINGS_LOCAL) ? (loads(readText(SETTINGS_LOCAL)) as Dict) : {};
  } catch (e) {
    if (e instanceof JSONDecodeError) {
      throw new SCError(`${SETTINGS_LOCAL} is not valid JSON (${e.message}); fix or remove it and run setup again`);
    }
    throw e;
  }
  if (!isDict(settings.permissions)) settings.permissions ??= {};
  const perms = settings.permissions as Dict;
  perms.additionalDirectories ??= [];
  const dirs = perms.additionalDirectories as string[];
  const wanted = resolvePath(data);
  if (!dirs.includes(wanted)) {
    dirs.push(wanted);
    fs.mkdirSync(path.dirname(SETTINGS_LOCAL), { recursive: true });
    fs.writeFileSync(SETTINGS_LOCAL, dumps(settings, { indent: 2 }) + "\n");
  }
}

export async function runSetup(args: SetupArgs): Promise<number> {
  const ask = new Asker(args.yes);
  try {
    return await setup(args, ask);
  } finally {
    ask.close();
  }
}

async function setup(args: SetupArgs, ask: Asker): Promise<number> {
  const say = print;
  let data = pathStr(expanduser((await ask.text("Data folder (your memory, jobs and settings)", args.data, DEFAULT_DATA))!));
  data = path.isAbsolute(data) ? data : path.join(process.cwd(), data);
  const linked = checkLink(data);

  let made = false;
  if (exists(data) && listDir(data).length) {
    if (!isDataFolder(data)) {
      throw new SCError(`${data} is not empty and is not a sous chef data folder; choose another folder`);
    }
    if (args.clone) throw new SCError(`${data} already holds a data folder; leave out --clone to use it as it is`);
    say(`using the data folder at ${data}`);
  } else {
    let url = args.clone;
    if (url === null && ask.interactive) {
      url = (await ask.text("Clone an existing data folder from a git URL (blank for a new one)", null, "")) || null;
    }
    if (url) {
      if (exists(data)) fs.rmdirSync(data);
      const out = await run("git", ["clone", "-q", url, data], { timeout: 600 });
      if (out.code !== 0) throw new SCError(`git clone ${url} failed: ${strip(out.stderr || out.stdout)}`);
      say(`cloned ${url} into ${data}`);
    } else {
      fs.mkdirSync(data, { recursive: true });
      made = true;
    }
  }

  if (!exists(path.join(data, "owner.json"))) {
    const name = await ask.text("Your name, as sessions and Slack show it", args.name, null, "--name");
    const prefix = await ask.text("Your branch prefix, e.g. sam/ (blank for none)", args.branch_prefix, "");
    writeOwner(data, name, prefix);
    say(`wrote ${path.join(data, "owner.json")}`);
  }
  const ownerData = loads(readText(path.join(data, "owner.json"))) as Dict;
  const ownerLower = strip(String(ownerData.name ?? "me")).toLowerCase();

  if (made) {
    starterFiles(data, ownerLower);
    say(`made a new data folder at ${data}`);
    if (await ask.yesNo("Track the data folder in git (a private repo of your own)?", args.git, true)) {
      await git(data, ["init", "-q", "-b", "main"]);
      await git(data, ["add", "-A"]);
      await git(data, ["commit", "-qm", "starts the sous chef data folder"]);
      say("started a git repo in it, with a first commit");
    }
  }

  // Only a repo whose top is the data folder itself: one it merely sits inside is someone else's.
  const top = strip((await git(data, ["rev-parse", "--show-toplevel"], false)).stdout);
  const isRepo = Boolean(top) && resolvePath(top) === resolvePath(data);
  if (isRepo && !splitWs((await git(data, ["remote"], false)).stdout).length) {
    const pushUrl = await ask.text("Push it to a remote? The URL of an empty repo you made (blank for none)",
      args.push_url, "");
    if (pushUrl) {
      await git(data, ["remote", "add", "origin", pushUrl]);
      await git(data, ["push", "-q", "-u", "origin", "HEAD"]);
      say(`pushed it to ${pushUrl}; the watcher keeps it pushed from now on`);
    }
  } else if (args.push_url) {
    say(`not pushing to ${args.push_url}: the data folder is ` +
      (isRepo ? "already set up with a remote" : "not a git repo"));
  }

  if (!linked) {
    fs.symlinkSync(data, DATA_LINK);
    say(`linked ${DATA_LINK} -> ${data}`);
  }
  linkBin(pathStr(expanduser(args.bin_dir || DEFAULT_BIN)), say);
  allowDataFolder(data);
  say("\nSous chef is installed. Next:\n" +
    "  sc slack setup --help   to reach sous chef from Slack (optional; ask for a relay key)\n" +
    "  souschef                to start sous chef and attach to it\n" +
    `If you ever run plain \`claude\` in ${CODE_ROOT}, accept its trust prompt the first time: until then\n` +
    `Claude Code ignores ${path.relative(CODE_ROOT, SETTINGS_LOCAL)}, which lets it edit your data folder.`);
  return 0;
}
