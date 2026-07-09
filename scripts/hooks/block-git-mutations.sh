#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# ABOUTME: Claude Code PreToolUse hook (Sprint 78 m04, FORK-5) for the sanctioned read-only
# ABOUTME: review-agent deployment: reject destructive git commands so a reviewer can't wipe work.
#
# The CMOS_AGENT_ROLE=review server guard (read-only-agent-guard.ts) stops CMOS
# store WRITES; this hook closes the *other* data-loss vector — a review agent
# running `git stash`/`reset`/`checkout`/`clean`/`restore`/`rm`/force-push and
# destroying uncommitted work (the s70-m01 / s74-m01 incident class). Read-only git
# (status/log/diff/show/blame) passes untouched. Adoption into settings.json is
# wired by s78-m07; see SECURITY.md "Sanctioned deployment shape".
#
# PreToolUse contract: the tool call arrives as JSON on stdin. Exit 2 BLOCKS the
# call and feeds stderr back to the agent; exit 0 allows it. Any parse failure or
# non-Bash tool falls through to allow (fail-open here is correct: this hook's job
# is to catch git mutations, not to gate every tool — the server guard is the
# authoritative CMOS-write gate).

set -euo pipefail

# s78-m07: role-gated so this hook is SAFE to wire into any settings.json — it is a
# strict no-op unless the session is the sanctioned read-only review deployment
# (CMOS_AGENT_ROLE=review), the same signal the server-side read-only guard keys on.
# A normal build session (CMOS_AGENT_ROLE unset) passes every git command through.
if [[ "${CMOS_AGENT_ROLE:-}" != "review" ]]; then
  exit 0
fi

payload="$(cat)"

# Tokenize each shell segment and find the real git SUBCOMMAND (skipping global
# options like `-C <path>` / `-c k=v`), rather than naively grepping for a verb
# that might appear in a commit message or a filename.
reason="$(printf '%s' "$payload" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let j;
  try { j = JSON.parse(s); } catch { process.exit(0); }
  if (j.tool_name !== "Bash") process.exit(0);
  const cmd = (j.tool_input && j.tool_input.command) || "";
  const BLOCKED = new Set(["stash", "reset", "checkout", "clean", "restore", "rm"]);
  const segments = cmd.split(/[\n;]|&&|\|\|?/);
  for (const seg of segments) {
    const toks = seg.trim().split(/\s+/).filter(Boolean);
    const gi = toks.indexOf("git");
    if (gi === -1) continue;
    let k = gi + 1;
    while (k < toks.length && toks[k].startsWith("-")) {
      const opt = toks[k++];
      if ((opt === "-C" || opt === "-c") && k < toks.length) k++; // option takes a value
    }
    const sub = toks[k];
    if (sub && BLOCKED.has(sub)) { process.stdout.write("git " + sub); process.exit(0); }
    if (sub === "push" && /(^|\s)(-f|--force|--force-with-lease)(\s|=|$)/.test(seg)) {
      process.stdout.write("git push --force"); process.exit(0);
    }
    if (sub === "branch" && /(^|\s)-D(\s|$)/.test(seg)) {
      process.stdout.write("git branch -D"); process.exit(0);
    }
  }
  process.exit(0);
})' 2>/dev/null || true)"

if [[ -n "${reason:-}" ]]; then
  echo "[block-git-mutations] BLOCKED: '${reason}' is a destructive git command, rejected under the" >&2
  echo "read-only review-agent deployment (CMOS_AGENT_ROLE=review). Read-only git" >&2
  echo "(status/log/diff/show/blame) is allowed; mutating git (stash/reset/checkout/clean/restore/rm/" >&2
  echo "force-push/branch -D) is not. Commit or ask the operator if you truly need this." >&2
  exit 2
fi

exit 0
