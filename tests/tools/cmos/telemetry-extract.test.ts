// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Telemetry keeps record namespaces and successful uses distinct from text and incidental IDs.
// ABOUTME: These contracts prevent same-number learnings, failed writes and unrelated rows inflating G1.

import { returnedIds, citedIds, usedIds } from '../../../src/tools/cmos/telemetry-extract';

describe('typed telemetry extraction', () => {
  it('keeps pulled foreign records out of the local typed namespace on every response shape', () => {
    const remote = { id: 7, projectId: 'another-project' };
    expect(returnedIds('cmos_decisions', { action: 'show' }, remote)).toEqual([]);
    expect(
      usedIds('cmos_decisions', { action: 'show', decisionId: 7 }, 'read', {
        success: true,
        data: remote,
      })
    ).toEqual([]);
    expect(
      returnedIds(
        'cmos_context',
        { action: 'search' },
        { localProjectId: 'here', results: [{ ...remote, type: 'decision' }] }
      )
    ).toEqual([]);
    expect(returnedIds('cmos_review', {}, { recentDecisions: [remote] })).toEqual([]);
  });

  it('observes both decision-review namespaces and constraint/learning receipts', () => {
    expect(
      returnedIds(
        'cmos_decisions',
        { action: 'review' },
        { decisions: [{ id: 1 }], learnings: [{ id: 1 }] }
      )
    ).toEqual(['d:1', 'l:1']);
    expect(
      returnedIds('cmos_context', { action: 'constraints' }, { reviewItems: [{ id: 2 }] })
    ).toEqual(['c:2']);
    expect(returnedIds('cmos_learnings', { action: 'reaffirm' }, { learningId: 3 })).toEqual([
      'l:3',
    ]);
  });
  it('counts receipt-confirmed actions, excluding unmatched IDs and review-only actions', () => {
    expect(
      usedIds('cmos_decisions', { action: 'batch_update', decisionIds: [1, 2, 3] }, 'write', {
        success: true,
        data: { updated: 1, notFound: [2], alreadyInStatus: [3], failed: [], lookupFailed: [] },
      })
    ).toEqual(['d:1']);
    expect(
      usedIds(
        'cmos_context',
        { action: 'next_steps', nextStepAction: 'complete', nextStepIds: [1, 2] },
        'write',
        {
          success: true,
          data: { affected: 1, unmatchedIds: [2] },
        }
      )
    ).toEqual(['n:1']);
    expect(
      usedIds(
        'cmos_context',
        { action: 'constraints', constraintAction: 'list', constraintIds: [1] },
        'write',
        {
          success: true,
          data: { affected: 1, items: [{ id: 1 }] },
        }
      )
    ).toEqual([]);
    expect(
      usedIds(
        'cmos_context',
        { action: 'constraints', constraintAction: 'reaffirm', constraintId: 7 },
        'write',
        {
          success: true,
          data: { affected: 1, constraintId: 7 },
        }
      )
    ).toEqual(['c:7']);
  });
  it('types mixed results and ignores unrelated mission, session and feedback IDs', () => {
    expect(
      returnedIds(
        'cmos_context',
        { action: 'search' },
        {
          results: [
            { type: 'decision', id: 7 },
            { type: 'learning', id: 7 },
            { type: 'mission', id: 42 },
          ],
        }
      )
    ).toEqual(['d:7', 'l:7']);
    expect(
      returnedIds(
        'cmos_review',
        {},
        {
          recentDecisions: [{ id: 8 }],
          recentLearnings: [{ id: 8 }],
          workQueue: { current: { top: [{ id: 9 }] } },
          next_actions: [{ id: 10 }],
        }
      )
    ).toEqual(['d:8', 'l:8']);
    expect(returnedIds('cmos_feedback', { action: 'list' }, { items: [{ id: 12 }] })).toEqual([]);
  });

  it('reads citations with explicit namespaces; bare #N means decision only', () => {
    expect(
      citedIds({
        supersedes: [2],
        citesLearningIds: [3],
        content:
          'Use learning #7, constraint #8, next-step #9 and decision #10; #11 follows l:12 and d:13.',
      })
    ).toEqual(['d:2', 'l:3', 'l:7', 'c:8', 'n:9', 'd:10', 'd:11', 'l:12', 'd:13']);
    expect(
      citedIds({ query: '#66', projectRoot: '/private/#77', content: 'No citation.' })
    ).toEqual([]);
  });

  it('counts successful explicit shows and writes, never refusals or list/query mentions', () => {
    expect(
      usedIds('cmos_learnings', { action: 'show', learningId: 7 }, 'read', {
        success: true,
        data: { id: 7 },
      })
    ).toEqual(['l:7']);
    expect(
      usedIds('cmos_decisions', { action: 'record', content: '#7' }, 'write', { success: false })
    ).toEqual([]);
    expect(
      usedIds('cmos_session', { action: 'capture', content: '#7' }, 'write', {
        success: true,
        data: { writeFailures: [{}] },
      })
    ).toEqual([]);
    expect(
      usedIds('cmos_decisions', { action: 'search', query: '#7' }, 'read', { success: true })
    ).toEqual([]);
  });

  it('handles show/list/search/next steps and constrains numeric IDs', () => {
    expect(returnedIds('cmos_decisions', { action: 'show' }, { id: 5 })).toEqual(['d:5']);
    expect(
      returnedIds(
        'cmos_learnings',
        { action: 'list' },
        { learnings: [{ id: 5 }, { id: 'private text' }] }
      )
    ).toEqual(['l:5']);
    expect(returnedIds('cmos_context', { action: 'next_steps' }, { items: [{ id: 5 }] })).toEqual([
      'n:5',
    ]);
    expect(returnedIds('cmos_context', { action: 'constraints' }, { items: [{ id: 5 }] })).toEqual([
      'c:5',
    ]);
    expect(citedIds({ supersedes: [-1, 0, 1.5, 'secret', 4] })).toEqual(['d:4']);
  });
});
