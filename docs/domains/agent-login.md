# agent-login

[agent-login](https://github.com/dylankuhlenthal/agent-login) lets a session sign in to a website as an agent account without seeing the password. It reads the login from 1Password with a service account token, signs in with its own headless Chrome, and hands back a signed-in Chrome profile. Its README explains the tool, its security shortcuts and how to set up 1Password. This doc covers how it ships with sous chef.

Every sous chef install has agent-login and its skill. Using it to sign in also needs each person's own 1Password setup, which is optional: sous chef works the same without it.

## How it gets onto a machine

agent-login is a dependency in `package.json`, taken from its GitHub repo at one fixed commit, which `package-lock.json` records. `npm ci` installs it into `node_modules/agent-login` with the other dependencies. npm runs agent-login's `prepare` script as it installs it, which compiles its TypeScript into `dist/`, so the installed package runs as plain JavaScript on Node 22. (Node does not strip TypeScript types inside `node_modules`, so agent-login's source could not run from there.) Its dependencies come with it: Playwright, which drives Chrome and downloads no browser of its own, and `tldts`.

Newer npm versions refuse both steps unless the project allows them, so the core allows exactly this one dependency:

- `.npmrc` sets `allow-git=root`: npm 12 fetches no git dependency unless allowed, and `root` allows only the ones `package.json` names, not any a dependency brings in.
- `allowScripts` in `package.json` lets agent-login's `prepare` run, keyed to the pinned commit. npm 11.19 and later skip a dependency's install scripts without it (the build is then missing), and `npm install-scripts approve agent-login` writes the entry.

npm 10, which comes with Node 22, ignores both and installs it as before. `npm ci` was checked with an empty npm cache on npm 10.9 (Node 22.23), 11.19 and 12.2, with SSH to GitHub turned off: each fetched agent-login over HTTPS and built it. npm does not check a git dependency against an integrity hash (it warns that it skips the check); the commit in the pin is what fixes its content.

A newer agent-login arrives the way a newer Porch does: someone changes the pin in `package.json`, runs `npm install` and `npm install-scripts approve agent-login` (the approval names the pin, so a new pin needs a new one; remove the old entry), and commits both package files. Everyone then gets it through the usual update step after a pull (`docs/operations/running.md`, "The build, and updating after a pull"), whose `npm ci` reinstalls it. Why it ships this way: decision 0035 (agent-login ships with sous chef as a dependency).

## What `sc setup` does with it

After it links `sc` and `souschef`, `sc setup` (`linkAgentLogin` in `src/setup.ts`, with the paths and the status check in `src/agent-login.ts`):

1. Links `agent-login` in the bin folder (`--bin-dir`, default `~/.local/bin`) to `node_modules/agent-login/bin/agent-login`.
2. Links `agent-login` in Claude Code's user skills folder (`<config>/skills`, where `<config>` is `CLAUDE_CONFIG_DIR`, else `~/.claude`) to `node_modules/agent-login/skills/agent-login`. Every Claude Code session reads skills from that folder, so sous chef, its sessions and plain `claude` sessions all get the skill. `sc kinds` and `sc spawn` find it there like any other skill (`src/runtimes/claude-skills.ts`). Claude Code lists a skill whose folder is a link like any other: checked with Claude Code 2.1.322, by asking a session for its skills with the skill linked into its project's `.claude/skills`.
3. Prints one line on whether 1Password is set up for agent-login (`agentLoginStatus`): set up when a vault is chosen and the token file is not empty, found the way agent-login finds them (its `AGENT_LOGIN_*` environment variables, then its config file, then its defaults). It looks only at the token file's size, never its contents. When something is missing, the line says what and points to agent-login's README section on setting up 1Password, then `agent-login setup`, which checks everything, including that the token can read the vault.

Both links follow the same rule as `sc` and `souschef` (`placeLink`): something already in the link's place that is not that link (a person's own agent-login clone, say) is left alone with a note saying how to replace it; a link to something that no longer exists is replaced. If `node_modules/agent-login` is missing, setup says so and names the command that installs it, and carries on.

The link targets are inside `node_modules`, at a path that never changes, so the links keep working across updates. While `npm ci` runs, `node_modules` is deleted and rebuilt, so for that moment the command and the skill are missing.

## How sessions learn about it

Nothing in the brief or the kinds mentions agent-login. Claude Code lists every skill's description to every session, and the skill's description says when to use it (a task that needs signing in to a site set up for agent-login). The skill tells the session the rest, including what it must never do.

## Known limits

- **1Password setup is each person's own.** Sous chef never asks for a token, never writes agent-login's settings and never runs `agent-login setup`. The status line is the only help it gives.
- **Using it needs Google Chrome and the 1Password CLI (`op`).** `install.sh` does not check for either, since most people may never use agent-login; `agent-login setup` does.
- **The skills folder may be someone's own synced repo.** If `~/.claude/skills` is a git repo the person syncs across machines, the new link shows up there as an untracked file. Whether to commit it, ignore it or remove it is theirs to decide; setup does not touch the repo.
- **One fixed version for everyone.** A person who wants a newer agent-login than sous chef pins can keep their own clone on `PATH`; setup leaves their link alone. The skill linked into their skills folder is then still sous chef's copy unless they replace that link too.
