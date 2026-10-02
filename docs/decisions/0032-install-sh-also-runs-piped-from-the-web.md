# 0032: install.sh also runs piped from the web

**Date:** 2026-10-02
**Status:** Accepted

## Context
When the core and the owner's data were split (decision 0020), installing meant cloning the core first and then running its `install.sh`. A one-line `curl ... | sh` install was set aside then because the core might stay private, and fetching a file from a private repo needs a token. The core is now going public, so that reason no longer holds, and it is withdrawn. A one-line install is the usual way strangers expect to try a tool like this.

## Decision
`install.sh` works both ways. Piped (`curl -fsSL https://raw.githubusercontent.com/dylankuhlenthal/sous-chef/main/install.sh | bash`), it is not running from a core checkout, so it clones the core's `main` into `~/.sous-chef` and runs that clone's own `install.sh`, so the rest of the install is the code just cloned, not the copy that came down the pipe. A folder there that is already a sous chef core is used as it is and not updated; any other non-empty folder is refused. `SOUS_CHEF_REPO` and `SOUS_CHEF_DIR` change where it clones from and to (a fork, or tests).

When the script came in on a pipe, its standard input is the script, not the person, so `sc setup` reads its questions from the terminal (`/dev/tty`). With no terminal (CI, a scheduled job), the flags and defaults apply and nothing waits. The whole script sits in one function called on its last line, so the shell has read all of it before anything runs, and `npm` and `git` get no standard input.

Clone-first stays documented as the way to read the script before running it.

## Consequences
The README's first install route runs code fetched from GitHub's raw file host straight into a shell; anyone who wants to read it first clones instead. The real URL can only be checked once the repo is public and this change is on `main`; before that, the piped form was run from a local web server standing in for it. How it works: "Install" in `docs/operations/running.md`.
