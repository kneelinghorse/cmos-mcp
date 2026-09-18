// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s91-m05 — a decision capture's receipt stays small when the capture and its candidates
// ABOUTME: are large: the rendered answer is bounded, and each structured candidate is a preview.

/**
 * MEASURED BEFORE THE FIX (plan §s91-m05): content up to 9,137 bytes was echoed in full on the
 * rendered `**Content**:` line, and each structured supersession candidate carried the full text of
 * a 3.5-8.4 KB decision — 25-30 KB per capture. This drives the real router and formatter.
 */

import { afterEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';

import { createSeededCmosProject, type SeededCmosProject } from '../../helpers/seedCmosDb';
import { cmosSession, formatSessionForLLM } from '../../../src/tools/cmos/cmos-session';

const projects: SeededCmosProject[] = [];

afterEach(async () => {
  while (projects.length > 0) await projects.pop()!.cleanup();
});

function padTo(prefix: string, bytes: number): string {
  let text = prefix;
  while (text.length < bytes) text += ' supporting detail for the rollout';
  return text.slice(0, bytes);
}

describe('s91-m05 capture receipt size', () => {
  it('renders under 2 KB and keeps each structured candidate under 600 bytes', async () => {
    const project = await createSeededCmosProject({}, 'cmos-s91-m05-receipt-');
    projects.push(project);
    const db = new Database(project.dbPath);
    try {
      db.exec(`INSERT INTO sprints (id, title, status) VALUES ('sprint-x', 'X', 'Active')`);
      const insert = db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status, project_id,
           stable_event_id, occurred_at, origin_seq, event_type, schema_version)
         VALUES (?, ?, 'sprint-x', 'active', 'p', ?, ?, ?, 'decision_captured', 1)`
      );
      for (const n of [1, 2, 3]) {
        insert.run(
          padTo(
            `Retire the legacy ingestion queue for the streaming pipeline, variant ${n}.`,
            8_000
          ),
          new Date().toISOString(),
          `S91M05RECEIPTSIZE00000000${n}`,
          Date.now(),
          n
        );
      }
    } finally {
      db.close();
    }

    const started = await cmosSession({
      action: 'start',
      type: 'custom',
      title: 'receipt size',
      projectRoot: project.projectRoot,
    } as never);
    expect(started.success).toBe(true);

    const content = padTo(
      'Retire the legacy ingestion queue now; the streaming pipeline replaces it.',
      9_000
    );
    const result = await cmosSession({
      action: 'capture',
      category: 'decision',
      content,
      projectRoot: project.projectRoot,
    } as never);
    expect(result.success).toBe(true);

    const data = result.data as {
      supersessionCandidates?: Array<{ id: number; preview: string; decisionText: string }>;
    };
    // Non-vacuity: the three large same-sprint rows ARE offered, so their bound is exercised.
    expect(data.supersessionCandidates).toHaveLength(3);
    for (const candidate of data.supersessionCandidates!) {
      expect(Buffer.byteLength(JSON.stringify(candidate))).toBeLessThan(600);
    }

    const rendered = formatSessionForLLM('capture', result as never);
    expect(Buffer.byteLength(rendered)).toBeLessThan(2_048);
    expect(rendered).toContain('(9000 characters stored)');
  });
});
