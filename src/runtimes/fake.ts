// A runtime that runs nothing, for tests.
//
// Session state lives in state/fake-runtime.json:
//   {"sessions": {"<id>": {"alive": true, "busy": false, "prompt": null, "activity": null,
//                          "permissions": "auto"}},
//    "wakes": [[id, text], ...]}
// Tests flip "alive", "busy", "prompt" and "activity" directly, and read "wakes" to see
// what was sent. "activity" is returned as it is, in the shape runtimes/types.ts
// describes, so a test can model a session with subagents in flight. Setting "prompt"
// models a session held at a permission prompt: as with Claude Code, such a session is
// busy, whatever "busy" says. "permissions" is what the session was launched with; a
// resume keeps it, as Claude Code keeps a session's launch flags.
// Skills: every skill is available except names listed in "missing_skills" (false) or
// "unknown_skills" (null, cannot tell). Each check is appended to "skill_checks" as
// [name, cwd], so a test can see which working directory was checked.
//
// Sous chef's own session (souschef runs on this runtime when SC_CHEF_RUNTIME is fake):
//   "chef_alive": false makes wakeSessionId fail, as when sous chef is not running.
//   startNamed adds sessions["fake-chef-<n>"] = {"alive": true, "busy": false, "pid": 1,
//     "kind": "background", "id": "chef-<n>", "name", "launch_prompt", "cwd", "permissions"}
//     (n counts from 1) and returns "chef-<n>".
//   resumeSessionId sets the row's "alive" true and "pid" 1, creating it if missing
//     ("kind" background, "id" the first 8 characters of the session id), and returns its
//     "id"; with SC_FAKE_RESUME_FAILS set it returns null and changes nothing.
//   stopShort sets "alive" false and removes "pid" on the row whose "id" matches.
//   attachExec prints "fake attach <short id>" and returns: nothing is attached.
// Tests model a sous chef open in a terminal with "pid" and "kind": "interactive", and a
// stopped one with no "pid", as `claude agents` lists them.

import path from "node:path";
import { Dict, get, or, truthy } from "../py.js";
import { readJson, SCError, stateDir, writeJson } from "../util.js";
import { Listing, PERMISSIONS, Runtime, Status, WakeError } from "./types.js";

interface FakeData extends Dict {
  sessions: Record<string, Dict>;
  wakes: unknown[][];
}

function dataPath(): string {
  return path.join(stateDir(), "fake-runtime.json");
}

function load(): FakeData {
  return readJson<FakeData>(dataPath(), { sessions: {}, wakes: [] }) as FakeData;
}

function save(data: FakeData): void {
  writeJson(dataPath(), data);
}

function statusOf(s: Dict | undefined): Status {
  if (!s || !truthy(s.alive)) return { alive: false, busy: null, pid: null, prompt: null, activity: null };
  const prompt = get<string | null>(s, "prompt", null);
  return { alive: true, busy: truthy(prompt) ? true : get<boolean | null>(s, "busy", false), pid: 1, prompt,
    activity: get(s, "activity", null) };
}

function row(rows: Listing, key: string): Dict | undefined {
  return Object.hasOwn(rows, key) ? rows[key] : undefined;
}

export const fake: Runtime = {
  NAME: "fake",

  async listing() {
    return load().sessions;
  },

  async status(rec, rows) {
    const r = rows ?? (await this.listing());
    return statusOf(row(r, rec.id as string));
  },

  async launch(rec, prompt, env, settings) {
    if (process.env.SC_FAKE_LAUNCH_FAILS) throw new SCError("fake runtime was told to fail");
    const data = load();
    data.sessions[rec.id as string] = { alive: true, busy: false, prompt: null, launch_prompt: prompt, env, settings,
      permissions: or(rec.permissions, "auto") };
    save(data);
    return { short_id: (rec.id as string).slice(-4), session_id: `fake-${rec.id as string}` };
  },

  async resume(rec) {
    if (process.env.SC_FAKE_RESUME_FAILS) throw new SCError("fake runtime was told to fail the resume");
    const data = load();
    const s = (data.sessions[rec.id as string] ??= {});
    s.alive = true;
    save(data);
  },

  async stop(rec) {
    const data = load();
    const s = (data.sessions[rec.id as string] ??= {});
    s.alive = false;
    save(data);
  },

  async wake(rec, text) {
    if (!(await this.status(rec)).alive) throw new WakeError(`${rec.id as string} is not running`);
    const data = load();
    data.wakes.push([rec.id, text]);
    save(data);
  },

  async statusSessionId(sessionId, rows) {
    const r = rows ?? (await this.listing());
    return statusOf(row(r, sessionId));
  },

  async wakeSessionId(_sessionId, text) {
    const data = load();
    const chef = get(data, "chef_alive", true);
    if (!truthy(chef)) throw new WakeError("chef not running");
    data.wakes.push(["chef", text]);
    save(data);
  },

  attachCommand(rec) {
    const handle = or(rec.handle, {}) as Dict;
    const shown = or(rec.id, handle.short_id);
    return `fake attach ${shown === undefined || shown === null ? "None" : String(shown)}`;
  },

  async startNamed(name, prompt, cwd, _env, permissions) {
    if (!Object.hasOwn(PERMISSIONS, permissions)) {
      throw new SCError(`unknown permission value '${permissions}' (known: ${Object.keys(PERMISSIONS).join(", ")})`);
    }
    const data = load();
    let n = 1;
    while (Object.hasOwn(data.sessions, `fake-chef-${n}`)) n++;
    data.sessions[`fake-chef-${n}`] = { alive: true, busy: false, pid: 1, kind: "background", id: `chef-${n}`, name,
      launch_prompt: prompt, cwd, permissions };
    save(data);
    return `chef-${n}`;
  },

  async resumeSessionId(sessionId) {
    if (process.env.SC_FAKE_RESUME_FAILS) return null;
    const data = load();
    const r = (data.sessions[sessionId] ??= { kind: "background" });
    r.alive = true;
    r.pid = 1;
    if (!Object.hasOwn(r, "id")) r.id = sessionId.slice(0, 8);
    save(data);
    return r.id as string;
  },

  async stopShort(shortId) {
    const data = load();
    for (const r of Object.values(data.sessions)) {
      if (r.id === shortId) {
        r.alive = false;
        delete r.pid;
      }
    }
    save(data);
  },

  async attachExec(shortId) {
    process.stdout.write(`fake attach ${shortId}\n`);
    return 0;
  },

  async skillAvailable(name, cwd) {
    const data = load();
    ((data.skill_checks ??= []) as unknown[]).push([name, cwd ? String(cwd) : null]);
    save(data);
    if ((get<string[]>(data, "unknown_skills", [])).includes(name)) return null;
    return !(get<string[]>(data, "missing_skills", [])).includes(name);
  },

  skillPlaces() {
    return ["the fake runtime's missing_skills"];
  },
};
