// Messages from sous chef to a session: state/sessions/<id>/inbox/.
//
// Each message is one JSON file, <seq>.json, written atomically. The session
// acknowledges a message by running `sc inbox ack <seq>`, which moves the file
// into inbox/handled/. Sequence numbers are never reused, because allocation
// looks at both the inbox and handled/.

import fs from "node:fs";
import path from "node:path";
import { withLock } from "./lock.js";
import { Dict, glob, isDir, isFile, stem, truthy } from "./py.js";
import * as records from "./records.js";
import { mkdirs, now, readJson, SCError, writeJson } from "./util.js";

export interface Message extends Dict {
  seq: number;
  ts: number;
  from: string;
  text: string;
  resolves?: string;
}

export function inboxDir(sid: string): string {
  return path.join(records.sessionDir(sid), "inbox");
}

export function handledDir(sid: string): string {
  return path.join(inboxDir(sid), "handled");
}

function seqs(dir: string): number[] {
  if (!isDir(dir)) return [];
  return glob(dir, ".json").map(stem).filter((s) => /^[0-9]+$/.test(s)).map(Number);
}

function name(seq: number): string {
  return `${String(seq).padStart(4, "0")}.json`;
}

export async function write(sid: string, text: string, sender = "sous chef", resolves: string | null = null):
  Promise<Message> {
  return withLock(path.join(inboxDir(sid), ".seq.lock"), () => {
    const seq = Math.max(...seqs(inboxDir(sid)), ...seqs(handledDir(sid)), 0) + 1;
    const msg: Message = { seq, ts: now(), from: sender, text };
    if (resolves) msg.resolves = resolves;
    writeJson(path.join(inboxDir(sid), name(seq)), msg);
    return msg;
  });
}

export function unhandled(sid: string): Message[] {
  const d = inboxDir(sid);
  if (!isDir(d)) return [];
  const msgs = glob(d, ".json").map((n) => readJson<Message>(path.join(d, n)));
  return msgs.filter((m): m is Message => truthy(m));
}

export function ack(sid: string, seq: number): void {
  const src = path.join(inboxDir(sid), name(seq));
  if (!isFile(src)) {
    if (isFile(path.join(handledDir(sid), name(seq)))) return;
    throw new SCError(`no unhandled message ${seq} in the inbox of ${sid}`);
  }
  mkdirs(handledDir(sid));
  fs.renameSync(src, path.join(handledDir(sid), name(seq)));
}
