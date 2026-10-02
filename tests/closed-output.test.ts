// The built sc whose reader stops early (`sc status <id> | head -1`): it stays quiet and
// exits as it would have, instead of printing Node's EPIPE stack trace. This uses more output
// than a pipe holds, where it differs from the Python sc on purpose (Python printed a
// BrokenPipeError traceback and exited 1); for output that fits, Python was quiet with exit 0
// too (src/io.ts, ignoreClosedOutput, says why).
// Runs this checkout's bin/sc against a temporary data folder (SC_TEST_HOME) and the fake
// runtime, so nothing real is touched. Needs a build: `npm run build` first (npm test does).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

const SC = path.resolve(import.meta.dirname, "..", "bin", "sc");
let tmp: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  if (!fs.existsSync(path.resolve(import.meta.dirname, "..", "dist", ".build-stamp"))) {
    throw new Error("no build: run npm run build first");
  }
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "closed-output-")));
  fs.mkdirSync(path.join(tmp, "home"));
  fs.mkdirSync(path.join(tmp, "work"));
  env = { ...process.env, SC_TEST_HOME: path.join(tmp, "home"), SC_CHEF_RUNTIME: "fake", SC_IDENTITY_WAIT: "0" };
  delete env.CLAUDE_CODE_SESSION_ID;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function sc(args: string[], input?: string) {
  const r = spawnSync(SC, args, { env, input, encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) throw new Error(`sc ${args[0]} failed: ${r.stderr}`);
  return r.stdout;
}

/** Run sc with its stdout read up to the first line and then closed, as `| head -1` does. */
function firstLineThenClose(args: string[], extraEnv: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; line: string; stderr: string }>((resolve, reject) => {
    const child = spawn(SC, args, { env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("sc did not exit within 20 seconds"));
    }, 20000);
    child.stdout.on("data", (b: Buffer) => {
      out += String(b);
      if (out.includes("\n")) child.stdout.destroy();
    });
    child.stderr.on("data", (b: Buffer) => (stderr += String(b)));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, line: out.split("\n")[0]!, stderr });
    });
  });
}

it("stays quiet and exits 0 when its output pipe is closed after the first line", async () => {
  sc(["owner", "set", "--name", "Alex", "--branch-prefix", "alex/"]);
  sc(["spawn", "--kind", "general", "--title", "t", "--cwd", path.join(tmp, "work"), "--runtime", "fake"], "a task");
  const id = fs.readdirSync(path.join(tmp, "home", "state", "sessions"))[0]!;
  // Far more output than a pipe holds, so sc is still writing when the reader leaves. Four
  // messages, because Linux refuses a single command-line argument over 128 KiB.
  for (let i = 0; i < 4; i++) sc(["send", id, "x".repeat(100_000)]);
  const r = await firstLineThenClose(["inbox"], { CLAUDE_CODE_SESSION_ID: `fake-${id}` });
  expect(r.line).toMatch(/^--- message 1 from sous chef/);
  expect(r.stderr).toBe("");
  expect(r.code).toBe(0);
});
