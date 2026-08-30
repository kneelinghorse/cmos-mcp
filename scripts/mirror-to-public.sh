#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# ABOUTME: Append-only mirror of this PRIVATE tree's committed source (minus PRIVATE_PATHS and
# ABOUTME: nested private-source exclusions) to github.com/kneelinghorse/cmos-mcp, with a leak-guard.
#
# Strategy (s73 design §3, decisions #812/#819): this repo stays private and is the sole npm-publish
# source; the public repo is a CODE mirror of everything except PRIVATE_PATHS and DOCS_EXCLUDES.
# APPEND-ONLY — it never force-pushes and never rewrites history. `package.json` is already the
# canonical public form (set by m04), so this script COPIES it; it does not rewrite name/version.
#
# Usage:
#   DRY_RUN=1 scripts/mirror-to-public.sh v1.1.0      # stage + leak-check + commit, NO push (verify first)
#   scripts/mirror-to-public.sh v1.1.0                # real mirror: push main + the vX.Y.Z tag
#
# Env overrides:
#   PUBLIC_REMOTE   default git@github.com:kneelinghorse/cmos-mcp.git (point at a local --bare repo to test)
#   PUBLIC_BRANCH   default main
#   DRY_RUN=1       stage, leak-check, commit locally, print the staged tree, then stop before push
set -euo pipefail

PUBLIC_REMOTE="${PUBLIC_REMOTE:-git@github.com:kneelinghorse/cmos-mcp.git}"
PUBLIC_BRANCH="${PUBLIC_BRANCH:-main}"

# Top-level paths that must NEVER reach the public repo. The leak-assert below is load-bearing.
PRIVATE_PATHS=( cmos analysis artifacts tmp SESSIONS.jsonl agents.md CLAUDE.md ecosystem.config.js )

# Nested private-source exclusions under otherwise-public trees: the private npm-publish workflow,
# sprint planning, an internal strategy survey, and the private dashboard's PG-mirror schema (moat).
# s77-m09 purged the stale pre-Great-Deletion docs (mission-protocol/domain-pack/quality/versioning/
# extension/intelligence guides, the discovery/ snapshots, and the whitepaper); s80-m08 also
# deleted docs/specs/project-registry-system.md — it described the JSON ProjectRegistry that 2.1.0
# removed. The only genuine public reference left under docs/ is getting-started.md (the
# authoritative per-action tool reference is the generated top-level TOOL_REFERENCE.md).
DOCS_EXCLUDES=(
  .github/workflows/publish.yml
  docs/specs/sprint-15-revised-missions.md
  docs/specs/phase2-pg-mirror-schema.md
  docs/survey-2026-03-29.md
)

VERSION="${1:?usage: mirror-to-public.sh vX.Y.Z}"
[[ "$VERSION" == v* ]] || { echo "ERROR: version must look like vX.Y.Z (got '$VERSION')"; exit 1; }
SEMVER="${VERSION#v}"

REPO_ROOT="$(git rev-parse --show-toplevel)"; cd "$REPO_ROOT"
[[ -z "$(git status --porcelain)" ]] || { echo "ERROR: working tree is dirty — commit the release first (the mirror ships git archive HEAD)"; exit 1; }
PKG_VERSION="$(node -p "require('./package.json').version")"
[[ "$SEMVER" == "$PKG_VERSION" ]] || { echo "ERROR: tag $VERSION != package.json version $PKG_VERSION"; exit 1; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
PUB="$WORK/public"
STAGE="$WORK/stage"

echo "→ cloning public ($PUBLIC_BRANCH) from $PUBLIC_REMOTE"
git clone --quiet --branch "$PUBLIC_BRANCH" --single-branch "$PUBLIC_REMOTE" "$PUB"

echo "→ materializing this tree's committed files (git archive HEAD)"
mkdir -p "$STAGE"
git archive --format=tar HEAD | tar -x -C "$STAGE"

# Build the rsync exclude list: top-level private paths + nested private-source exclusions. Anchored ('/x')
# so e.g. --exclude=/cmos matches only the top-level dir. /.git is excluded AND (via plain --delete,
# which protects excludes) preserved in the destination — do NOT use --delete-excluded here (it would
# delete the destination .git).
RSYNC_EXCLUDES=( "--exclude=/.git" )
for p in "${PRIVATE_PATHS[@]}";  do RSYNC_EXCLUDES+=( "--exclude=/$p" ); done
for d in "${DOCS_EXCLUDES[@]}";  do RSYNC_EXCLUDES+=( "--exclude=/$d" ); done

echo "→ rsync staged source into the public clone (minus private paths + nested exclusions)"
rsync -a --delete "${RSYNC_EXCLUDES[@]}" "$STAGE"/ "$PUB"/

# Belt-and-suspenders: explicitly remove any excluded path that PRE-EXISTED in the public clone.
# --exclude protects such files from rsync --delete, so without this a nested exclusion already committed
# to public would silently persist. Removing them here records the deletion in the forward commit
# (append-only — a normal commit, never a history rewrite).
for p in "${PRIVATE_PATHS[@]}" "${DOCS_EXCLUDES[@]}"; do rm -rf "${PUB:?}/$p"; done
# Never ship a real .env (only .env.template). The protection is .gitignore: an untracked/gitignored
# .env is simply absent from `git archive HEAD`. As defense-in-depth against accidental force-tracking
# (`git add -f .env`), explicitly remove any real .env variant here too (the leak-assert below re-checks).
find "$PUB" -path "$PUB/.git" -prune -o -name '.env' -print -o \( -name '.env.*' ! -name '.env.template' \) -print 2>/dev/null \
  | while IFS= read -r f; do rm -f "$f"; done

# ── Hard leak-assert — abort if any private path, nested exclusion, DB, or .env survived ──────
LEAK=0
for p in "${PRIVATE_PATHS[@]}"; do [[ -e "$PUB/$p" ]] && { echo "LEAK: private path $p"; LEAK=1; }; done
for d in "${DOCS_EXCLUDES[@]}";  do [[ -e "$PUB/$d" ]] && { echo "LEAK: nested exclusion $d"; LEAK=1; }; done
if find "$PUB" -path "$PUB/.git" -prune -o \( -name '*.sqlite*' -o -name '*.db*' \) -print | grep -q .; then echo "LEAK: a database file (*.sqlite/*.db — the tree carries cmos/db/cmos.sqlite AND cmos/db/cmos.db)"; LEAK=1; fi
if find "$PUB" -path "$PUB/.git" -prune -o \( -name '.env' -o \( -name '.env.*' ! -name '.env.template' \) \) -print | grep -q .; then echo "LEAK: a real .env file"; LEAK=1; fi
[[ "$LEAK" -eq 0 ]] || { echo "ABORT: private content present in the staged public tree — refusing to mirror"; exit 1; }
echo "✓ leak-guard passed: no PRIVATE_PATHS, nested exclusions, *.sqlite, or .env in the staged tree"

cd "$PUB"
git add -A
if git diff --cached --quiet; then echo "no changes to mirror — public already matches this HEAD"; exit 0; fi

PRIVATE_SHA="$(cd "$REPO_ROOT" && git rev-parse --short HEAD)"
git commit --quiet -m "release $VERSION

Mirrored from the private @aquex/cmos-mcp source at $PRIVATE_SHA.
Excludes private paths (cmos/, analysis/, artifacts/, …) and nested private-source files."

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo
  echo "── DRY_RUN: staged public tree (top-level) ──────────────────────────────"
  git -C "$PUB" ls-files | sed 's#/.*##' | sort -u
  echo "── total tracked files staged: $(git -C "$PUB" ls-files | wc -l | tr -d ' ') ──"
  echo "── excluded paths confirmed ABSENT (must all say 'absent OK') ──"
  for p in "${PRIVATE_PATHS[@]}" "${DOCS_EXCLUDES[@]}"; do
    [[ -e "$PUB/$p" ]] && echo "  STILL PRESENT ⚠  $p" || echo "  absent OK     $p"
  done
  echo "── DRY_RUN — not pushing. Re-run without DRY_RUN=1 to push main + $VERSION ──"
  exit 0
fi

echo "→ pushing $PUBLIC_BRANCH + tag $VERSION to $PUBLIC_REMOTE"
git push origin "$PUBLIC_BRANCH"
git tag "$VERSION"
git push origin "$VERSION"
echo "✓ mirrored $VERSION to public"
