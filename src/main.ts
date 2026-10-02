// The entry point bin/sc and bin/souschef load once their checks pass (bin/sc says which).
// Every module is imported statically here, at start: a rebuild deletes dist/ while long
// commands and the watcher run, so nothing may be loaded later (docs/decisions/0023).

import * as cli from "./cli.js";
import { ignoreClosedOutput } from "./io.js";
import * as souschef from "./souschef.js";

/** Run `sc` or `souschef` with these arguments; resolves to the exit code. */
export async function main(program: "sc" | "souschef", argv: string[]): Promise<number> {
  ignoreClosedOutput();
  return program === "souschef" ? souschef.main(argv) : cli.main(argv);
}
