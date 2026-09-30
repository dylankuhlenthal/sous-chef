#!/bin/sh
# Install sous chef: clone the core first, then run this from it.
#   git clone <core repo> ~/.sous-chef && ~/.sous-chef/install.sh
# It checks the tools sous chef needs, then runs `sc setup`, which asks where your
# data folder goes and connects it. Flags are passed on: see `sc setup --help`.
# Running it again is safe.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
missing=""
for tool in python3 git claude; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
if [ -n "$missing" ]; then
  echo "install.sh: not found on your PATH:$missing" >&2
  echo "Sous chef needs python3 3.9 or later, git, and Claude Code (claude)." >&2
  exit 1
fi
exec python3 "$here/bin/sc" setup "$@"
