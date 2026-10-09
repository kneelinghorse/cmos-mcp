#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# ABOUTME: Stops one explicitly identified CMOS server from this checkout after checking its host.
# ABOUTME: Obtain --pid from this chat's cmos_agent_onboard serverHealth; never infer ownership from siblings.
#
# The host starts the CMOS server once per session, and the process keeps the code it loaded:
# `npm run build` changes dist/ but not the running server. Claude Code starts a stopped stdio
# server again on the next tool call. Codex may share one host across multiple chats, so ancestry
# alone does not identify a chat's server. Require the PID returned by this chat's onboard call,
# then check that it is a server from this checkout under an ancestor of this shell. A hook running
# dist/bin.js is not a server. Reconnection is host-dependent and must be verified after stopping.
set -euo pipefail

if [[ $# -ne 2 || "$1" != "--pid" || ! "$2" =~ ^[1-9][0-9]*$ ]]; then
  echo "Usage: $0 --pid <serverHealth.pid from this chat's cmos_agent_onboard>. Never guess a PID from a shared host." >&2
  exit 1
fi
target="$2"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
entry="$root/dist/index.js"
if [[ ! -f "$entry" ]]; then
  echo "No build at $entry. Run npm run build first." >&2
  exit 1
fi
# The checkout path, escaped for pgrep's extended regex, then either entry with only server words.
escaped="$(printf '%s' "$root" | sed 's/[][\.^$*+?(){}|]/\\&/g')"
server="${escaped}/dist/(index|bin)\.js( (serve|--[a-z-]+)( .*)?)?$"

pid=$$
while [[ "$pid" -gt 1 ]]; do
  servers="$(pgrep -P "$pid" -f "$server" || true)"
  if [[ $'\n'"$servers"$'\n' == *$'\n'"$target"$'\n'* ]]; then
    kill -TERM "$target"
    echo "Stopped CMOS server $target (host $pid). Verify a fresh serverHealth PID and current build before the next CMOS write; reconnection is host-dependent."
    exit 0
  fi
  pid="$(ps -o ppid= -p "$pid" | tr -d ' ')"
done

echo "PID $target is not a CMOS server running $root/dist under this session. Read this chat's cmos_agent_onboard serverHealth.pid again." >&2
exit 1
