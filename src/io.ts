// Reading stdin and printing, the way the Python sc did it.
//
// Writing to a pipe is asynchronous in Node, so nothing here ever exits the process
// right after printing: commands return their exit code and the process ends by itself.

/** Everything on stdin, read to its end (sys.stdin.read()). */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** Whether stdin is a terminal (sys.stdin.isatty()). */
export function stdinIsTty(): boolean {
  return Boolean(process.stdin.isTTY);
}

/** print(): the text and a newline, on stdout. */
export function print(text = ""): void {
  process.stdout.write(text + "\n");
}

/** print(..., file=sys.stderr). */
export function printErr(text = ""): void {
  process.stderr.write(text + "\n");
}
