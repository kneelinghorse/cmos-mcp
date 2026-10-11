#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# ABOUTME: Finds Node when the desktop app starts without an interactive shell's PATH.
# ABOUTME: Executes the adjacent plugin launcher with unchanged arguments and a Node 20 minimum.
set -eu

supports_node() {
  [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1
}

cmos_node=$(command -v node 2>/dev/null || true)
if ! supports_node "$cmos_node"; then
  cmos_node=''
  if [ -n "${SHELL:-}" ] && [ -x "$SHELL" ]; then
    cmos_node=$("$SHELL" -lc 'command -v node' 2>/dev/null || true)
  fi
fi
if ! supports_node "$cmos_node"; then
  cmos_node=''
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if supports_node "$candidate"; then
      cmos_node=$candidate
      break
    fi
  done
fi
if ! supports_node "$cmos_node"; then
  echo 'CMOS requires Node 20 or newer. Install Node, then start a new session.' >&2
  exit 1
fi
cmos_directory=$(CDPATH= cd -- "${0%/*}" && pwd)
exec "$cmos_node" "$cmos_directory/run.mjs" "$@"
