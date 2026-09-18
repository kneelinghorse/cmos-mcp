// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s91-m03 gate — no tracked Markdown shows a completion call that sends free text and a
// ABOUTME: sibling decisions/nextSteps array together, the shape a host's marshalling can absorb.

/**
 * WHY. The notes-only rule lived only in this repo's agents.md while the shipped
 * cmos-seed/tiers/build.md — the one seed document the server injects into a tool payload —
 * instructed `notes="...", decisions=[...]` in one call. Stage1 followed it and lost the decisions
 * on five completions.
 *
 * PREDICATE: a `cmos_mission_transition(action="complete" …)` call with both `notes=` and
 * `decisions=` before its closing parenthesis, or a `cmos_session(action="complete" …)` call with
 * `summary=` and `decisions=`.
 * UNIVERSE: every git-tracked `.md` file, derived at run time.
 * NOT LOOKED AT: `cmos/planning/**` and `CHANGELOG.md` (historical records that quote old shapes);
 * prose that describes the pair without writing a call; non-Markdown files; and
 * `cmos_session(action="complete", summary, nextSteps)` — six tracked sites at s91-m03
 * (session-management-guide.md, tiers/general.md, build-session-prompt.md x3, release.md). Those
 * show short summaries, the session-complete guard refuses the loss case either way, and
 * rewriting them is outside this mission; a later sweep starts from this count.
 */

import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');

const COMBINED_COMPLETE_CALLS = [
  /cmos_mission_transition\(\s*action="complete"[^)]*\bnotes=[^)]*\bdecisions=/g,
  /cmos_mission_transition\(\s*action="complete"[^)]*\bdecisions=[^)]*\bnotes=/g,
  /cmos_session\(\s*action="complete"[^)]*\bsummary=[^)]*\bdecisions=/g,
];

function offendingCalls(text: string): string[] {
  return COMBINED_COMPLETE_CALLS.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((m) => m[0].replace(/\s+/g, ' ').slice(0, 120))
  );
}

function trackedMarkdown(): string[] {
  return execFileSync('git', ['ls-files', '*.md'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((file) => !file.startsWith('cmos/planning/') && file !== 'CHANGELOG.md');
}

describe('s91-m03 notes-only completion in shipped prose', () => {
  it('fires on the shape build.md shipped in 3.0.0 (the gate is not vacuous)', () => {
    const old =
      'Call `cmos_mission_transition(action="complete", missionId="...", notes="...", decisions=[...])`.';
    expect(offendingCalls(old)).toHaveLength(1);
    expect(
      offendingCalls('cmos_session(action="complete", summary="x", decisions=["y"])')
    ).toHaveLength(1);
  });

  it('finds no tracked Markdown showing notes and decisions in one completion call', () => {
    const files = trackedMarkdown();
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.flatMap((file) => {
      const full = path.join(REPO_ROOT, file);
      if (!fs.existsSync(full)) return [];
      return offendingCalls(fs.readFileSync(full, 'utf8')).map((call) => `${file}: ${call}`);
    });
    expect(offenders).toEqual([]);
  });
});
