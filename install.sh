#!/bin/sh
# Install sous chef: clone the core first, then run this from it.
#   git clone <core repo> ~/.sous-chef && ~/.sous-chef/install.sh
# It checks the tools sous chef needs (Node 22 or later, npm, git, Claude Code), brings the
# install up to date (`npm ci` when the dependencies are missing or older than
# package-lock.json, `npm run build` when the build is missing or stale), then runs
# `sc setup`, which asks where your data folder goes and connects it. Flags are passed on:
# see `sc setup --help`. Running it again is safe: what is up to date is left alone.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
missing=""
for tool in node npm git claude; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
if [ -n "$missing" ]; then
  echo "install.sh: not found on your PATH:$missing" >&2
  echo "Sous chef needs Node 22 or later (node and npm), git, and Claude Code (claude)." >&2
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  echo "install.sh: sous chef needs Node 22 or later; $(command -v node) is $(node --version)" >&2
  exit 1
fi
echo "using Node $(node --version) at $(node -p process.execPath); hooks and the watcher run this Node"
# bin/sc checks the dependencies and the build before it runs anything, and says what is out of date.
# The dependencies are reinstalled when they are missing or out of date. bin/sc names out-of-date
# dependencies only once a build has finished, so after an interrupted build (no dist/ or no
# stamp) a package-lock.json newer than the installed one counts as out of date too.
if ! node "$here/bin/sc" --help >/dev/null 2>&1; then
  why=$(node "$here/bin/sc" --help 2>&1 >/dev/null || true)
  if [ ! -e "$here/node_modules/.package-lock.json" ] ||
     echo "$why" | grep -q "node_modules are older than package-lock.json" ||
     { echo "$why" | grep -q "has no build" &&
       [ "$here/package-lock.json" -nt "$here/node_modules/.package-lock.json" ]; }; then
    if [ -L "$here/node_modules" ]; then
      echo "install.sh: $here/node_modules is a link to another install, so it is not reinstalled from here" >&2
      exit 1
    fi
    (cd "$here" && npm ci)
  fi
  if ! node "$here/bin/sc" --help >/dev/null 2>&1; then
    (cd "$here" && npm run build)
  fi
fi
exec node "$here/bin/sc" setup "$@"
