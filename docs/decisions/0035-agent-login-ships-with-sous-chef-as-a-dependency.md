# 0035: agent-login ships with sous chef as a dependency

**Date:** 2026-11-10
**Status:** Accepted

## Context
agent-login lets an agent sign in to a website without seeing the password. The owner wanted everyone who installs sous chef, on their own machine, to get it and its skill, so sous chef and its sessions can sign in to websites. agent-login is its own public repo and is also used outside sous chef. It ran only from a clone, as TypeScript through Node's type stripping, which Node refuses inside `node_modules`, and it asked for Node 24 where sous chef needs only Node 22.

## Decision
agent-login gained a build step (`prepare` compiles it into `dist/`, and its launcher runs that build when the package has no source), and asks only for Node 22. Sous chef depends on it from its GitHub repo at a fixed commit, recorded in `package-lock.json`, the way Porch first arrived (decision 0025). `sc setup` links its command next to `sc` and its skill into Claude Code's user skills folder, and says whether 1Password is set up for it, without asking for anything. Briefs and kinds do not mention it; the skill's own description tells sessions when to use it.

Set aside: copying agent-login's code into the core (a second copy to keep in step with the repo people use outside sous chef), and having `install.sh` clone it into a folder of its own (update logic of its own, next to the one `npm ci` already gives). Passing the skill only to sessions sous chef launches would have left out sous chef itself and plain `claude` sessions.

## Consequences
npm 12 refuses git dependencies by default, and npm 11.19 and later skip a dependency's install scripts, so the core's `.npmrc` allows git dependencies named in `package.json` and `package.json` allows agent-login's build script, for its pinned commit only. Every install carries Playwright (about 14 MB, no browser download) whether or not its owner uses agent-login. Installing sous chef reads agent-login's public GitHub repo and builds it, which needs only `git` and npm. A newer agent-login needs a deliberate pin change; publishing it to npm would turn the pin into a plain version, as decision 0033 (Porch comes from npm) did for Porch. How it works: `docs/domains/agent-login.md`.
