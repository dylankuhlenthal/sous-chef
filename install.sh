#!/bin/sh
# Install sous chef. Either pipe it from the web:
#   curl -fsSL https://raw.githubusercontent.com/dylankuhlenthal/sous-chef/main/install.sh | bash
# or clone the core first, read this, and run it from the clone:
#   git clone https://github.com/dylankuhlenthal/sous-chef.git ~/.sous-chef && ~/.sous-chef/install.sh
#
# Piped (not run from inside a core checkout), it clones the core into ~/.sous-chef
# (SOUS_CHEF_DIR, from SOUS_CHEF_REPO, branch main) and runs that clone's own install.sh,
# so the rest of the install is the code just cloned. A folder there that is already a
# sous chef core is used as it is, not updated; any other folder there is refused.
#
# From a core checkout it checks the tools sous chef needs (Node 22 or later, npm, git,
# Claude Code), brings the install up to date (`npm ci` when the dependencies are missing
# or older than package-lock.json, `npm run build` when the build is missing or stale),
# then runs `sc setup`, which asks where your data folder goes and connects it. Flags are
# passed on: see `sc setup --help`. Its questions are read from the terminal (/dev/tty),
# so they work when this script came in on a pipe; with no terminal, the flags and
# defaults apply. Running it again is safe: what is up to date is left alone.
#
# Everything is inside main, called on the last line, so a shell reading this script from
# a pipe has read all of it before anything runs.
set -eu

is_core() {
  [ -f "$1/install.sh" ] && [ -f "$1/bin/sc" ] && [ -f "$1/package.json" ] &&
    grep -q '"name": "sous-chef"' "$1/package.json"
}

# Not run from a core checkout (piped, so $0 is the shell): clone the core, run its install.sh.
bootstrap() {
  repo=${SOUS_CHEF_REPO:-https://github.com/dylankuhlenthal/sous-chef.git}
  dir=${SOUS_CHEF_DIR:-$HOME/.sous-chef}
  command -v git >/dev/null 2>&1 || { echo "install.sh: git is not on your PATH; sous chef needs it" >&2; exit 1; }
  if is_core "$dir"; then
    echo "using the sous chef core already at $dir (not updated; to update it, see docs/operations/running.md there)"
  elif [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
    echo "install.sh: $dir exists and is not a sous chef core; move it away, or set SOUS_CHEF_DIR to another folder" >&2
    exit 1
  else
    echo "cloning $repo into $dir"
    git clone -q --branch main "$repo" "$dir" </dev/null
  fi
  exec "$dir/install.sh" "$@"
}

main() {
  case "$0" in
    */install.sh | install.sh) here=$(cd "$(dirname "$0")" && pwd) ;;
    *) here="" ;;
  esac
  if [ -z "$here" ] || ! is_core "$here"; then
    bootstrap "$@"
  fi
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
      (cd "$here" && npm ci </dev/null)
    fi
    if ! node "$here/bin/sc" --help >/dev/null 2>&1; then
      (cd "$here" && npm run build </dev/null)
    fi
  fi
  # Piped from the web, stdin is the script, not the person: ask through the terminal instead.
  if [ ! -t 0 ] && (exec </dev/tty) 2>/dev/null; then
    exec node "$here/bin/sc" setup "$@" </dev/tty
  fi
  exec node "$here/bin/sc" setup "$@"
}

main "$@"
