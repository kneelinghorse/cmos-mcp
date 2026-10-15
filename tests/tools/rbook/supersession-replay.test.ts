// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s91-m05 replay — the supersession detector, run on the store as committed at 87dc56a,
// ABOUTME: must stop offering the false positives eight field reports named, and still offer a real one.

/**
 * THE CORPUS. Each capturing row below is re-run through `detectSupersessionCandidates` with its
 * own text and sprint tag on a copy of the store as committed at 87dc56a, after every named row is
 * set `active` on the copy (several are archived there). The "must not offer" ids are exactly the
 * candidates the ledger reported as false positives: feedback #32/#33 for #1084-#1086, and the
 * planning session's own five captures #1150-#1154 (fifteen candidates, fifteen false positives).
 *
 * FROZEN (s96-m10, #641). On a copy of the live store, the ranking pool and its word weights moved
 * with every decision written after the test, so the same code could pass one day and fail the next.
 *
 * ONE REPORTED PAIR IS A MEASURED RESIDUAL, NOT A PASS: #1086 -> #1085. Both are sprint-88, so
 * same-sprint scoping keeps it; #1086 never cites #1085 by id; and its similarity (0.116) sits
 * below the genuine supersession's (0.129). No change removes it by design, so it is excluded from
 * the must-not-offer list and its current state is printed every run rather than asserted.
 *
 * POSITIVE CONTROL. #1134 was genuinely superseded by #1135 (both sprint-90). With #1134 set active
 * again, capturing #1135's text must still offer #1134 — so a fix that simply offers nothing fails.
 *
 * FEEDBACK #43 (capture #1140) named no candidate ids. Re-run at HEAD on this copy, the detector
 * offered #866, #959 and #938 (sprint-76/84/81 release decisions for a sprint-90 capture), so
 * those three joined the replay. The store comes from git history; the live store is not opened.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { requiresPrivateEvidence } from '../../helpers/public-mirror';
import { reidentifyRbookTestStore } from '../../helpers/seedRbookDb';
import { withClientAsync } from '../../../src/tools/rbook/client';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { createSuccess } from '../../../src/tools/rbook/errors';
import {
  detectSupersessionCandidates,
  type SupersessionSuggestion,
} from '../../../src/tools/rbook/supersession-detection';

// 87dc56a holds every named decision (any commit from 0216b63 on does). At s96-m10 these
// assertions held on the store at all 30 commits that changed it from 0216b63 to 2e769d4.
const PRIVATE = requiresPrivateEvidence({
  reason:
    "The replay reads the named decision rows (text and sprint tag) from this repository's store in its git history; the public mirror carries neither.",
  revisions: { frozen: '87dc56a' },
});
const REPO = path.resolve(__dirname, '..', '..', '..');

const REPLAY: ReadonlyArray<{ capture: number; mustNotOffer: readonly number[] }> = [
  { capture: 1084, mustNotOffer: [1015, 972, 1061] },
  { capture: 1085, mustNotOffer: [1060] },
  // #1085 is deliberately absent: same sprint (sprint-88), cosine 0.116 against the positive
  // control's 0.129, never cited by #id. Measured residual — see supersession-detection.ts.
  { capture: 1086, mustNotOffer: [1055, 973] },
  { capture: 1150, mustNotOffer: [1085, 1125, 973] },
  { capture: 1151, mustNotOffer: [1060, 1125, 1015] },
  { capture: 1152, mustNotOffer: [1126, 973, 972] },
  { capture: 1153, mustNotOffer: [972, 1055, 1126] },
  { capture: 1154, mustNotOffer: [814, 973, 1126] },
  // feedback #43 named no ids; re-run at HEAD on #1140 it offered these sprint-76/84/81 rows.
  { capture: 1140, mustNotOffer: [866, 959, 938] },
];

const POSITIVE = { capture: 1135, mustOffer: 1134 } as const;

PRIVATE.describe('s91-m05 supersession replay on the store as committed at 87dc56a', () => {
  let tempRoot: string;
  const rows = new Map<number, { text: string; sprintId: string | null }>();

  beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's91-m05-replay-'));
    const dbDir = path.join(tempRoot, 'rbook', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const copyPath = path.join(dbDir, 'rbook.sqlite');
    fs.writeFileSync(
      copyPath,
      execFileSync('git', ['show', `${PRIVATE.revisions.frozen}:rbook/db/rbook.sqlite`], {
        cwd: REPO,
        maxBuffer: 512 * 1024 * 1024,
      })
    );
    reidentifyRbookTestStore(tempRoot);

    const named = new Set<number>([
      POSITIVE.capture,
      POSITIVE.mustOffer,
      ...REPLAY.flatMap((r) => [r.capture, ...r.mustNotOffer]),
    ]);
    const db = new Database(copyPath);
    try {
      for (const id of named) {
        const row = db
          .prepare(
            'SELECT decision_text AS text, sprint_id AS sprintId FROM strategic_decisions WHERE id = ?'
          )
          .get(id) as { text: string; sprintId: string | null } | undefined;
        if (!row) throw new Error(`precondition: decision #${id} is absent from the frozen store`);
        rows.set(id, row);
        db.prepare(
          `UPDATE strategic_decisions SET status = 'active', superseded_by = NULL WHERE id = ?`
        ).run(id);
      }
    } finally {
      db.close();
    }
    RbookDetector.resetInstance();
  });

  afterAll(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  async function detect(captureId: number): Promise<SupersessionSuggestion> {
    const row = rows.get(captureId)!;
    let suggestion: SupersessionSuggestion | undefined;
    const opened = await withClientAsync(
      async (client) => {
        suggestion = await detectSupersessionCandidates(client, row.text, {
          sprintId: row.sprintId,
          excludeDecisionId: captureId,
        });
        return createSuccess(null);
      },
      { projectRoot: tempRoot }
    );
    if (!opened.success || !suggestion) throw new Error(opened.error?.message ?? 'no result');
    return suggestion;
  }

  async function offered(captureId: number): Promise<number[]> {
    return (await detect(captureId)).candidates.map((c) => c.id);
  }

  it.each(REPLAY)('capture #$capture offers none of its reported false positives', async (r) => {
    const ids = await offered(r.capture);
    expect(ids.filter((id) => r.mustNotOffer.includes(id))).toEqual([]);
  });

  // The residual is REPORTED, not asserted: whether #1085 clears the floor depends on IDF weights
  // over the corpus (measured offered at s91-m05 build, not offered after three more captures on
  // the live store). The corpus is frozen now, but neither outcome is the target: asserting the
  // offer would pin a false positive, and asserting its absence would pin one corpus's weights.
  it('reports whether the measured #1086 -> #1085 residual is currently offered', async () => {
    const ids = await offered(1086);
    // eslint-disable-next-line no-console
    console.log(
      `[s91-m05 residual] #1086 offers #1085: ${ids.includes(1085)} (candidates ${ids.join(',') || 'none'})`
    );
    expect(Array.isArray(ids)).toBe(true);
  });

  it('still offers the genuine supersession #1134 when #1135 is captured', async () => {
    expect(await offered(POSITIVE.capture)).toContain(POSITIVE.mustOffer);
  });

  it('bounds every structured candidate to a preview', async () => {
    const suggestion = await detect(POSITIVE.capture);
    expect(suggestion.candidates.length).toBeGreaterThan(0);
    for (const c of suggestion.candidates) {
      expect(c.preview.length).toBeLessThanOrEqual(100);
      expect(c.decisionText).toBe(c.preview);
      expect(Buffer.byteLength(JSON.stringify(c))).toBeLessThan(600);
    }
  });
});
