// Running other programs (git, the watcher's load check). One helper, like Python's
// subprocess.run(capture_output=True, text=True): it waits without blocking the event
// loop, never throws for a non-zero exit, and kills the program at its timeout.

import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Set when the program ran past its timeout and was killed (code is then 124). */
  timedOut?: boolean;
  /** Set when the program could not be started (code is then 127). */
  error?: Error;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Seconds. */
  timeout?: number;
  /** Text for stdin; without it stdin is /dev/null. */
  input?: string;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ code: 127, stdout: "", stderr: String((e as Error).message), error: e as Error });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let done = false;
    const timer = opts.timeout === undefined ? null : setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeout * 1000);
    child.stdout?.on("data", (b: Buffer) => out.push(b));
    child.stderr?.on("data", (b: Buffer) => err.push(b));
    if (opts.input !== undefined && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(opts.input);
    }
    const finish = (r: RunResult) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    child.on("error", (e) => finish({ code: 127, stdout: "", stderr: e.message, error: e }));
    child.on("close", (code, signal) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (timedOut) finish({ code: 124, stdout, stderr, timedOut: true });
      else finish({ code: code ?? (signal ? 128 : 1), stdout, stderr });
    });
  });
}
