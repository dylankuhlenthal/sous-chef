// Claude Code background sessions (`claude --bg`): the runtime name records store.
//
// In this phase only what needs no Claude Code is here: the attach command (formatting a
// recorded short id) and the skill lookup (claude-skills.ts), which `sc spawn` and
// `sc kinds` use. Everything that starts, reads or reaches a session refuses until the
// runtime is built on Porch (TRV-1155). Callers already treat a runtime that cannot be
// asked as they do today: a registered sous chef counts as running (chef.liveIncumbent),
// as not alive (chef.status), and wakeChef returns false.

import { Dict, or } from "../py.js";
import { SCError } from "../util.js";
import { skillAvailable, skillPlaces } from "./claude-skills.js";
import { Runtime } from "./types.js";

export const NOT_BUILT = "the Claude runtime is not built yet (TRV-1155); only the fake runtime runs";

function refuse(): never {
  throw new SCError(NOT_BUILT);
}

export const claudeBg: Runtime = {
  NAME: "claude-bg",
  launch: async () => refuse(),
  resume: async () => refuse(),
  stop: async () => refuse(),
  status: async () => refuse(),
  listing: async () => refuse(),
  wake: async () => refuse(),
  wakeSessionId: async () => refuse(),
  statusSessionId: async () => refuse(),
  startNamed: async () => refuse(),
  resumeSessionId: async () => refuse(),
  stopShort: async () => refuse(),
  attachExec: async () => refuse(),

  attachCommand(rec: Dict) {
    const short = or((or(rec.handle, {}) as Dict).short_id, "<unknown>");
    return `claude attach ${String(short)}`;
  },

  async skillAvailable(name, cwd) {
    return skillAvailable(name, cwd);
  },

  skillPlaces(cwd) {
    return skillPlaces(cwd);
  },
};
