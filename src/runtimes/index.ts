// The runtimes sous chef knows, by the name records store (docs/patterns/adding-a-runtime.md).

import { SCError } from "../util.js";
import { claudeBg } from "./claude-bg.js";
import { fake } from "./fake.js";
import { Runtime } from "./types.js";

export { DEFAULT_PERMISSIONS, PERMISSIONS, WakeError } from "./types.js";
export type { Activity, Listing, Runtime, Status } from "./types.js";

const RUNTIMES: Record<string, Runtime> = { [claudeBg.NAME]: claudeBg, [fake.NAME]: fake };
export const DEFAULT = claudeBg.NAME;

export function get(name: string): Runtime {
  if (!Object.hasOwn(RUNTIMES, name)) {
    throw new SCError(`unknown runtime '${name}' (known: ${Object.keys(RUNTIMES).sort().join(", ")})`);
  }
  return RUNTIMES[name]!;
}
