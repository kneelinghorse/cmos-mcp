// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Natural labels use production exclusions and cannot see future collisions or foreign text.
// ABOUTME: Mission cutoffs and rich-field barriers remain fixed before candidate ranking is measured.

import * as extractor from '../../src/tools/cmos/record-link-extractor';
import { storedTimeMs } from '../../src/tools/cmos/stored-time';

const { buildLabels } = require('../../scripts/build-retrieval-labels');
const { timeMs } = require('../../scripts/retrieval-quality-fixture');

describe('frozen natural-label extraction', () => {
  it('separates primary types while excluding future collisions and foreign query text', () => {
    const now = Date.now();
    const at = (offset: number) => new Date(now + offset).toISOString();
    const d = {
      id: 10,
      decision_text: 'Prior architecture record.',
      created_at: at(-3000),
      project_id: 'local',
    };
    const l = {
      id: 20,
      content: 'Prior learning record.',
      created_at: at(-3000),
      project_id: null,
    };
    const query = {
      id: 30,
      decision_text: 'Follow decision #10 and learning #20.',
      created_at: at(-1000),
      project_id: 'local',
    };
    const corpus = {
      projectId: 'local',
      decisions: [d, query, { ...query, id: 31, project_id: 'foreign' }],
      learnings: [l],
      missions: [
        {
          id: 'm1',
          objective: 'Apply decision #10.',
          success_criteria: '["Retain learning #20."]',
          started_at: at(-500),
          created_at: null,
          project_id: 'local',
        },
      ],
      collisionInventory: {
        strategic_decisions: [d, query],
        learnings: [l],
        constraints: [{ id: 10, created_at: at(1000), project_id: 'local' }],
        next_steps: [],
        agent_feedback: [],
      },
    };
    const labels = buildLabels(corpus, extractor);
    expect(labels.queries.map((row: { id: string }) => row.id)).toEqual([
      'decision:30',
      'mission:m1',
    ]);
    expect(labels.queries[0].positiveIds).toEqual(['d:10', 'l:20']);
    expect(labels.queries[1].cutoff).toBe(now - 500);
    expect(labels.queries[1].full).toBe('Apply decision #10.\nRetain learning #20.');
  });

  it('does not carry a type word across fields to override a bare-id collision', () => {
    const now = Date.now();
    const prior = new Date(now - 1000).toISOString();
    const queryTime = new Date(now).toISOString();
    const corpus = {
      projectId: 'local',
      decisions: [
        { id: 10, decision_text: 'Earlier.', created_at: prior, project_id: 'local' },
        {
          id: 20,
          decision_text: 'decisions',
          context_text: '#10',
          created_at: queryTime,
          project_id: 'local',
        },
      ],
      learnings: [],
      missions: [],
      collisionInventory: {
        strategic_decisions: [{ id: 10, created_at: prior, project_id: 'local' }],
        learnings: [],
        constraints: [{ id: 10, created_at: prior, project_id: 'local' }],
        next_steps: [],
        agent_feedback: [],
      },
    };
    expect(buildLabels(corpus, extractor).queries).toEqual([]);
  });

  it('keeps standalone time parsing in parity with production UTC handling', () => {
    const now = new Date();
    const iso = now.toISOString();
    const values = [
      iso,
      iso.slice(0, -1),
      iso.slice(0, 19).replace('T', ' '),
      iso.slice(0, 10),
      '',
      null,
      'invalid',
    ];
    for (const value of values) expect(timeMs(value)).toBe(storedTimeMs(value));
  });
});
