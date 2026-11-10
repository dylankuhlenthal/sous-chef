// agent-login ships with sous chef as a dependency (docs/domains/agent-login.md): `sc setup`
// links its command and its skill, and says whether 1Password looks set up for it. Setting up
// 1Password is each person's own step, so nothing here asks for it or fails setup without it.

import fs from "node:fs";
import path from "node:path";
import { configDir } from "./runtimes/claude-skills.js";
import { expanduser, isDict, isFile, readText } from "./py.js";
import { CODE_ROOT } from "./util.js";

export const AGENT_LOGIN_PACKAGE = path.join(CODE_ROOT, "node_modules", "agent-login");
export const AGENT_LOGIN_SETUP_GUIDE = "https://github.com/dylankuhlenthal/agent-login#setting-up-1password";

/** Where agent-login's command and skill are linked from: inside the installed package. */
export function agentLoginTargets(): { command: string; skill: string } {
  return {
    command: path.join(AGENT_LOGIN_PACKAGE, "bin", "agent-login"),
    skill: path.join(AGENT_LOGIN_PACKAGE, "skills", "agent-login"),
  };
}

export function agentLoginInstalled(): boolean {
  const { command, skill } = agentLoginTargets();
  return isFile(command) && isFile(path.join(skill, "SKILL.md"));
}

/** Claude Code's user skills folder, where every session finds a skill. */
export function userSkillsDir(): string {
  return path.join(configDir(), "skills");
}

function readConfig(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readText(file));
    return isDict(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function setting(env: string | undefined, config: Record<string, unknown>, key: string): string | null {
  if (env) return env;
  const value = config[key];
  return typeof value === "string" && value ? value : null;
}

/**
 * One line on whether 1Password looks set up for agent-login: a vault chosen and a token file that
 * is not empty, found the way agent-login finds them (its environment variables, then its config
 * file, then its defaults). The token file's size is all that is looked at, never its contents.
 * agent-login refuses more than this (for example a token file others can read), so the line
 * never says it works; `agent-login setup` checks the rest.
 */
export function agentLoginStatus(): string {
  const configFile = expanduser(process.env.AGENT_LOGIN_CONFIG || "~/.config/agent-login/config.json");
  const config = isFile(configFile) ? readConfig(configFile) : {};
  if (config === null) {
    return `agent-login: its config file ${configFile} cannot be read; run \`agent-login setup\` to see what is wrong`;
  }
  const vault = setting(process.env.AGENT_LOGIN_VAULT, config, "vault");
  const tokenFile = expanduser(setting(process.env.AGENT_LOGIN_TOKEN_FILE, config, "tokenFile")
    ?? "~/.config/agent-login/op-token");
  const missing: string[] = [];
  if (!vault) missing.push("no vault chosen");
  if (!(isFile(tokenFile) && fs.statSync(tokenFile).size > 0)) missing.push(`the token file ${tokenFile} is missing or empty`);
  if (!missing.length) {
    return "agent-login: a 1Password vault is chosen and the token file is there; " +
      "run `agent-login setup` to check that signing in works";
  }
  return `agent-login: not set up for 1Password (${missing.join(", ")}). It is optional: sessions can sign in ` +
    `to websites with it once you have set it up (${AGENT_LOGIN_SETUP_GUIDE}) and run \`agent-login setup\``;
}
