// Session records: one directory per session under state/sessions/<id>/.
//
// Directory contents:
//   record.json    who the session is: kind, title, cwd, runtime, runtime handle
//   brief.md       the instructions the session was launched with
//   events.jsonl   append-only event log (events.ts)
//   inbox/         messages from sous chef (inbox.ts)
//   turns.json     last prompt and last stop times, written by hooks (hooks.ts)
//   report.md      optional deliverable a session writes (investigations)

import { randomBytes } from "node:crypto";
import path from "node:path";
import { withLock } from "./lock.js";
import { Dict, isDict, isFile, listDir, or } from "./py.js";
import { now, readJson, SCError, sessionsDir, slug, writeJson } from "./util.js";

/** A session record (record.json). Fields as the Python sc wrote them. */
export interface Rec extends Dict {
  id: string;
  kind: string;
  title: string;
  cwd: string;
  runtime: string;
}

export function sessionDir(sid: string): string {
  return path.join(sessionsDir(), sid);
}

export function newId(kind: string, title: string): string {
  return `${kind}-${slug(title, 24)}-${randomBytes(2).toString("hex")}`;
}

export function load(sid: string): Rec {
  const rec = readJson<Rec>(path.join(sessionDir(sid), "record.json"));
  if (rec === null) throw new SCError(`no session '${sid}' (see: sc sessions)`);
  return rec;
}

export function save(rec: Rec): void {
  writeJson(path.join(sessionDir(rec.id), "record.json"), rec);
}

export function allIds(): string[] {
  const root = sessionsDir();
  return listDir(root).filter((name) => isFile(path.join(root, name, "record.json")));
}

export function allRecords(): Rec[] {
  return allIds().map(load);
}

/** Find a session by exact id, or by a unique prefix of its id. */
export function resolve(key: string): Rec {
  const ids = allIds();
  if (ids.includes(key)) return load(key);
  const matches = ids.filter((i) => i.startsWith(key));
  if (matches.length === 1) return load(matches[0]!);
  if (!matches.length) throw new SCError(`no session matches '${key}' (see: sc sessions)`);
  throw new SCError(`'${key}' matches several sessions: ${matches.join(", ")}`);
}

/** The record's runtime handle as a dict ({} when it has none). */
export function handle(rec: Dict): Dict {
  const h = or(rec.handle, {});
  return isDict(h) ? h : {};
}

export function findByClaudeSession(claudeSessionId: string): Rec | null {
  for (const rec of allRecords()) {
    if (handle(rec).session_id === claudeSessionId) return rec;
  }
  return null;
}

export function turns(sid: string): Dict {
  return or(readJson<Dict>(path.join(sessionDir(sid), "turns.json"), {}), {}) as Dict;
}

export async function recordTurn(sid: string, field: string): Promise<void> {
  load(sid); // refuse unknown sessions rather than creating a directory for them
  const p = path.join(sessionDir(sid), "turns.json");
  await withLock(path.join(sessionDir(sid), ".turns.lock"), () => {
    const data = or(readJson<Dict>(p, {}), {}) as Dict;
    data[field] = now();
    writeJson(p, data);
  });
}
