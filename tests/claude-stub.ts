// A stand-in `claude` command for tests of the Claude runtime (never a real session).
//
// It is a small Node script put first on PATH. Its state is a JSON file (STUB_CLAUDE_STATE):
//   agents        the rows `claude agents --json` prints
//   launchOutput  what a launch (`claude --settings ... --bg -n ...`) prints
//   launchRow     a row a launch adds to agents (optional)
//   resumable     {sessionId: row} sessions `claude --bg --resume <id>` can bring back
//   resumeAs      {sessionId: row} a resume that starts this copy instead (Claude Code with flags)
//   calls         every call's arguments, appended by the stub
// `claude stop <short>` removes the pid from that short id's row.
import fs from "node:fs";
import path from "node:path";

const SCRIPT = `#!/usr/bin/env node
const fs = require("fs");
const file = process.env.STUB_CLAUDE_STATE;
const st = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
st.calls.push(args);
let out = "";
let code = 0;
if (args[0] === "agents") out = JSON.stringify(st.agents);
else if (args[0] === "stop") { for (const r of st.agents) if (r.id === args[1]) delete r.pid; }
else if (args[0] === "attach") out = "attached " + args[1];
else if (args.includes("--resume")) {
  const sid = args[args.indexOf("--resume") + 1];
  const copy = (st.resumeAs || {})[sid];
  let r = copy || st.agents.find((x) => x.sessionId === sid) || (st.resumable || {})[sid];
  if (!r) { process.stderr.write("No conversation found with session ID: " + sid); code = 1; }
  else {
    if (!st.agents.includes(r) && !st.agents.some((x) => x.sessionId === r.sessionId)) st.agents.push(r);
    r = st.agents.find((x) => x.sessionId === r.sessionId);
    r.pid = r.pid || 4242;
    out = "\\u001b[2mbackgrounded\\u001b[0m · " + r.id + " · " + (r.name || "x");
  }
} else {
  out = st.launchOutput || "";
  if (st.launchRow) st.agents.push(st.launchRow);
}
fs.writeFileSync(file, JSON.stringify(st));
process.stdout.write(out + "\\n");
process.exit(code);
`;

export interface StubState {
  agents: Record<string, unknown>[];
  launchOutput?: string;
  launchRow?: Record<string, unknown>;
  resumable?: Record<string, Record<string, unknown>>;
  resumeAs?: Record<string, Record<string, unknown>>;
  calls: string[][];
}

export interface Stub {
  dir: string;
  read(): StubState;
  write(state: Partial<StubState>): void;
}

/** Put a stub `claude` in `dir` and point STUB_CLAUDE_STATE at its state file (in process.env). */
export function installStub(dir: string): Stub {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "claude"), SCRIPT, { mode: 0o755 });
  const file = path.join(dir, "state.json");
  process.env.STUB_CLAUDE_STATE = file;
  const stub: Stub = {
    dir,
    read: () => JSON.parse(fs.readFileSync(file, "utf8")) as StubState,
    write: (state) => fs.writeFileSync(file, JSON.stringify({ agents: [], calls: [], ...state })),
  };
  stub.write({});
  return stub;
}
