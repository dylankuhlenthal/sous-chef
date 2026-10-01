// Session kinds: kinds/<name>.md, in the user kinds folder or the core's.
//
// Kinds are looked up in two folders: the user kinds (util.userKindsDir(), under
// sous chef's data home), then the core kinds (util.kindsDir(), under the code
// root). A user kind replaces a core kind of the same name as a whole file. When both
// folders are the same (as when the data home is the code root) there is only the
// core. Kind names are lowercase kebab-case; any other name is an unknown kind.
//
// Each file starts with a small front matter block, then the instructions that go
// into a session's brief:
//
//   ---
//   description: one line shown by `sc kinds`
//   starts_waiting_on: owner | agent
//   permissions: bypass       (optional; one of runtimes.PERMISSIONS)
//   skill: build              (optional; the one skill the instructions tell the session to run)
//   ---
//   <instructions>
//
// `starts_waiting_on: owner` means the session is ready for the owner (util.owner)
// to attach as soon as it launches; `agent` means it works on its own and reports
// back. The owner's name in lower case is accepted in place of `owner`.
// `{{owner}}` in the description and instructions is filled with the owner's name.
// `permissions` is the mode a session of this kind launches in when `sc spawn`
// is not given `--permissions`; without it, runtimes.DEFAULT_PERMISSIONS.
// `skill` is a bare skill name (no slash); `sc spawn` asks the runtime whether it is
// available and refuses when it is definitely missing (ops.checkSkill).
// Run `sc kinds` for the kinds that exist; no list of them lives in code.

import path from "node:path";
import { glob, isFile, isspace, partition, readText, resolvePath, sorted, splitlines, stem, strip } from "./py.js";
import { PERMISSIONS } from "./runtimes/types.js";
import { kindsDir, owner, Owner, render, SCError, userKindsDir } from "./util.js";

export const ALLOWED_WAITING = new Set(["owner", "agent"]);
const NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface Kind {
  name: string;
  description: string;
  starts_waiting_on: string;
  permissions: string | null;
  skill: string | null;
  body: string;
  source: string;
  replaces_core: boolean;
  path: string;
}

/** [source, folder] pairs in lookup order: the user kinds, then the core. One entry if they are the same. */
function folders(): [string, string][] {
  const core = kindsDir();
  const user = userKindsDir();
  if (resolvePath(user) === resolvePath(core)) return [["core", core]];
  return [["user", user], ["core", core]];
}

function find(name: string): [string, string, boolean] | null {
  if (!NAME.test(name || "")) return null;
  const found = folders().map(([source, folder]) => [source, path.join(folder, `${name}.md`)] as [string, string])
    .filter(([, p]) => isFile(p));
  if (!found.length) return null;
  const [source, p] = found[0]!;
  return [source, p, source === "user" && found.length > 1];
}

export function parse(text: string): [Record<string, string>, string] {
  const meta: Record<string, string> = {};
  let body = text;
  if (text.startsWith("---\n")) {
    const [head, sep, rest] = partition(text.slice(4), "\n---\n");
    if (sep) {
      body = rest;
      for (const line of splitlines(head)) {
        const [k, , v] = partition(line, ":");
        if (strip(k)) meta[strip(k)] = strip(v);
      }
    }
  }
  return [meta, strip(body)];
}

function get(meta: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(meta, key) ? meta[key] : undefined;
}

export function load(name: string): Kind {
  const found = find(name);
  if (!found) throw new SCError(`unknown kind '${name}' (known: ${names().join(", ")})`);
  const [source, p, replacesCore] = found;
  const [meta, body] = parse(readText(p));
  let waiting = get(meta, "starts_waiting_on") ?? "agent";
  let o: Owner | null;
  try {
    o = owner();
  } catch (e) {
    if (!(e instanceof SCError)) throw e;
    o = null;
  }
  if (o && waiting.toLowerCase() === o.lower) waiting = "owner";
  if (!ALLOWED_WAITING.has(waiting)) {
    throw new SCError(`${p}: starts_waiting_on must be owner or agent, not '${waiting}'`);
  }
  const permissions = get(meta, "permissions") || null;
  if (permissions !== null && !Object.hasOwn(PERMISSIONS, permissions)) {
    throw new SCError(`${p}: permissions must be one of ${Object.keys(PERMISSIONS).join(", ")}, not '${permissions}'`);
  }
  const skill = get(meta, "skill") || null;
  if (skill !== null && (skill.startsWith("/") || [...skill].some(isspace))) {
    throw new SCError(`${p}: skill must be a bare skill name such as build, not '${skill}'`);
  }
  // Without an owner (`sc kinds` still works then) the text says "the owner".
  const description = render(get(meta, "description") ?? "", { owner: o ? o.name : "the owner" });
  return { name, description, starts_waiting_on: waiting, permissions, skill, body, source,
    replaces_core: replacesCore, path: p };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether the instructions name the skill as /<skill>, as a whole name (so /shape-gui is not /shape). */
export function namesSkill(body: string, skill: string): boolean {
  return new RegExp(`/${escapeRegExp(skill)}(?![A-Za-z0-9_:-]|\\.\\w)`, "u").test(body);
}

/** Whether there is a user kinds folder apart from the core's (see folders). */
export function separateUserKinds(): boolean {
  return folders().length > 1;
}

/** Every kind name in either folder, once each, sorted. */
export function names(): string[] {
  const found = new Set<string>();
  for (const [, folder] of folders()) {
    for (const n of glob(folder, ".md")) {
      const s = stem(n);
      if (NAME.test(s)) found.add(s);
    }
  }
  return sorted(found);
}
