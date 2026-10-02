// Reading stdin and printing, the way the Python sc did it.
//
// Writing to a pipe is asynchronous in Node, so nothing here ever exits the process
// right after printing: commands return their exit code and the process ends by itself.

import { universalNewlines } from "./py.js";

/** Everything on stdin, read to its end (sys.stdin.read(): text mode, so universal newlines). */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return universalNewlines(Buffer.concat(chunks).toString("utf8"));
}

/** Whether stdin is a terminal (sys.stdin.isatty()). */
export function stdinIsTty(): boolean {
  return Boolean(process.stdin.isTTY);
}

/**
 * Stay quiet when whoever reads sc's output stops reading early (`sc status <id> | head`).
 * Writing to a closed pipe fails with EPIPE, which Node reports as an 'error' event on
 * process.stdout or process.stderr, and an unhandled one prints a stack trace and exits 1.
 * The Python sc printed nothing and exited 0 in that case, since output that fits in the
 * pipe was written before the reader left. So the error is ignored, the rest of the output
 * goes nowhere, and the command finishes and exits as it would have. Any other error on
 * these streams is thrown as before.
 */
export function ignoreClosedOutput(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EPIPE" || e.code === "ERR_STREAM_DESTROYED") return;
      throw e;
    });
  }
}

/** print(): the text and a newline, on stdout. */
export function print(text = ""): void {
  process.stdout.write(text + "\n");
}

/** print(..., file=sys.stderr). */
export function printErr(text = ""): void {
  process.stderr.write(text + "\n");
}
